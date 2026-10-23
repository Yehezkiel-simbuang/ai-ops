// Agen di server: kredensial, autentikasi HMAC, kejadian kritis -> insiden -> rekomendasi -> persetujuan -> eksekusi (SSH dan jalur agen).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agents from '../src/agents.js';
import { installGuide } from '../src/agent-install.js';
import * as Incidents from '../src/incidents.js';
import * as Safety from '../src/safety.js';
import * as Servers from '../src/servers.js';
import * as Store from '../src/store.js';
import { harness, login, sleep, until, type Harness } from './helpers.js';

let h: Harness, recv: http.Server, port = 0, binDir = '';
const hooks: string[] = [];
let sid = 0, keyId = '', secret = '';
const sshLog: string[] = [];
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';

const sshExec = (fail: (cmd: string) => number = () => 0) => async (_s: unknown, cmd: string) => { sshLog.push(cmd); return { exitCode: fail(cmd), stdout: 'out:' + cmd.slice(0, 20), stderr: '', ms: 1, timedOut: false }; };
let seq = 0;
const ev = (o: Partial<Incidents.AgentEvent> = {}) => ({ id: 'e' + ++seq + Math.random().toString(36).slice(2, 8), type: 'open', key: 'svc:nginx', title: 'Layanan nginx tidak aktif', kind: 'service', severity: 'critical', detail: 'status: failed', ts: Math.floor(Date.now() / 1000), diag: [{ name: 'systemctl status', out: 'nginx failed' }], ...o });

async function agentCall(method: string, path: string, body?: unknown, o: { key?: string; secret?: string; ts?: string; tamper?: boolean } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body), ts = o.ts ?? String(Math.floor(Date.now() / 1000)), p = path.split('?')[0]!;
  const sig = Agents.signRequest(o.secret ?? secret, ts, method, p, raw);
  const r = await h.app.inject({ method: method as never, url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': o.key ?? keyId, 'x-aiops-ts': ts, 'x-aiops-sig': sig }, payload: o.tamper ? raw + ' ' : raw || undefined });
  let json: any = null; try { json = r.json(); } catch { /* */ }
  return { status: r.statusCode, json };
}

beforeAll(async () => {
  recv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(JSON.parse(b).text); res.end('ok'); }); });
  await new Promise<void>((r) => recv.listen(0, '127.0.0.1', () => r())); port = (recv.address() as AddressInfo).port;
  binDir = mkdtempSync(join(tmpdir(), 'agent-bin-')); writeFileSync(join(binDir, 'aiops-agent-linux-amd64'), 'BINER-PALSU'); writeFileSync(join(binDir, 'SHA256SUMS'), 'abc  aiops-agent-linux-amd64\n');
  h = await harness({ AGENT_BIN_DIR: binDir, PUBLIC_URL: 'https://aiops.contoh.com' }); await login(h);
  await h.call('POST', '/api/channels', { type: 'webhook', name: 'hook', min_level: 'critical', config: { url: `http://127.0.0.1:${port}/h`, format: 'slack' } });
  sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-agen', host: '10.1.1.1', username: 'ops', use_sudo: true })).json.id;
  Servers.setExec(sshExec() as never);
});
afterAll(async () => { recv.close(); await h.close(); });
const incidents = async (st = 'open') => (await h.call('GET', `/api/incidents?status=${st}`)).json as any[];

