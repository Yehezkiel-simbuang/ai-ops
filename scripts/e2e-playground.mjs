// Uji nyata playground: kontainer Docker-in-Docker + sshd berperan sebagai server playground, aplikasi (yang sedang berjalan di Docker
// Compose) memasang susunan lewat SSH, memeriksa kesehatan, lalu mencopotnya. Bukan simulasi: image ditarik dan dijalankan sungguhan.
// Pakai: node scripts/e2e-playground.mjs <password-admin> [url=http://localhost:4317]
import { execFileSync, spawnSync } from 'node:child_process';

const [, , PASSWORD, BASE = 'http://localhost:4317'] = process.argv;
if (!PASSWORD) { console.error('Pakai: node scripts/e2e-playground.mjs <password-admin> [url]'); process.exit(2); }
const NET = 'aiops_default', BOX = 'pgtest-e2e', env = { ...process.env, MSYS_NO_PATHCONV: '1' };
const sh = (...a) => spawnSync('docker', a, { encoding: 'utf8', env });
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'GAGAL'} ${name}${ok ? '' : ` ${extra}`}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-aiops': '1', origin: BASE, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let json = null; try { json = await r.json(); } catch { /* bukan JSON */ }
  return { status: r.status, json };
}
async function until(fn, ms, step = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }

