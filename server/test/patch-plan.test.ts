// Rencana patch: disusun dari daftar paket agen, lewat persetujuan, dan dijalankan bertahap. Tidak ada yang berjalan sebelum disetujui.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agents from '../src/agents.js';
import { impactOf } from '../src/patch-plan.js';
import { classify } from '../src/safety.js';
import * as Servers from '../src/servers.js';
import { agentTs, harness, login, until, type Harness } from './helpers.js';

let h: Harness, sid = 0, keyId = '', secret = '';
const sshLog: string[] = [];
const sshExec = (fail: (cmd: string) => number = () => 0) => async (_s: unknown, cmd: string) => { sshLog.push(cmd); return { exitCode: fail(cmd), stdout: 'ok:' + cmd.slice(0, 30), stderr: '', ms: 1, timedOut: false }; };

async function agent(path: string, body: unknown) {
  const raw = JSON.stringify(body), ts = agentTs();
  const r = await h.app.inject({ method: 'POST', url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(secret, ts, 'POST', path, raw) }, payload: raw });
  return { status: r.statusCode, json: r.json() };
}
const pk = (name: string, over: Record<string, unknown> = {}) => ({ name, source: name, old: '1.0-1', new: '1.0-2', sec: false, official: true, ...over });
const facts = (packages: unknown[], over: Record<string, unknown> = {}) => ({ manager: 'apt', updates: packages.length, security: 1, reboot: false, os_id: 'ubuntu', os_version: '24.04', os_name: 'Ubuntu 24.04 LTS', packages, ...over });
const FACTS = () => facts([pk('openssl', { sec: true, old: '3.0.2-1', new: '3.0.2-2' }), pk('nginx', { sec: true }), pk('curl'), pk('docker-ce', { official: false }), pk('linux-image-generic')]);

beforeAll(async () => {
  h = await harness({ PUBLIC_URL: 'https://aiops.contoh.com' }); await login(h);
  sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-patch', host: '10.4.4.4', username: 'ops', use_sudo: true })).json.id;
  const r = await h.call('POST', `/api/servers/${sid}/agent`, {}); keyId = r.json.keyId; secret = r.json.config.secret;
  Servers.setExec(sshExec() as never);
});
afterAll(async () => { await h.close(); });

describe('kebijakan perintah untuk paket', () => {
  it('hanya membaca yang dianggap baca; memasang, menahan, dan merestart tetap harus disetujui', () => {
    for (const c of ['apt-mark showhold', 'apt-get -s upgrade', 'apt-get install -s nginx', 'needrestart -b', 'sudo -n needrestart -b', 'dpkg-query -W nginx', 'apt-cache policy nginx', 'systemctl list-units --failed --no-legend --no-pager']) expect(classify(c).cls, c).toBe('read');
    for (const c of ['apt-get install -y nginx', 'apt-get update', 'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update', 'apt-mark hold nginx', 'needrestart -r a', 'needrestart -b -r a', 'apt-get -y upgrade']) expect(classify(c).cls, c).toBe('change');
    expect(classify('reboot').cls).toBe('blocked');
  });
  it('dampak dari nama paket: kernel perlu reboot, database memutus koneksi, paket biasa tanpa catatan', () => {
    expect(impactOf('linux-image-6.8.0-45-generic')).toMatchObject({ reboot: true }); expect(impactOf('mysql-server-8.0')).toMatchObject({ restart: 'database', reboot: false });
    expect(impactOf('openssl')).toMatchObject({ restart: expect.stringContaining('pustaka') }); expect(impactOf('curl')).toEqual({ impact: null, restart: null, reboot: false });
  });
});