describe('kredensial dan autentikasi agen', () => {
  it('membuat kredensial, secret tampil sekali dan tersimpan terenkripsi, panduan pemasangan lengkap', async () => {
    const r = await h.call('POST', `/api/servers/${sid}/agent`, { exec: true }); expect(r.status).toBe(200);
    keyId = r.json.keyId; secret = r.json.config.secret; expect(secret.length).toBeGreaterThanOrEqual(32); expect(keyId).toMatch(/^ak_/);
    expect(r.json.script).toContain('https://aiops.contoh.com/agent/download/'); expect(r.json.script).toContain('sha256sum -c'); expect(r.json.script).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/); expect(r.json.config.allow_exec).toBe(true);
    const row = await h.db.one('SELECT secret_enc FROM agents WHERE server_id=$1', [sid]); expect(row!.secret_enc).not.toContain(secret);
    expect(JSON.stringify((await h.call('GET', `/api/servers/${sid}/agent`)).json)).not.toContain(secret);
  });
  it('tanda tangan salah, kunci tidak ada, cap waktu basi, dan badan yang diubah semuanya 401 seragam', async () => {
    const body = { v: 't' };
    expect((await agentCall('POST', '/agent/v1/heartbeat', body, { secret: 'x'.repeat(43) })).status).toBe(401);
    expect((await agentCall('POST', '/agent/v1/heartbeat', body, { key: 'ak_tidakada' })).status).toBe(401);
    expect((await agentCall('POST', '/agent/v1/heartbeat', body, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
    expect((await agentCall('POST', '/agent/v1/heartbeat', body, { tamper: true })).status).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers: { host: 'localhost', 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(401);
    expect((await agentCall('POST', '/agent/v1/heartbeat', body)).status).toBe(200);
  });
  it('rute agen tidak butuh sesi/CSRF, tetapi tetap menolak Host asing', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers: { host: 'evil.example', 'content-type': 'application/json', 'x-aiops-key': keyId, 'x-aiops-ts': '1', 'x-aiops-sig': 'x' }, payload: '{}' }); expect(r.statusCode).toBe(403);
  });
  it('rotasi mengganti secret dan mencabut yang lama', async () => {
    const old = secret, r = await h.call('POST', `/api/servers/${sid}/agent`, { exec: true }); expect(r.json.rotated).toBe(true); expect(r.json.keyId).toBe(keyId); secret = r.json.config.secret; expect(secret).not.toBe(old);
    expect((await agentCall('POST', '/agent/v1/heartbeat', {}, { secret: old })).status).toBe(401); expect((await agentCall('POST', '/agent/v1/heartbeat', { exec: true, v: '1.0', host: 'srv', hb: 60 })).status).toBe(200);
  });
  it('heartbeat dengan open null atau kosong diterima (regresi: agen Go dulu mengirim null)', async () => {
    expect((await agentCall('POST', '/agent/v1/heartbeat', { v: 't', exec: true, open: null, host: 'srv', hb: 60 })).status).toBe(200); expect((await agentCall('POST', '/agent/v1/heartbeat', { v: 't', exec: true, open: [], host: 'srv', hb: 60 })).status).toBe(200);
  });
  it('heartbeat menandai agen online', async () => { const a = (await h.call('GET', `/api/servers/${sid}/agent`)).json; expect(a.agent.online).toBe(true); expect(a.agent.exec_enabled).toBe(true); expect(a.agent.hostname).toBe('srv'); });
});

describe('kejadian kritis -> insiden -> rekomendasi', () => {
  let incId = 0;
  it('open: membuat insiden, peringatan (sumber agen), notifikasi kritis, dan rekomendasi playbook', async () => {
    hooks.length = 0; const e = ev();
    const r = await agentCall('POST', '/agent/v1/events', { events: [e] }); expect(r.json).toMatchObject({ ok: true, accepted: 1, duplicates: 0 });
    const list = await incidents(); expect(list).toHaveLength(1); incId = list[0].id; expect(list[0]).toMatchObject({ key: 'svc:nginx', status: 'open', server_name: 'srv-agen' });
    expect((await Monitor_alerts()).some((a: any) => a.key === 'ag:svc:nginx' && a.source === 'agent' && a.level === 'critical')).toBe(true);
    expect(await until(() => hooks.some((t) => /CRITICAL/.test(t) && /nginx/.test(t)))).toBeTruthy();
    expect(await until(async () => (await incidents())[0].rec_status === 'proposed')).toBeTruthy();
    expect(await until(() => hooks.some((t) => /REKOMENDASI/.test(t)))).toBeTruthy();
  });
  it('rekomendasi memuat diagnostik agen dan langkah dengan kelas baca/ubah', async () => {
    const d = (await h.call('GET', `/api/incidents/${incId}`)).json; expect(d.incident.diag[0].out).toBe('nginx failed'); const rec = d.recommendations[0];
    expect(rec.source).toBe('playbook'); expect(rec.diagnosis).toMatch(/nginx/); const cls = rec.steps.map((s: any) => s.class); expect(cls).toContain('read'); expect(cls).toContain('change');
    expect(rec.steps.find((s: any) => /restart nginx/.test(s.command)).class).toBe('change'); expect(rec.steps.some((s: any) => s.class === 'blocked')).toBe(false);
  });
  it('pengiriman ulang (id sama) tidak menggandakan; open baru untuk kunci yang sama memperbarui insiden yang ada', async () => {
    const e = ev(); await agentCall('POST', '/agent/v1/events', { events: [e] }); const dup = await agentCall('POST', '/agent/v1/events', { events: [e] }); expect(dup.json).toMatchObject({ accepted: 0, duplicates: 1 });
    await agentCall('POST', '/agent/v1/events', { events: [ev({ type: 'still_open', detail: 'masih mati' })] }); expect(await incidents()).toHaveLength(1);
    expect((await h.call('GET', `/api/incidents/${incId}`)).json.incident.event_count).toBeGreaterThanOrEqual(3);
  });
  it('kejadian tidak valid ditolak, sebagian valid tetap diproses, lebih dari 50 ditolak', async () => {
    const mixed = await agentCall('POST', '/agent/v1/events', { events: [{ id: 'x' }, ev({ key: 'disk:/', kind: 'disk', title: 'Disk / hampir penuh', detail: '97%' })] }); expect(mixed.json).toMatchObject({ accepted: 1, rejected: 1 });
    expect((await agentCall('POST', '/agent/v1/events', { events: [{ id: 'x' }] })).status).toBe(400);
    expect((await agentCall('POST', '/agent/v1/events', { events: Array.from({ length: 51 }, () => ev()) })).status).toBe(400);
    await agentCall('POST', '/agent/v1/events', { events: [ev({ type: 'resolved', key: 'disk:/' })] });
  });
  it('resolved: menutup insiden dan peringatan, mengabarkan pulih, dan mengganti rekomendasi yang belum disetujui', async () => {
    hooks.length = 0; await agentCall('POST', '/agent/v1/events', { events: [ev({ type: 'resolved' })] });
    expect(await incidents('open')).toHaveLength(0); expect((await incidents('resolved')).some((i) => i.id === incId)).toBe(true);
    expect((await Monitor_alerts()).some((a: any) => a.key === 'ag:svc:nginx')).toBe(false); expect(await until(() => hooks.some((t) => /RESOLVED/.test(t)))).toBeTruthy();
    expect((await h.call('GET', `/api/incidents/${incId}`)).json.recommendations[0].status).toBe('superseded');
  });
});
async function Monitor_alerts() { return (await import('../src/monitor.js')).alerts(sid, true); }

