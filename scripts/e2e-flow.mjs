// Alur penuh: pasang susunan A di server playground tiruan, uji beban (k6 sungguhan), copot, pasang susunan B, uji beban, copot, bandingkan.
// Memakai akun uji sementara (dibuat langsung di database lalu dihapus), jadi akun admin tidak disentuh.
// Syarat: stack berjalan dengan profil loadtest (runner online). Pakai: node scripts/e2e-flow.mjs [url=http://localhost:4317]
import { spawnSync } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://localhost:4317', BOX = 'pgtest-flow', USER = 'e2e-flow', PW = 'e2e-flow-password-2026';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), env = { ...process.env, MSYS_NO_PATHCONV: '1' };
const dc = (...a) => spawnSync('docker', ['compose', ...a], { encoding: 'utf8', env, cwd: root });
const sh = (...a) => spawnSync('docker', a, { encoding: 'utf8', env });
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'OK   ' : 'GAGAL'} ${n}${ok ? '' : ' ' + extra}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-aiops': '1', origin: BASE, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function until(fn, ms, step = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }
const sql = (q) => dc('exec', '-T', 'db', 'psql', '-U', 'aiops', '-d', 'aiops', '-c', q);

let serverId = 0; const tests = []; let deployId = 0;
try {
  const st0 = await (async () => { const r = dc('exec', '-T', 'app', 'node', '-e', 'fetch("http://localhost:4317/healthz").then(r=>console.log(r.status))'); return r.stdout.trim(); })();
  check('aplikasi sehat', st0 === '200', st0);
  // akun uji sementara
  const hash = dc('exec', '-T', 'app', 'node', '--input-type=module', '-e', `import {hashPassword} from '/app/dist/crypto.js'; process.stdout.write(await hashPassword(${JSON.stringify(PW)}))`).stdout.trim();
  sql(`DELETE FROM users WHERE username='${USER}'`); sql(`INSERT INTO users(username,password_hash,created_at,must_change) VALUES('${USER}','${hash.replace(/\$/g, '$')}',${Date.now()},false)`);
  check('login akun uji sementara', (await api('POST', '/api/login', { username: USER, password: PW })).status === 200);
  const ls = await api('GET', '/api/loadtests/status'); check('runner uji beban online', ls.json?.runner?.online === true, JSON.stringify(ls.json));

  sh('rm', '-f', BOX);
  dc('exec', '-T', 'app', 'ssh-keygen', '-R', BOX, '-f', '/data/ssh/known_hosts');
  sh('run', '-d', '--privileged', '--name', BOX, '--network', 'aiops_default', '-e', 'DOCKER_TLS_CERTDIR=', 'docker:27-dind'); await sleep(8000);
  const up = sh('exec', BOX, 'sh', '-c', 'apk update >/dev/null 2>&1; apk add --no-cache --upgrade openssh-server openssh-client bash >/dev/null 2>&1; adduser -D -s /bin/bash aiops; addgroup aiops docker; passwd -u aiops >/dev/null 2>&1; ssh-keygen -A >/dev/null; /usr/sbin/sshd; sleep 1; docker version --format "{{.Server.Version}}"');
  check('server tiruan siap', up.status === 0 && /\d+\.\d+/.test(up.stdout), up.stderr);
  const srv = await api('POST', '/api/servers', { name: 'flow-pg', host: BOX, username: 'aiops', generate_key: true, playground: true, monitor_on: false }); serverId = srv.json.id;
  sh('exec', BOX, 'sh', '-c', `mkdir -p /home/aiops/.ssh && echo '${srv.json.ssh_pub}' > /home/aiops/.ssh/authorized_keys && chown -R aiops:aiops /home/aiops/.ssh && chmod 700 /home/aiops/.ssh && chmod 600 /home/aiops/.ssh/authorized_keys`);
  check('SSH ke server playground', (await api('POST', `/api/servers/${serverId}/test`)).json?.ok === true);

  const specs = [
    { label: 'A: 1 aplikasi (0.1 CPU)', spec: { app: { image: 'nginx:1.27-alpine', port: 80, replicas: 1, limits: { cpus: 0.1, memory: '128m' }, healthPath: '/' }, publishPort: 8081 } },
    { label: 'B: 3 replika + Nginx LB (0.1 CPU tiap replika)', spec: { app: { image: 'nginx:1.27-alpine', port: 80, replicas: 3, limits: { cpus: 0.1, memory: '128m' }, healthPath: '/' }, lb: 'nginx', publishPort: 8081 } }
  ];
  for (const { label, spec } of specs) {
    console.log(`== ${label}`);
    const built = await api('POST', '/api/playground/build', spec); check(`${label[0]}: Compose dirakit dan valid`, built.status === 200 && !built.json.analysis.problems.length, JSON.stringify(built.json).slice(0, 200));
    const d = await api('POST', '/api/playground', { server_id: serverId, name: `susunan-${label[0]}`, compose: built.json.compose, health_path: '/' }); deployId = d.json.id;
    await api('POST', `/api/playground/${deployId}/deploy`);
    const run = await until(async () => { const r = (await api('GET', `/api/playground/${deployId}`)).json; return ['running', 'failed'].includes(r.status) ? r : null; }, 360_000);
    check(`${label[0]}: susunan berjalan`, run?.status === 'running', `${run?.status} ${run?.detail}`);
    if (run?.status !== 'running') break;
    const t = await api('POST', '/api/loadtests', {
      name: `Flow ${label}`, target: run.target, confirmNotProduction: true, playgroundId: deployId, thinkSeconds: 0,
      requests: [{ name: 'beranda', method: 'GET', path: '/', weight: 1 }], stages: [{ vus: 10, seconds: 15 }, { vus: 40, seconds: 15 }, { vus: 100, seconds: 15 }], criteria: { p95Ms: 150, errPct: 1 }
    });
    check(`${label[0]}: uji beban dibuat dengan ringkasan susunan`, t.status === 200 && t.json.setup?.name === `susunan-${label[0]}`, JSON.stringify(t.json).slice(0, 250));
    tests.push(t.json.id);
    check(`${label[0]}: disetujui dan masuk antrean`, (await api('POST', `/api/loadtests/${t.json.id}/run`)).status === 200);
    const done = await until(async () => { const r = (await api('GET', `/api/loadtests/${t.json.id}`)).json; return ['done', 'failed', 'cancelled'].includes(r.status) ? r : null; }, 300_000);
    check(`${label[0]}: uji beban selesai (3 tahap)`, done?.status === 'done' && done.stages.length === 3, `${done?.status} ${done?.error}`);
    for (const s of done?.stages ?? []) console.log(`     ${s.vus} pengguna: ${s.rps.toFixed(0)} req/dtk, p95 ${Math.round(s.p95)} ms, err ${s.errPct.toFixed(1)}%, CPU pembangkit ${Math.round(s.genCpu * 100)}%${s.valid ? '' : ' (tidak murni)'}`);
    console.log(`     kesimpulan: ${done?.analysis.verdict.title}`);
    await api('POST', `/api/playground/${deployId}/stop`);
    const gone = await until(async () => { const r = (await api('GET', `/api/playground/${deployId}`)).json; return ['stopped', 'failed'].includes(r.status) ? r : null; }, 120_000, 2000);
    check(`${label[0]}: susunan dicopot`, gone?.status === 'stopped', gone?.detail);
    await api('DELETE', `/api/playground/${deployId}`); deployId = 0;
  }
  if (tests.length === 2) {
    console.log('== perbandingan');
    const c = await api('GET', `/api/loadtests/compare?ids=${tests.join(',')}`);
    check('perbandingan dua uji dengan ringkasan susunan masing-masing', c.status === 200 && c.json.length === 2 && c.json.every((x) => x.setup?.limits?.length), JSON.stringify(c.json).slice(0, 300));
    for (const x of c.json) console.log(`     ${x.name}: sehat sampai ${x.healthy ? `${x.healthy.vus} pengguna (${x.healthy.rps.toFixed(0)} req/dtk)` : '-'}; lutut ${x.knee ? `${x.knee.vus} pengguna` : 'tidak tercapai'}`);
  }
} catch (e) { fail++; console.error('GALAT:', e.message); }
finally {
  if (deployId) { await api('POST', `/api/playground/${deployId}/stop`); await sleep(8000); await api('DELETE', `/api/playground/${deployId}`); }
  for (const id of tests) await api('DELETE', `/api/loadtests/${id}`);
  if (serverId) await api('DELETE', `/api/servers/${serverId}`);
  sql(`DELETE FROM users WHERE username='${USER}'`); sh('rm', '-f', '-v', BOX);
  dc('exec', '-T', 'app', 'ssh-keygen', '-R', BOX, '-f', '/data/ssh/known_hosts');
  console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
}