describe('rencana patch', () => {
  it('tanpa laporan paket dari agen, atau distro bukan apt: ditolak dengan alasan yang jelas', async () => {
    expect((await h.call('POST', `/api/servers/${sid}/patch-plan`, {})).json.error).toMatch(/Belum ada daftar paket/);
    await agent('/agent/v1/patch', facts([pk('x')], { manager: 'dnf' }));
    expect((await h.call('POST', `/api/servers/${sid}/patch-plan`, {})).json.error).toMatch(/Debian dan Ubuntu/);
  });

  it('bawaan memilih paket keamanan; ringkasan dampak, langkah, dan cara mundur tersusun; belum ada yang dijalankan', async () => {
    await agent('/agent/v1/patch', FACTS()); sshLog.length = 0;
    const r = await h.call('POST', `/api/servers/${sid}/patch-plan`, {}); expect(r.status).toBe(200);
    const p = (await h.call('GET', `/api/patch-plans/${r.json.id}`)).json;
    expect(p).toMatchObject({ kind: 'patch', status: 'proposed', server_name: 'srv-patch', path: 'ssh' });
    expect(p.meta.packages.map((x: any) => x.name)).toEqual(['openssl', 'nginx']); expect(p.meta.totals).toMatchObject({ packages: 2, security: 2 });
    expect(p.meta.restarts).toEqual(expect.arrayContaining(['web server'])); expect(p.diagnosis).toMatch(/2 paket akan diperbarui \(2 keamanan\)/); expect(p.diagnosis).toMatch(/Restart tidak ikut/);
    expect(p.steps.map((s: any) => s.class)).toEqual(['read', 'change', 'change', 'read', 'read', 'read']);
    const install = p.steps[2]; expect(install.command).toContain('apt-get install -y --only-upgrade'); expect(install.command).toMatch(/openssl nginx$/); expect(install.command).not.toContain('curl');
    expect(install.rollback).toContain('openssl=3.0.2-1'); expect(install.rollback).toContain('--allow-downgrades');
    expect(p.steps.some((s: any) => s.class === 'blocked' || /^(sudo -n )?(reboot|shutdown|systemctl (reboot|poweroff))/.test(s.command))).toBe(false);   // reboot tidak ikut dalam rencana
    expect(sshLog).toEqual([]);   // menyusun rencana tidak menyentuh server
  });

  it('paket pilihan sendiri dipakai apa adanya; paket di luar daftar dan nama yang menyisipkan perintah ditolak', async () => {
    const ok = await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['curl', 'docker-ce'] }); expect(ok.status).toBe(200);
    const p = (await h.call('GET', `/api/patch-plans/${ok.json.id}`)).json; expect(p.steps[2].command).toMatch(/curl docker-ce$/); expect(p.diagnosis).toMatch(/1 paket berasal dari repositori pihak ketiga/);
    for (const bad of [['tidak-ada'], ['curl; rm -rf /'], ['curl$(id)'], ['Curl'], ['curl', '--force-yes']]) { const r = await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: bad }); expect(r.status, JSON.stringify(bad)).toBe(400); }
    expect(sshLog).toEqual([]);
  });

  it('rencana baru menggantikan yang lama yang belum disetujui', async () => {
    const a = (await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['curl'] })).json.id, b = (await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['nginx'] })).json.id;
    expect((await h.call('GET', `/api/patch-plans/${a}`)).json.status).toBe('superseded'); expect((await h.call('GET', `/api/patch-plans/${b}`)).json.status).toBe('proposed');
  });

  it('disetujui: langkah berjalan berurutan lewat SSH, hanya yang dipilih, dan agen diminta melapor ulang sekali', async () => {
    const id = (await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['openssl', 'curl'] })).json.id; sshLog.length = 0;
    expect((await h.call('POST', `/api/recommendations/${id}/approve`, { steps: [1, 2, 3, 4, 5, 6] })).status).toBe(200);
    await until(async () => (await h.call('GET', `/api/patch-plans/${id}`)).json.status === 'done');
    const p = (await h.call('GET', `/api/patch-plans/${id}`)).json;
    expect(p.steps.map((s: any) => s.status)).toEqual(Array(6).fill('done'));
    expect(sshLog[1]).toMatch(/apt-get update/); expect(sshLog[2]).toMatch(/apt-get install -y --only-upgrade .* openssl curl$/); expect(sshLog.some((c) => /nginx/.test(c))).toBe(false);
    const hb1 = await agent('/agent/v1/heartbeat', { v: 't' }), hb2 = await agent('/agent/v1/heartbeat', { v: 't' });
    expect(hb1.json.patch).toBe(true); expect(hb2.json.patch).toBe(false);
  });

  it('langkah pemasangan yang gagal menghentikan rencana dan tidak menjalankan langkah sesudahnya', async () => {
    const id = (await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['curl'] })).json.id;
    Servers.setExec(sshExec((c) => (c.includes('apt-get install') ? 100 : 0)) as never); sshLog.length = 0;
    await h.call('POST', `/api/recommendations/${id}/approve`, {});
    await until(async () => (await h.call('GET', `/api/patch-plans/${id}`)).json.status === 'failed');
    const p = (await h.call('GET', `/api/patch-plans/${id}`)).json; expect(p.steps.map((s: any) => s.status)).toEqual(['done', 'done', 'failed', 'pending', 'pending', 'pending']); expect(p.summary).toMatch(/gagal dengan exit 100/);
    Servers.setExec(sshExec() as never);
  });

  it('selama ada rencana yang berjalan, rencana baru ditolak; rincian server menunjuk rencana terakhir yang masih relevan', async () => {
    const id = (await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['curl'] })).json.id;
    const plan = async () => (await h.call('GET', `/api/servers/${sid}/patching`)).json.plan;
    expect(await plan()).toMatchObject({ id, status: 'proposed' });
    await h.db.exec("UPDATE recommendations SET status='executing' WHERE id=$1", [id]);
    const r = await h.call('POST', `/api/servers/${sid}/patch-plan`, {}); expect(r.status).toBe(400); expect(r.json.error).toContain(`#${id} sedang berjalan`);
    expect(await plan()).toMatchObject({ id, status: 'executing' });
    await h.db.exec("UPDATE recommendations SET status='done' WHERE id=$1", [id]);
    expect(await plan()).toBeNull();   // yang sudah selesai tidak lagi mengganggu
    expect((await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['curl'] })).status).toBe(200);
  });

  it('daftar menyadari bahwa patch diterapkan SESUDAH laporan agen, dan meminta laporan ulang menyalakan penanda untuk detak jantung berikutnya', async () => {
    await agent('/agent/v1/patch', FACTS());   // laporan agen terbaru
    const id = (await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['curl'] })).json.id;
    const row = async () => (await h.call('GET', '/api/maintenance/patching')).json.rows.find((r: any) => r.server_id === sid);
    const det = async () => (await h.call('GET', `/api/servers/${sid}/patching`)).json;
    await h.db.exec("UPDATE recommendations SET status='done', updated=$1 WHERE id=$2", [Date.now() + 5000, id]);   // patch selesai setelah laporan
    expect((await row()).patched_at).toBeGreaterThan(0); expect((await det()).patched_at).toBeGreaterThan(0);
    await agent('/agent/v1/patch', FACTS());   // agen melapor ulang: daftar kembali segar
    await h.db.exec('UPDATE agents SET patch_ts=$1 WHERE server_id=$2', [Date.now() + 10_000, sid]);
    expect((await row()).patched_at).toBeNull(); expect((await det()).patched_at).toBeNull();
    // minta lapor ulang: penanda dipakai sekali oleh detak jantung
    const r = await h.call('POST', `/api/servers/${sid}/patch-refresh`); expect(r.status).toBe(200); expect(r.json).toMatchObject({ ok: true });
    expect((await agent('/agent/v1/heartbeat', { v: 't' })).json.patch).toBe(true); expect((await agent('/agent/v1/heartbeat', { v: 't' })).json.patch).toBe(false);
    const none = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-tanpa-agen-2', host: '10.4.4.9', username: 'ops' })).json.id;
    expect((await h.call('POST', `/api/servers/${none}/patch-refresh`)).json.error).toMatch(/belum punya agen/);
  });

  it('daftar rencana: semua status, terbaru dulu, dengan jumlah paket dan kemajuan langkah', async () => {
    const id = (await h.call('POST', `/api/servers/${sid}/patch-plan`, { packages: ['curl', 'nginx'] })).json.id;
    let l = (await h.call('GET', '/api/patch-plans')).json as Array<Record<string, any>>;
    expect(l[0]).toMatchObject({ id, status: 'proposed', server_name: 'srv-patch', packages: 2, steps_done: 0, steps_total: 6 }); expect(l.every((x, i) => i === 0 || x.id < l[i - 1]!.id)).toBe(true);
    expect(new Set(l.map((x) => x.status))).toEqual(expect.objectContaining({})); expect(l.some((x) => x.status === 'done')).toBe(true);
    await h.db.exec("UPDATE rec_steps SET status='done' WHERE rec_id=$1 AND n<=2", [id]); await h.db.exec("UPDATE recommendations SET status='executing' WHERE id=$1", [id]);
    l = (await h.call('GET', '/api/patch-plans')).json; expect(l.find((x) => x.id === id)).toMatchObject({ status: 'executing', steps_done: 2, steps_total: 6 });
    await h.db.exec("UPDATE recommendations SET status='done' WHERE id=$1", [id]);   // jangan menyisakan rencana berjalan untuk tes berikutnya
  });

  it('lewat SSH dengan akun biasa tanpa sudo ditolak sejak awal (apt butuh root); root atau sudo menyala diterima', async () => {
    const s3 = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-biasa', host: '10.4.4.6', username: 'aiops', use_sudo: false })).json.id;
    const a3 = (await h.call('POST', `/api/servers/${s3}/agent`, {})).json, ts = agentTs(), raw = JSON.stringify(FACTS());
    await h.app.inject({ method: 'POST', url: '/agent/v1/patch', headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': a3.keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(a3.config.secret, ts, 'POST', '/agent/v1/patch', raw) }, payload: raw });
    const r = await h.call('POST', `/api/servers/${s3}/patch-plan`, {}); expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Akun SSH "aiops" bukan root dan opsi "Pakai sudo" mati/); expect(r.json.error).toMatch(/nyalakan eksekusi di agen/);
    await h.db.exec('UPDATE servers SET use_sudo=true WHERE id=$1', [s3]); expect((await h.call('POST', `/api/servers/${s3}/patch-plan`, {})).status).toBe(200);
    await h.db.exec("UPDATE servers SET use_sudo=false, username='root' WHERE id=$1", [s3]); expect((await h.call('POST', `/api/servers/${s3}/patch-plan`, {})).status).toBe(200);
    const cmds = ((await h.call('GET', `/api/patch-plans/${(await h.db.one<{ id: number }>("SELECT max(id) AS id FROM recommendations WHERE kind='patch' AND server_id=$1", [s3]))!.id}`)).json.steps as Array<{ command: string }>).map((s) => s.command);
    expect(cmds.some((c) => c.startsWith('sudo'))).toBe(false);   // root: tanpa sudo
  });

  it('tanpa jalur eksekusi (tanpa kunci SSH dan agen tidak boleh mengeksekusi): rencana tidak dibuat', async () => {
    const s2 = (await h.call('POST', '/api/servers', { name: 'srv-tanpa-jalur', host: '10.4.4.5', username: 'ops', generate_key: true })).json.id; await h.db.exec("UPDATE servers SET ssh_key_enc='', key_path='' WHERE id=$1", [s2]);
    const a2 = (await h.call('POST', `/api/servers/${s2}/agent`, {})).json, ts = agentTs(), raw = JSON.stringify(FACTS());
    await h.app.inject({ method: 'POST', url: '/agent/v1/patch', headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': a2.keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(a2.config.secret, ts, 'POST', '/agent/v1/patch', raw) }, payload: raw });
    expect((await h.call('POST', `/api/servers/${s2}/patch-plan`, {})).json.error).toMatch(/Tidak ada jalur eksekusi/);
  });
});