describe('playbook dan penyempurnaan model', () => {
  it('playbook per jenis: layanan data bertanda risiko tinggi, disk memangkas journal, IO hanya membaca', () => {
    const srv = { use_sudo: true };
    expect(Incidents.playbook({ key: 'svc:mysql', kind: 'service', title: '', detail: '' }, srv).steps.find((s) => /restart/.test(s.command))!.risk).toBe('tinggi');
    expect(Incidents.playbook({ key: 'svc:mysql', kind: 'service', title: '', detail: '' }, srv).steps[0]!.command).toMatch(/^sudo -n systemctl status mysql/);
    expect(Incidents.playbook({ key: 'disk:/', kind: 'disk', title: '', detail: '' }, srv).steps.some((s) => /vacuum-size/.test(s.command))).toBe(true);
    expect(Incidents.playbook({ key: 'io', kind: 'io', title: '', detail: '' }, srv).steps.every((s) => s.risk === 'rendah')).toBe(true);
    expect(Incidents.playbook({ key: 'svc:a;rm -rf /', kind: 'service', title: 'x', detail: 'y' }, srv).steps.some((s) => /rm -rf/.test(s.command))).toBe(false);
    expect(Incidents.playbook({ key: 'aneh', kind: 'tak-dikenal', title: 'T', detail: 'D' }, srv).steps.length).toBeGreaterThan(0);
  });
  it('insiden keamanan: tiap jenis punya diagnosis dan HANYA langkah baca (tindakan yang mengubah tetap keputusan pemilik), dengan maupun tanpa sudo', () => {
    for (const use_sudo of [true, false]) for (const topic of ['ssh_fail', 'root_login', 'users', 'keys', 'sudoers', 'sshd', 'ports']) {
      const plan = Incidents.playbook({ key: `sec:${topic}`, kind: 'security', title: 'T', detail: 'D' }, { use_sudo });
      expect(plan.diagnosis.length, topic).toBeGreaterThan(30); expect(plan.steps.length, topic).toBeGreaterThan(0);
      for (const st of plan.steps) { expect(st.risk, `${topic}: ${st.title}`).toBe('rendah'); expect(Safety.classify(st.command).cls, `${topic}: ${st.command}`).toBe('read'); }
      expect(Safety.classify(plan.verify).cls, `${topic} verify`).toBe('read');
    }
    expect(Incidents.playbook({ key: 'sec:entah', kind: 'security', title: 'T', detail: 'D' }, { use_sudo: false }).steps.length).toBeGreaterThan(0);   // jenis baru tanpa playbook khusus tetap aman
    expect(Incidents.playbook({ key: 'sec:ssh_fail', kind: 'security', title: 'T', detail: 'D' }, { use_sudo: true }).steps[0]!.command).toMatch(/^sudo -n journalctl/);
  });
  it('pemasangan agen baru menyalakan pemeriksaan keamanan; login root tetap opt-in', () => {
    const g = installGuide('https://aiops.contoh', { keyId: 'ak_x', secret: 'x'.repeat(40) }, { exec: false, services: [] });
    expect(g.config.security).toMatchObject({ enabled: true, ssh_fail_crit: 30, root_login_crit: false }); expect(g.configText).toContain('"security"');
  });
  it('model menyempurnakan rencana, tetapi langkah merusak dibuang dan JSON rusak jatuh ke playbook', async () => {
    await h.call('POST', '/api/provider', { id: 'tiruan', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }); await h.call('POST', '/api/role', { role: 'setup', provider: 'tiruan', model: 'm' });
    Incidents.configure({ llm: (async () => ({ text: JSON.stringify({ diagnosis: 'Konfigurasi nginx salah sejak deploy terakhir.', verify: 'systemctl is-active nginx', steps: [{ title: 'Uji konfigurasi', command: 'nginx -t', rationale: 'validasi', risk: 'rendah' }, { title: 'Reboot', command: 'reboot', risk: 'tinggi' }, { title: 'Reload', command: 'systemctl reload nginx', rationale: 'terapkan', risk: 'sedang', rollback: 'systemctl restart nginx' }, { title: 'Hapus', command: 'rm -rf /', risk: 'tinggi' }] }), usage: { input: 1, output: 1 } })) as never });
    await agentCall('POST', '/agent/v1/events', { events: [ev({ key: 'svc:nginx' })] }); const i = (await incidents())[0];
    expect(await until(async () => (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations.length > 0)).toBeTruthy();
    const rec = (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations[0]; expect(rec.source).toBe('llm'); expect(rec.diagnosis).toMatch(/deploy terakhir/);
    expect(rec.steps.map((s: any) => s.command)).toEqual(['nginx -t', 'systemctl reload nginx']); expect(rec.steps[0].class).toBe('read'); expect(rec.steps[1].class).toBe('change');
    Incidents.configure({ llm: (async () => ({ text: 'bukan json', usage: { input: 1, output: 1 } })) as never });
    await h.call('POST', `/api/incidents/${i.id}/regenerate`, {}); const rec2 = (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations[0]; expect(rec2.source).toBe('playbook'); expect(rec2.id).not.toBe(rec.id);
    expect((await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations.find((r: any) => r.id === rec.id).status).toBe('superseded');
    await h.call('POST', `/api/incidents/${i.id}/regenerate`, { useModel: false });
    await agentCall('POST', '/agent/v1/events', { events: [ev({ type: 'resolved' })] });
  });
});

describe('persetujuan dan eksekusi (jalur SSH)', () => {
  let recId = 0, incId = 0;
  beforeAll(async () => {
    Incidents.configure({ llm: (async () => { throw new Error('tanpa model'); }) as never }); await Store.setRole('setup', 'tiruan', 'm');
    await h.call('PUT', `/api/servers/${sid}`, { ssh_key: PEM });
    await agentCall('POST', '/agent/v1/events', { events: [ev({ key: 'svc:cron', title: 'Layanan cron tidak aktif', detail: 'status: failed' })] });
    const i = (await incidents()).find((x) => x.key === 'svc:cron'); incId = i.id; await until(async () => (await h.call('GET', `/api/incidents/${incId}`)).json.recommendations.length > 0);
    recId = (await h.call('GET', `/api/incidents/${incId}`)).json.recommendations[0].id;
  });
  it('jalur eksekusi terdeteksi (SSH karena kunci tersimpan)', async () => expect((await h.call('GET', `/api/incidents/${incId}`)).json.path).toBe('ssh'));
  it('tanpa persetujuan tidak ada perintah yang berjalan', async () => { expect(sshLog.filter((c) => /cron/.test(c))).toHaveLength(0); });
  it('menyetujui langkah terpilih: hanya yang dipilih berjalan, berurutan, lalu verifikasi', async () => {
    sshLog.length = 0; const steps = (await h.call('GET', `/api/recommendations/${recId}`)).json.steps;
    const pick = [steps[0].n, steps.find((s: any) => s.class === 'change').n];
    expect((await h.call('POST', `/api/recommendations/${recId}/approve`, { steps: pick })).status).toBe(200);
    expect(await until(async () => (await h.call('GET', `/api/recommendations/${recId}`)).json.status === 'done', 8000)).toBeTruthy();
    const rec = (await h.call('GET', `/api/recommendations/${recId}`)).json; expect(rec.approved_by).toBe('admin');
    expect(sshLog.slice(0, 2)).toEqual([steps[0].command, steps.find((s: any) => s.class === 'change').command]); expect(sshLog[2]).toBe(rec.verify); expect(sshLog).toHaveLength(3);
    expect(rec.steps.filter((s: any) => s.status === 'skipped').length).toBe(steps.length - 2); expect(rec.steps.find((s: any) => s.n === pick[1]).via).toBe('ssh'); expect(rec.verify_out).toMatch(/out:/);
  });
  it('menyetujui dua kali ditolak (klaim atomik)', async () => { expect((await h.call('POST', `/api/recommendations/${recId}/approve`, {})).status).toBe(400); });
  it('langkah gagal menghentikan sisanya dan rekomendasi berstatus gagal; setujui ulang hanya menjalankan yang belum selesai', async () => {
    await agentCall('POST', '/agent/v1/events', { events: [ev({ type: 'resolved', key: 'svc:cron' })] });
    await agentCall('POST', '/agent/v1/events', { events: [ev({ key: 'svc:crond', title: 'Layanan crond tidak aktif' })] });
    const i = (await incidents()).find((x) => x.key === 'svc:crond'); await until(async () => (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations.length > 0);
    const rid = (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations[0].id; sshLog.length = 0;
    Servers.setExec(sshExec((c) => (/restart crond/.test(c) ? 1 : 0)) as never);
    await h.call('POST', `/api/recommendations/${rid}/approve`, {}); expect(await until(async () => (await h.call('GET', `/api/recommendations/${rid}`)).json.status === 'failed', 8000)).toBeTruthy();
    const rec = (await h.call('GET', `/api/recommendations/${rid}`)).json; expect(rec.summary).toMatch(/gagal/); expect(rec.steps.find((s: any) => s.status === 'failed').class).toBe('change'); expect(sshLog.some((c) => /journalctl -u/.test(c))).toBe(true);
    Servers.setExec(sshExec() as never); sshLog.length = 0; await h.call('POST', `/api/recommendations/${rid}/approve`, {});
    expect(await until(async () => (await h.call('GET', `/api/recommendations/${rid}`)).json.status === 'done', 8000)).toBeTruthy(); expect(sshLog.some((c) => /restart crond/.test(c))).toBe(true); expect(sshLog.some((c) => /systemctl status/.test(c))).toBe(false); expect(sshLog.some((c) => /journalctl -u/.test(c))).toBe(false);   // langkah yang sudah selesai tidak diulang
    await agentCall('POST', '/agent/v1/events', { events: [ev({ type: 'resolved', key: 'svc:crond' })] });
  });
  it('menolak rekomendasi', async () => {
    await agentCall('POST', '/agent/v1/events', { events: [ev({ key: 'svc:rsyslog', title: 'rsyslog mati' })] }); const i = (await incidents()).find((x) => x.key === 'svc:rsyslog');
    await until(async () => (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations.length > 0); const rid = (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations[0].id; sshLog.length = 0;
    expect((await h.call('POST', `/api/recommendations/${rid}/reject`)).status).toBe(200); expect((await h.call('POST', `/api/recommendations/${rid}/approve`, {})).status).toBe(400); expect(sshLog).toHaveLength(0);
    await agentCall('POST', '/agent/v1/events', { events: [ev({ type: 'resolved', key: 'svc:rsyslog' })] });
  });
  it('perintah yang diblokir kebijakan tidak pernah tersimpan sebagai langkah, walau muncul dari data insiden', async () => {
    const steps = await h.db.query("SELECT command FROM rec_steps WHERE class='blocked'"); expect(steps).toHaveLength(0);
  });
  it('tanpa jalur eksekusi, persetujuan ditolak dengan pesan jelas', async () => {
    const s2 = (await h.call('POST', '/api/servers', { key_path: '/k', exec_via: 'agent', name: 'tanpa-jalur', host: '10.2.2.2', username: 'ops' })).json.id; const a2 = await Agents.issue(s2);
    const call2 = async (path: string, body: unknown) => { const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000)); const r = await h.app.inject({ method: 'POST', url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': a2.keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(a2.secret, ts, 'POST', path, raw) }, payload: raw }); return r.statusCode; };
    await call2('/agent/v1/events', { events: [ev({ key: 'svc:x1', title: 'x' })] }); const i = (await incidents()).find((x) => x.server_name === 'tanpa-jalur'); await until(async () => (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations.length > 0);
    const rid = (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations[0].id; const r = await h.call('POST', `/api/recommendations/${rid}/approve`, {}); expect(r.status).toBe(400); expect(r.json.error).toMatch(/jalur eksekusi/);
  });
});

describe('jalur agen (tanpa SSH): perintah bertanda tangan yang diambil agen', () => {
  let s3 = 0, k3 = '', sec3 = '';
  const call3 = async (method: string, path: string, body?: unknown) => { const raw = body === undefined ? '' : JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000)); const r = await h.app.inject({ method: method as never, url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': k3, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(sec3, ts, method, path.split('?')[0]!, raw) }, payload: raw || undefined }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() }; };
  beforeAll(async () => {
    s3 = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-natted', host: '10.3.3.3', username: 'ops', exec_via: 'agent' })).json.id; const a = await Agents.issue(s3); k3 = a.keyId; sec3 = a.secret;
    await call3('POST', '/agent/v1/heartbeat', { exec: true, v: 't', host: 'natted', hb: 60 });
  });
  it('agen yang mematikan eksekusi tidak mendapat perintah apa pun', async () => {
    await call3('POST', '/agent/v1/heartbeat', { exec: false }); const r = await call3('GET', '/agent/v1/commands/poll?wait=0'); expect(r.json).toEqual({ commands: [], poll: false }); await call3('POST', '/agent/v1/heartbeat', { exec: true });
  });
  it('alur lengkap: setujui -> antre -> agen mengambil (bertanda tangan) -> melapor -> selesai', async () => {
    await call3('POST', '/agent/v1/events', { events: [ev({ key: 'svc:redis', title: 'redis mati' })] }); const i = (await incidents()).find((x) => x.server_name === 'srv-natted'); await until(async () => (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations.length > 0);
    expect((await h.call('GET', `/api/incidents/${i.id}`)).json.path).toBe('agent'); const rid = (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations[0].id;
    expect((await call3('GET', '/agent/v1/commands/poll?wait=0')).json.commands).toHaveLength(0);   // belum disetujui: tidak ada yang diantrekan
    expect((await h.call('POST', `/api/recommendations/${rid}/approve`, {})).status).toBe(200);
    const heartbeat = await call3('POST', '/agent/v1/heartbeat', { exec: true }); expect(await until(async () => (await call3('POST', '/agent/v1/heartbeat', { exec: true })).json.poll)).toBeTruthy(); void heartbeat;
    const executed: string[] = [];
    for (let round = 0; round < 20; round++) {
      const p = await call3('GET', '/agent/v1/commands/poll?wait=2'); for (const c of p.json.commands) {
        expect(c.sig).toBe(Agents.signCommand(sec3, c.id, c.expires, c.timeout_s, c.command)); expect(c.expires * 1000).toBeGreaterThan(Date.now()); executed.push(c.command);
        await call3('POST', `/agent/v1/commands/${c.id}/result`, { exit: 0, stdout: 'ok dari agen', stderr: '' });
      }
      if ((await h.call('GET', `/api/recommendations/${rid}`)).json.status === 'done') break;
    }
    const rec = (await h.call('GET', `/api/recommendations/${rid}`)).json; expect(rec.status).toBe('done'); expect(rec.steps.every((s: any) => s.via === 'agent' || s.status === 'skipped')).toBe(true);
    expect(executed.length).toBe(rec.steps.filter((s: any) => s.status === 'done').length + 1); expect(executed.every((c) => !/reboot|rm -rf/.test(c))).toBe(true); expect(rec.verify_out).toMatch(/ok dari agen/);
  });
  it('perintah yang ditolak agen membuat langkah gagal', async () => {
    await call3('POST', '/agent/v1/events', { events: [ev({ type: 'resolved', key: 'svc:redis' }), ev({ key: 'svc:memcached', title: 'memcached mati' })] }); const i = (await incidents()).find((x) => x.key === 'svc:memcached'); await until(async () => (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations.length > 0);
    const rid = (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations[0].id; await h.call('POST', `/api/recommendations/${rid}/approve`, {});
    for (let round = 0; round < 10; round++) { const p = await call3('GET', '/agent/v1/commands/poll?wait=2'); for (const c of p.json.commands) await call3('POST', `/agent/v1/commands/${c.id}/result`, { exit: 126, rejected: 'diblokir kebijakan agen' }); if ((await h.call('GET', `/api/recommendations/${rid}`)).json.status === 'failed') break; }
    const rec = (await h.call('GET', `/api/recommendations/${rid}`)).json; expect(rec.status).toBe('failed'); expect(rec.steps.find((s: any) => s.status === 'failed').stderr).toMatch(/ditolak agen/);
  });
  it('hasil perintah milik server lain tidak diterima', async () => {
    const id = await Agents.enqueue(s3, null, null, 'uptime', 10); const other = await Agents.recordResult(sid, id, { exit: 0 }); expect(other).toBe(false);
    expect(await Agents.recordResult(s3, id, { exit: 0, stdout: 'x' })).toBe(true); expect(await Agents.recordResult(s3, id, { exit: 0, stdout: 'ganda' })).toBe(false);
  });
});

describe('pengawas agen mati dan unduhan', () => {
  it('agen yang berhenti mengirim detak jantung memicu peringatan kritis; kembali hidup menutupnya', async () => {
    hooks.length = 0; await h.db.exec('UPDATE agents SET last_seen=$1, online=true WHERE server_id=$2', [Date.now() - 20 * 60_000, sid]); await Agents.watchdog();
    const al = (await Monitor_alerts()).find((a: any) => a.key === 'agent:offline'); expect(al?.level).toBe('critical'); expect(await until(() => hooks.some((t) => /tidak mengirim detak jantung/.test(t)))).toBeTruthy();
    await agentCall('POST', '/agent/v1/heartbeat', { exec: true }); expect((await Monitor_alerts()).some((a: any) => a.key === 'agent:offline')).toBe(false);
  });
  it('unduhan biner: hanya nama yang diizinkan, tanpa path traversal', async () => {
    const get = (p: string) => h.app.inject({ method: 'GET', url: p, headers: { host: 'localhost' } });
    expect((await get('/agent/download/aiops-agent-linux-amd64')).body).toBe('BINER-PALSU'); expect((await get('/agent/download/SHA256SUMS')).statusCode).toBe(200);
    for (const bad of ['/agent/download/..%2f..%2fetc%2fpasswd', '/agent/download/aiops-agent-windows', '/agent/download/aiops-agent-linux-arm64', '/agent/download/%2e%2e%2fpackage.json']) expect([404, 400]).toContain((await get(bad)).statusCode);
  });
  it('API pengelolaan agen tetap butuh sesi', async () => {
    expect((await h.call('POST', `/api/servers/${sid}/agent`, {}, { cookie: null })).status).toBe(401); expect((await h.call('GET', '/api/incidents', undefined, { cookie: null })).status).toBe(401);
  });
  it('exec_via divalidasi', async () => { expect((await h.call('POST', '/api/servers', { key_path: '/k', name: 'x-via', host: '1.1.1.1', username: 'ops', exec_via: 'ngawur' })).status).toBe(400); });
  it('execPath: aturan pemilihan jalur', () => {
    const on = { exec_enabled: true, online: true }, off = { exec_enabled: true, online: false };
    expect(Incidents.execPath({ exec_via: 'auto', ssh_key_enc: 'x', key_path: '' }, on)).toBe('ssh'); expect(Incidents.execPath({ exec_via: 'auto', ssh_key_enc: '', key_path: '' }, on)).toBe('agent'); expect(Incidents.execPath({ exec_via: 'auto', ssh_key_enc: '', key_path: '' }, off)).toBe('none');
    expect(Incidents.execPath({ exec_via: 'agent', ssh_key_enc: 'x', key_path: '' }, on)).toBe('agent'); expect(Incidents.execPath({ exec_via: 'ssh', ssh_key_enc: '', key_path: '' }, on)).toBe('none'); expect(Incidents.execPath({ exec_via: 'auto', ssh_key_enc: '', key_path: '' }, null)).toBe('none');
  });
});
void sleep;

describe('konfigurasi agen dari halaman Standar dan tingkat kejadian', () => {
  it('rute /config butuh tanda tangan; berisi batas tiga tingkat untuk dasar dan login SSH gagal, serta tingkat tiap jenis kejadian', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/agent/v1/config', headers: { host: 'localhost' } })).statusCode).toBe(401);
    const r = await agentCall('GET', '/agent/v1/config'); expect(r.status).toBe(200);
    expect(r.json.version).toMatch(/^[0-9a-f]{12}$/);
    expect(r.json.limits.disk).toEqual({ minor: 75, major: 85, critical: 95 }); expect(r.json.limits.mem).toEqual({ minor: 20, major: 10, critical: 5 }); expect(r.json.limits.ssh_fail).toEqual({ minor: 5, major: 15, critical: 30 });
    expect(Object.keys(r.json.limits).sort()).toEqual(['disk', 'io', 'load', 'mem', 'ssh_fail']);
    expect(r.json.events).toMatchObject({ 'sec:users': 'critical', 'sec:keys': 'critical', 'sec:sudoers': 'critical', 'sec:sshd': 'major', 'sec:ports': 'major', 'sec:root_login': 'major' });
  });
  it('detak jantung memberi tahu versi konfigurasi; berubah bila Standar diubah, kembali bila dipulihkan', async () => {
    const v0 = (await agentCall('POST', '/agent/v1/heartbeat', { v: 't', hb: 60 })).json.cfg; expect(v0).toBe((await agentCall('GET', '/agent/v1/config')).json.version);
    expect((await h.call('PUT', '/api/standards', { key: 'base:disk', minor: 60, warn: 80, crit: 90 })).status).toBe(200);
    const v1 = (await agentCall('POST', '/agent/v1/heartbeat', { v: 't', hb: 60 })).json.cfg; expect(v1).not.toBe(v0);
    expect((await agentCall('GET', '/agent/v1/config')).json.limits.disk).toEqual({ minor: 60, major: 80, critical: 90 });
    await h.call('PUT', '/api/standards', { key: 'base:disk', reset: true }); expect((await agentCall('POST', '/agent/v1/heartbeat', { v: 't', hb: 60 })).json.cfg).toBe(v0);
  });
  it('batas login SSH gagal diatur di Standar (kunci agent:ssh_fail) dengan aturan urutan yang sama; tampil di daftar Standar', async () => {
    const std = (await h.call('GET', '/api/standards')).json; const row = std.agent.find((x: { key: string }) => x.key === 'agent:ssh_fail');
    expect(row).toMatchObject({ minor: 5, warn: 15, crit: 30, unit: 'kali', numeric: true, custom: false });
    expect((await h.call('PUT', '/api/standards', { key: 'agent:ssh_fail', minor: 40, warn: 15, crit: 30 })).status).toBe(400);   // minor lebih parah dari major
    expect((await h.call('PUT', '/api/standards', { key: 'agent:ssh_fail', minor: 10, warn: 25, crit: 60 })).status).toBe(200);
    expect((await agentCall('GET', '/agent/v1/config')).json.limits.ssh_fail).toEqual({ minor: 10, major: 25, critical: 60 });
    await h.call('PUT', '/api/standards', { key: 'agent:ssh_fail', reset: true }); expect((await agentCall('GET', '/agent/v1/config')).json.limits.ssh_fail).toEqual({ minor: 5, major: 15, critical: 30 });
  });
  it('tingkat jenis kejadian bisa diubah dan dipulihkan; tingkat atau kunci asing ditolak', async () => {
    const put = (b: object) => h.call('PUT', '/api/standards/event', b);
    expect((await h.call('GET', '/api/standards')).json.events.find((e: { key: string }) => e.key === 'sec:ports')).toMatchObject({ level: 'major', default: 'major', custom: false });
    const r = await put({ key: 'sec:ports', level: 'minor' }); expect(r.status).toBe(200); expect(r.json.events.find((e: { key: string }) => e.key === 'sec:ports')).toMatchObject({ level: 'minor', custom: true });
    expect((await agentCall('GET', '/agent/v1/config')).json.events['sec:ports']).toBe('minor');
    expect((await put({ key: 'sec:ports', level: 'darurat' })).status).toBe(400); expect((await put({ key: 'sec:tidak-ada', level: 'info' })).status).toBe(400); expect((await put({ key: 'sec:ports' })).status).toBe(400);
    await put({ key: 'sec:ports', reset: true }); expect((await agentCall('GET', '/agent/v1/config')).json.events['sec:ports']).toBe('major');
    expect((await h.call('GET', '/api/audit')).json.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['standar.kejadian.ubah', 'standar.kejadian.pulihkan']));
  });
  it('insiden yang sudah terbuka mengikuti perubahan tingkat dari agen: naik mengabari lagi dan menyusun rekomendasi, turun diperbarui diam-diam', async () => {
    hooks.length = 0;
    const k = 'sec:ssh_fail', send = (severity: string) => agentCall('POST', '/agent/v1/events', { events: [ev({ key: k, kind: 'security', title: 'Login SSH gagal berulang', severity, detail: `tingkat ${severity}` })] });
    await send('minor'); let i = (await incidents()).find((x) => x.key === k); expect(i.severity).toBe('minor');
    expect((await h.db.query('SELECT 1 FROM recommendations WHERE incident_id=$1', [i.id])).length).toBe(0);
    await send('major'); i = (await incidents()).find((x) => x.key === k); expect(i.severity).toBe('major');
    expect(await until(async () => (await h.call('GET', `/api/incidents/${i.id}`)).json.recommendations.length > 0)).toBeTruthy();   // major menyusun rekomendasi
    expect(hooks.some((t) => /\[MAJOR\]/.test(t))).toBe(false);   // kanal uji hanya critical: peringatan Major tidak sampai (rekomendasi siap tetap dikabarkan ke semua kanal)
    await send('critical'); expect((await incidents()).find((x) => x.key === k).severity).toBe('critical'); expect(await until(() => hooks.some((t) => /CRITICAL/.test(t) && /Login SSH gagal berulang/.test(t)))).toBeTruthy();
    const n = hooks.length; await send('major'); expect((await incidents()).find((x) => x.key === k).severity).toBe('major'); await sleep(200); expect(hooks.length).toBe(n);   // turun: tanpa notifikasi baru
    expect(((await Monitor_alerts()) as any[]).find((a) => a.key === 'ag:' + k).level).toBe('major');
    await agentCall('POST', '/agent/v1/events', { events: [ev({ type: 'resolved', key: k, kind: 'security', severity: 'major' })] });
  });
});

describe('armada agen', () => {
  it('daftar semua server dengan status agen: mati dan belum terhubung di atas, hidup, lalu yang belum dipasang', async () => {
    const mk = async (name: string, host: string) => (await h.call('POST', '/api/servers', { key_path: '/k', name, host, username: 'ops' })).json.id as number;
    const a = await mk('srv-a-mati', '10.8.0.1'), b = await mk('srv-b-baru', '10.8.0.2'); await mk('srv-c-kosong', '10.8.0.3');
    const ca = (await h.call('POST', `/api/servers/${a}/agent`, {})).json, cb = (await h.call('POST', `/api/servers/${b}/agent`, {})).json;
    expect(ca.keyId).toBeTruthy(); expect(cb.keyId).toBeTruthy();
    await h.db.exec("UPDATE agents SET last_seen=$1, online=false, version='1.0' WHERE server_id=$2", [Date.now() - 600_000, a]);   // pernah terhubung, kini diam
    const rows = (await h.call('GET', '/api/agents')).json as Array<{ name: string; state: string; version: string; last_seen: number | null; open_keys: number }>;
    const state = Object.fromEntries(rows.map((r) => [r.name, r.state]));
    expect(state).toMatchObject({ 'srv-a-mati': 'mati', 'srv-b-baru': 'belum_terhubung', 'srv-c-kosong': 'belum_dipasang', 'srv-agen': 'hidup' });
    expect(rows.map((r) => r.state)).toEqual([...rows.map((r) => r.state)].sort((x, y) => ['mati', 'belum_terhubung', 'hidup', 'belum_dipasang'].indexOf(x) - ['mati', 'belum_terhubung', 'hidup', 'belum_dipasang'].indexOf(y)));
    expect(rows.find((r) => r.name === 'srv-a-mati')).toMatchObject({ version: '1.0', open_keys: 0 }); expect(JSON.stringify(rows)).not.toMatch(/secret/i);
  });
  it('API armada tetap butuh sesi', async () => { expect((await h.app.inject({ method: 'GET', url: '/api/agents', headers: { host: 'localhost' } })).statusCode).toBe(401); });
});
