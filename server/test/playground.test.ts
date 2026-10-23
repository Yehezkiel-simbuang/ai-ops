import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, targetPort } from '../src/playground/compose.js';
import * as Playground from '../src/playground/service.js';
import * as Servers from '../src/servers.js';
import { harness, login, until, type Harness } from './helpers.js';

const OK = `services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    healthcheck: { test: ["CMD", "true"] }
  db:
    image: postgres:17
    environment: { POSTGRES_PASSWORD: uji }
    volumes: ["dbdata:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD", "true"] }
volumes:
  dbdata: {}
`;

describe('analisis Compose', () => {
  it('compose yang wajar: layanan, port yang dipublikasikan, tanpa masalah', () => {
    const a = analyze(OK);
    expect(a.problems).toEqual([]); expect(a.services.map((s) => s.name)).toEqual(['web', 'db']);
    expect(a.publish).toEqual([{ service: 'web', host: 8080, container: 80 }]); expect(targetPort(a, 0)).toBe(8080); expect(targetPort(a, 9999)).toBe(8080);
  });
  it('bentuk port: dengan alamat, protokol, bentuk panjang, dan port acak', () => {
    const a = analyze('services:\n  a:\n    image: x:1\n    ports: ["127.0.0.1:9000:80/tcp", "3000", {target: 81, published: 9001}]\n    healthcheck: {test: ["CMD","true"]}\n');
    expect(a.publish).toEqual([{ service: 'a', host: 9000, container: 80 }, { service: 'a', host: 9001, container: 81 }]);   // "3000" = port host acak: tidak bisa jadi target
  });
  it('opsi yang menembus isolasi atau menyentuh host diblokir', () => {
    const bad = (extra: string) => analyze(`services:\n  a:\n    image: x:1\n    ports: ["8080:80"]\n${extra}`).problems.join(' | ');
    expect(bad('    privileged: true\n')).toMatch(/privileged/);
    expect(bad('    network_mode: host\n')).toMatch(/network_mode/);
    expect(bad('    pid: host\n')).toMatch(/pid/);
    expect(bad('    cap_add: [NET_ADMIN]\n')).toMatch(/cap_add/);
    expect(bad('    devices: ["/dev/sda:/dev/sda"]\n')).toMatch(/devices/);
    expect(bad('    container_name: tetap\n')).toMatch(/container_name/);
    expect(bad('    env_file: .env\n')).toMatch(/env_file/);
    expect(bad('    security_opt: ["seccomp:unconfined"]\n')).toMatch(/unconfined/);
    expect(bad('    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n')).toMatch(/di luar proyek/);
    expect(bad('    volumes: ["/:/host"]\n')).toMatch(/di luar proyek/);
    expect(bad('    volumes: ["../rahasia:/x"]\n')).toMatch(/di luar proyek/);
    expect(bad('    volumes: [{type: bind, source: /etc, target: /x}]\n')).toMatch(/di luar proyek/);
    expect(analyze('services:\n  a:\n    image: x:1\n    ports: ["22:22"]\n').problems.join()).toMatch(/port 22/);
    expect(analyze('services:\n  a:\n    build: .\n').problems.join()).toMatch(/build/);
    expect(analyze('services:\n  a:\n    ports: ["8080:80"]\n').problems.join()).toMatch(/wajib punya "image"/);
  });
  it('volume bernama dan path relatif diizinkan; peringatan untuk image tanpa versi, tanpa healthcheck, tanpa port', () => {
    expect(analyze('services:\n  a:\n    image: x:1\n    volumes: ["data:/d", "./konf:/k"]\n    ports: ["8080:80"]\n    healthcheck: {test: ["CMD","true"]}\n').problems).toEqual([]);
    const w = analyze('services:\n  a:\n    image: redis\n').warnings.join(' | ');
    expect(w).toMatch(/tanpa versi tetap/); expect(w).toMatch(/tanpa healthcheck/); expect(w).toMatch(/Tidak ada port yang dipublikasikan/);
    expect(analyze('services:\n  a:\n    image: redis:latest\n    ports: ["80:80"]\n').warnings.join()).toMatch(/port 80 di server adalah port istimewa/);
  });
  it('masukan rusak: YAML tidak valid, kosong, tanpa services, terlalu panjang', () => {
    expect(analyze('services: [').problems[0]).toMatch(/YAML tidak valid/); expect(analyze('  ').problems[0]).toMatch(/kosong/);
    expect(analyze('version: "3"').problems[0]).toMatch(/services/); expect(analyze('x'.repeat(70_000)).problems[0]).toMatch(/terlalu panjang/);
  });
});