let serverId = 0, deployId = 0;
try {
  console.log('== menyiapkan server playground tiruan (Docker-in-Docker + sshd)');
  sh('rm', '-f', BOX);
  spawnSync('docker', ['compose', 'exec', '-T', 'app', 'ssh-keygen', '-R', BOX, '-f', '/data/ssh/known_hosts'], { env, cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), stdio: 'ignore' });   // nama sama, kunci host baru: hapus catatan lama
  const run = sh('run', '-d', '--privileged', '--name', BOX, '--network', NET, '-e', 'DOCKER_TLS_CERTDIR=', 'docker:27-dind'); if (run.status !== 0) throw new Error('gagal menjalankan dind: ' + run.stderr);
  await sleep(8000);
  const setup = sh('exec', BOX, 'sh', '-c', 'apk update >/dev/null 2>&1; apk add --no-cache --upgrade openssh-server openssh-client bash >/dev/null 2>&1; adduser -D -s /bin/bash aiops; addgroup aiops docker; passwd -u aiops >/dev/null 2>&1; ssh-keygen -A >/dev/null; /usr/sbin/sshd; sleep 1; docker version --format "{{.Server.Version}}"');
  check('server tiruan siap (dockerd + sshd)', setup.status === 0 && /\d+\.\d+/.test(setup.stdout), setup.stderr);

  const login = await api('POST', '/api/login', { username: 'admin', password: PASSWORD }); check('login', login.status === 200, JSON.stringify(login.json));
  const srv = await api('POST', '/api/servers', { name: 'e2e-playground', host: BOX, username: 'aiops', generate_key: true, playground: true, monitor_on: false });
  check('server playground dibuat dengan kunci buatan aplikasi', srv.status === 200 && srv.json.playground === true && /^ssh-ed25519 /.test(srv.json.ssh_pub), JSON.stringify(srv.json).slice(0, 200)); serverId = srv.json.id;
  const inst = sh('exec', BOX, 'sh', '-c', `mkdir -p /home/aiops/.ssh && echo '${srv.json.ssh_pub}' > /home/aiops/.ssh/authorized_keys && chown -R aiops:aiops /home/aiops/.ssh && chmod 700 /home/aiops/.ssh && chmod 600 /home/aiops/.ssh/authorized_keys`); check('kunci publik dipasang', inst.status === 0, inst.stderr);
  const t = await api('POST', `/api/servers/${serverId}/test`); check('uji koneksi SSH ke server playground', t.json?.ok === true, JSON.stringify(t.json));

  const COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n    ports: ["8080:80"]\n    depends_on: [cache]\n    healthcheck:\n      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/"]\n      interval: 3s\n      retries: 10\n  cache:\n    image: redis:7-alpine\n    healthcheck:\n      test: ["CMD", "redis-cli", "ping"]\n      interval: 3s\n      retries: 10\n';
  const bad = await api('POST', '/api/playground', { server_id: serverId, name: 'bahaya', compose: COMPOSE.replace('image: nginx:1.27-alpine', 'image: nginx:1.27-alpine\n    privileged: true'), health_path: '/' });
  check('compose berbahaya (privileged) ditolak', bad.status === 400 && /privileged/.test(bad.json.error), JSON.stringify(bad.json));
  const d = await api('POST', '/api/playground', { server_id: serverId, name: 'web-redis', compose: COMPOSE, health_path: '/' }); check('susunan dibuat sebagai draf', d.status === 200 && d.json.status === 'draft', JSON.stringify(d.json).slice(0, 200)); deployId = d.json.id;

  console.log('== memasang (menarik image sungguhan, bisa beberapa menit)');
  const dep = await api('POST', `/api/playground/${deployId}/deploy`); check('pemasangan dimulai (status deploying)', dep.status === 200 && dep.json.status === 'deploying', JSON.stringify(dep.json).slice(0, 200));
  const done = await until(async () => { const r = (await api('GET', `/api/playground/${deployId}`)).json; return ['running', 'failed'].includes(r.status) ? r : null; }, 360_000);
  check('susunan berjalan', done?.status === 'running', `${done?.status} ${done?.detail}\n${done?.log}`);
  check('target uji terisi', done?.target === `http://${BOX}:8080`, String(done?.target));

  const ps = sh('exec', BOX, 'docker', 'ps', '--format', '{{.Names}} {{.Status}}'); console.log(ps.stdout.trim().split('\n').map((l) => '     ' + l).join('\n'));
  check('dua kontainer benar-benar berjalan di server playground', ps.stdout.split('\n').filter((l) => l.includes('aiops-pg-')).length === 2, ps.stdout);
  const web = spawnSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', `fetch('http://${BOX}:8080/').then(r=>console.log(r.status))`], { encoding: 'utf8', env, cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  check('aplikasi bisa menjangkau target dari jaringan Docker (HTTP 200)', web.stdout.trim() === '200', web.stdout + web.stderr);
  const lg = await api('GET', `/api/playground/${deployId}/logs`); check('log kontainer terbaca', lg.status === 200 && lg.json.text.length > 0);
  const cs = await api('GET', `/api/playground/${deployId}/containers`); check('daftar kontainer dari aplikasi', Array.isArray(cs.json) && cs.json.length === 2, JSON.stringify(cs.json));
  check('susunan yang berjalan tidak bisa dihapus langsung', (await api('DELETE', `/api/playground/${deployId}`)).status === 400);

  console.log('== mencopot');
  const st = await api('POST', `/api/playground/${deployId}/stop`); check('pencopotan dimulai', st.json?.status === 'stopping', JSON.stringify(st.json));
  const stopped = await until(async () => { const r = (await api('GET', `/api/playground/${deployId}`)).json; return ['stopped', 'failed'].includes(r.status) ? r : null; }, 120_000, 2000);
  check('status dicopot', stopped?.status === 'stopped', `${stopped?.status} ${stopped?.detail}`);
  const left = sh('exec', BOX, 'sh', '-c', 'docker ps -a -q | wc -l; docker volume ls -q | wc -l; docker network ls --format "{{.Name}}" | grep -c aiops-pg || true');
  const [c, v, n] = left.stdout.trim().split('\n').map(Number); check('tidak ada kontainer, volume, atau jaringan yang tertinggal', c === 0 && v === 0 && n === 0, left.stdout);
  check('berkas proyek di server dihapus', sh('exec', BOX, 'sh', '-c', 'ls /home/aiops/aiops-playground 2>/dev/null | wc -l').stdout.trim() === '0');
  check('setelah dicopot bisa dihapus', (await api('DELETE', `/api/playground/${deployId}`)).status === 200); deployId = 0;

  console.log('== susunan rakitan: 2 replika + load balancer Nginx + Redis, dengan batas CPU');
  const built = await api('POST', '/api/playground/build', { app: { image: 'nginx:1.27-alpine', port: 80, replicas: 2, limits: { cpus: 0.5, memory: '128m' }, healthPath: '/' }, db: null, redis: {}, lb: 'nginx', publishPort: 8081 });
  check('perakit menghasilkan Compose yang valid', built.status === 200 && built.json.analysis.problems.length === 0 && built.json.analysis.publish[0]?.service === 'lb', JSON.stringify(built.json).slice(0, 300));
  const d2 = await api('POST', '/api/playground', { server_id: serverId, name: 'rakitan', compose: built.json.compose, health_path: '/' }); deployId = d2.json?.id ?? 0;
  await api('POST', `/api/playground/${deployId}/deploy`);
  const done2 = await until(async () => { const r = (await api('GET', `/api/playground/${deployId}`)).json; return ['running', 'failed'].includes(r.status) ? r : null; }, 360_000);
  check('susunan rakitan berjalan (4 layanan: app1, app2, lb, cache)', done2?.status === 'running' && /4 layanan/.test(done2.detail), `${done2?.status} ${done2?.detail}
${done2?.log}`);
  const lim = sh('exec', BOX, 'sh', '-c', "docker inspect --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' aiops-pg-${ID}-app1-1".replace('${ID}', String(deployId)));
  check('batas CPU 0.5 dan memori 128m benar-benar diterapkan', lim.stdout.trim() === '500000000 134217728', lim.stdout + lim.stderr);
  const hits = spawnSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', `Promise.all(Array.from({length:6},()=>fetch('http://${BOX}:8081/').then(r=>r.status))).then(a=>console.log(a.join(',')))`], { encoding: 'utf8', env, cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  check('permintaan lewat load balancer dijawab (200)', hits.stdout.trim() === '200,200,200,200,200,200', hits.stdout + hits.stderr);
  await api('POST', `/api/playground/${deployId}/stop`);
  const gone = await until(async () => { const r = (await api('GET', `/api/playground/${deployId}`)).json; return ['stopped', 'failed'].includes(r.status) ? r : null; }, 120_000, 2000);
  check('susunan rakitan dicopot tanpa sisa', gone?.status === 'stopped' && sh('exec', BOX, 'sh', '-c', 'docker ps -a -q | wc -l').stdout.trim() === '0', gone?.detail);
  await api('DELETE', `/api/playground/${deployId}`); deployId = 0;
} catch (e) { fail++; console.error('GALAT:', e.message); }
finally {
  if (deployId) { await api('POST', `/api/playground/${deployId}/stop`).catch(() => null); await sleep(8000); await api('DELETE', `/api/playground/${deployId}`).catch(() => null); }
  if (serverId) await api('DELETE', `/api/servers/${serverId}`).catch(() => null);
  sh('rm', '-f', '-v', BOX);
  console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(fail ? 1 : 0);
}
void execFileSync;