describe('playground lewat API', () => {
  let h: Harness, pg: number, biasa: number;
  const cmds: string[] = []; let script: (cmd: string) => { exitCode: number; stdout: string; stderr?: string } = () => ({ exitCode: 0, stdout: '' });
  const exec = (async (_s: unknown, cmd: string) => { cmds.push(cmd); const r = script(cmd); return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '', ms: 1, timedOut: false }; }) as never;
  const happy = (cmd: string) => {
    if (/docker compose version/.test(cmd)) return { exitCode: 0, stdout: '2.29.0\n27.0.0\n' };
    if (/ps --format json/.test(cmd)) return { exitCode: 0, stdout: '{"Service":"web","State":"running","Health":"healthy"}\n{"Service":"db","State":"running","Health":"healthy"}\n' };
    if (/wc -l/.test(cmd)) return { exitCode: 0, stdout: 'Container x Removed\n0\n' };
    return { exitCode: 0, stdout: 'ok\n' };
  };
  beforeAll(async () => {
    h = await harness(); await login(h); Servers.setExec(exec); Playground.configure({ pollMs: 5, readyTries: 3, healthTries: 2, httpGet: async () => 200 });
    pg = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'uji-pg', host: '10.1.1.1', username: 'aiops', playground: true })).json.id;
    biasa = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'produksi', host: '10.2.2.2', username: 'aiops' })).json.id;
  });
  afterAll(async () => { Servers.setExec(); await h.close(); });
  const create = (over: Record<string, unknown> = {}) => h.call('POST', '/api/playground', { server_id: pg, name: `susunan-${Math.random().toString(36).slice(2, 7)}`, compose: OK, health_path: '/health', ...over });
  const finish = async (id: number) => until(async () => { const r = (await h.call('GET', `/api/playground/${id}`)).json; return ['running', 'failed', 'stopped'].includes(r.status) ? r : null; });

  it('server ditandai playground; hanya yang ditandai boleh dipasangi, dan compose berbahaya ditolak saat dibuat', async () => {
    const list = (await h.call('GET', '/api/servers')).json; expect(list.find((s: { id: number }) => s.id === pg).playground).toBe(true); expect(list.find((s: { id: number }) => s.id === biasa).playground).toBe(false);
    const r1 = await create({ server_id: biasa }); expect(r1.status).toBe(400); expect(r1.json.error).toMatch(/belum ditandai playground/);
    const r2 = await create({ compose: OK.replace('image: nginx:1.27', 'image: nginx:1.27\n    privileged: true') }); expect(r2.status).toBe(400); expect(r2.json.error).toMatch(/privileged/);
    expect((await create({ name: 'bad/name' })).status).toBe(400); expect((await create({ health_path: 'tanpa-slash' })).status).toBe(400);
  });
  it('pemasangan: urutan perintah benar, berkas compose utuh, status running dengan target uji; compose tersimpan terenkripsi', async () => {
    const c = (await create({ name: 'utama' })).json; expect(c).toMatchObject({ status: 'draft', server_name: 'uji-pg' }); expect(c.analysis.publish).toHaveLength(1);
    const raw = await h.db.one<{ compose_enc: string }>('SELECT compose_enc FROM playground_deploys WHERE id=$1', [c.id]); expect(raw!.compose_enc).not.toContain('nginx'); expect(JSON.stringify(c)).not.toContain('compose_enc');
    cmds.length = 0; script = happy;
    const d = await h.call('POST', `/api/playground/${c.id}/deploy`); expect(d.status).toBe(200); expect(d.json.status).toBe('deploying');
    const done = await finish(c.id);
    expect(done).toMatchObject({ status: 'running', target: 'http://10.1.1.1:8080' }); expect(done.detail).toContain('2 layanan berjalan');
    const seq = ['docker compose version', 'base64 -d', 'up -d --remove-orphans', 'ps --format json'].map((p) => cmds.findIndex((x) => x.includes(p)));
    expect(seq.every((i) => i >= 0)).toBe(true); expect([...seq]).toEqual([...seq].sort((a, b) => a - b));   // urutan: cek docker -> tulis -> up -> ps
    expect(cmds.every((x) => !x.includes('docker compose') || x.includes(`-p aiops-pg-${c.id}`) || x.includes('docker compose version'))).toBe(true);   // semua perintah dibatasi ke proyeknya sendiri
    const write = cmds.find((x) => x.includes('base64 -d'))!, b64 = /printf %s '([A-Za-z0-9+/=]+)'/.exec(write)![1]!;
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(OK);
  });
  it('tidak bisa diubah atau dihapus saat berjalan; pasang ulang diperbolehkan; copot membersihkan dan baru setelah itu boleh dihapus', async () => {
    const c = (await create({ name: 'siklus' })).json; script = happy;
    await h.call('POST', `/api/playground/${c.id}/deploy`); await finish(c.id);
    expect((await h.call('PUT', `/api/playground/${c.id}`, { name: 'baru' })).json.error).toMatch(/Hentikan/); expect((await h.call('DELETE', `/api/playground/${c.id}`)).json.error).toMatch(/Copot susunan dulu/);
    expect((await h.call('POST', `/api/playground/${c.id}/deploy`)).status).toBe(200); await finish(c.id);   // pasang ulang
    cmds.length = 0; const s = await h.call('POST', `/api/playground/${c.id}/stop`); expect(s.json.status).toBe('stopping');
    const stopped = await finish(c.id); expect(stopped.status).toBe('stopped'); expect(stopped.target).toBe('');
    expect(cmds.some((x) => x.includes(`down -v --remove-orphans`) && x.includes(`aiops-pg-${c.id}`))).toBe(true); expect(cmds.some((x) => x.includes('rm -rf'))).toBe(true);
    expect((await h.call('PUT', `/api/playground/${c.id}`, { name: 'diganti' })).json.name).toBe('diganti');
    expect((await h.call('DELETE', `/api/playground/${c.id}`)).status).toBe(200);
  });
  it('kegagalan dijelaskan: Docker tidak ada, kontainer mati (dengan log), health tidak sehat, up gagal', async () => {
    const run = async (name: string, sc: (c: string) => { exitCode: number; stdout: string; stderr?: string }, over: Record<string, unknown> = {}) => {
      const c = (await create({ name, ...over })).json; script = sc; await h.call('POST', `/api/playground/${c.id}/deploy`); return (await finish(c.id))!;
    };
    expect(await run('tanpa-docker', (c) => (/docker compose version/.test(c) ? { exitCode: 127, stdout: '', stderr: 'docker: not found' } : happy(c)))).toMatchObject({ status: 'failed', detail: expect.stringContaining('belum terpasang') });
    const mati = await run('mati', (c) => (/ps --format json/.test(c) ? { exitCode: 0, stdout: '{"Service":"db","State":"exited","Health":""}\n' } : /logs --no-color/.test(c) ? { exitCode: 0, stdout: 'FATAL: password salah\n' } : happy(c)));
    expect(mati.status).toBe('failed'); expect(mati.detail).toContain('db (exited)'); expect(mati.log).toContain('FATAL: password salah');
    Playground.configure({ httpGet: async () => 503 });
    expect(await run('tidak-sehat', happy)).toMatchObject({ status: 'failed', detail: expect.stringContaining('tidak menjawab sehat (status 503)') });
    Playground.configure({ httpGet: async () => 200 });
    expect(await run('up-gagal', (c) => (/up -d/.test(c) ? { exitCode: 1, stdout: 'pull access denied', stderr: '' } : happy(c)))).toMatchObject({ status: 'failed', detail: expect.stringContaining('docker compose up gagal') });
  });
  it('pencopotan yang tidak tuntas ditandai gagal; operasi yang terputus saat aplikasi mulai ulang dipulihkan; audit tercatat', async () => {
    const c = (await create({ name: 'sisa' })).json; script = happy; await h.call('POST', `/api/playground/${c.id}/deploy`); await finish(c.id);
    script = (cmd) => (/wc -l/.test(cmd) ? { exitCode: 0, stdout: '2\n' } : happy(cmd));
    await h.call('POST', `/api/playground/${c.id}/stop`); const r = (await finish(c.id))!; expect(r.status).toBe('failed'); expect(r.detail).toContain('2 kontainer tersisa');
    await h.db.exec("UPDATE playground_deploys SET status='deploying' WHERE id=$1", [c.id]); await Playground.recover();
    expect((await h.call('GET', `/api/playground/${c.id}`)).json).toMatchObject({ status: 'failed', detail: expect.stringContaining('dimulai ulang') });
    const audit = (await h.call('GET', '/api/audit')).json.map((a: { action: string }) => a.action); expect(audit).toEqual(expect.arrayContaining(['playground.buat', 'playground.pasang', 'playground.copot']));
  });
  it('log kontainer, daftar kontainer, dan analisis sebelum menyimpan', async () => {
    const c = (await create({ name: 'lihat' })).json; script = (cmd) => (/logs --no-color --tail 200/.test(cmd) ? { exitCode: 0, stdout: 'web | siap\n' } : happy(cmd));
    expect((await h.call('GET', `/api/playground/${c.id}/logs`)).json.text).toBe('web | siap\n'); expect((await h.call('GET', `/api/playground/${c.id}/containers`)).json.map((x: { Service: string }) => x.Service)).toEqual(['web', 'db']);
    const a = (await h.call('POST', '/api/playground/analyze', { compose: 'services:\n  a:\n    privileged: true\n    image: x:1\n' })).json; expect(a.problems.join()).toMatch(/privileged/);
  });
});
