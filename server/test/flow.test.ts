// Alur utama: penyedia/peran/token, inventaris server, dan agen setup (persetujuan, blokir, tolak, anggaran). Tanpa SSH/model sungguhan.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agent from '../src/agent.js';
import { open } from '../src/crypto.js';
import * as Servers from '../src/servers.js';
import * as Store from '../src/store.js';
import { harness, login, until, type Harness } from './helpers.js';

let h: Harness, mock: http.Server, mockPort = 0;
const sshLog: string[] = [];
const exec = (script: (cmd: string) => Partial<{ exitCode: number; stdout: string; stderr: string }>) => async (_s: unknown, cmd: string) => { sshLog.push(cmd); return { exitCode: 0, stdout: '', stderr: '', ms: 1, timedOut: false, ...script(cmd) }; };
const fakeLLM = (replies: object[], tokens = 100) => { let i = 0; return async (role: string, req: { run?: string | null }) => { const text = JSON.stringify(replies[Math.min(i++, replies.length - 1)]); await Store.addUsage({ role, provider: 'tiruan', model: 'm-kuat', input: tokens, output: 50, run: req.run }); return { text, usage: { input: tokens, output: 50 } }; }; };

beforeAll(async () => {
  mock = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'm-kuat' }, { id: 'm-murah' }] }));
      if (req.url!.endsWith('/chat/completions')) { if (req.headers.authorization !== 'Bearer KEY-RAHASIA-1234') { res.statusCode = 401; return res.end('{"error":{"message":"key salah"}}'); } return res.end(JSON.stringify({ choices: [{ message: { content: 'siap' } }], usage: { prompt_tokens: 21, completion_tokens: 3 } })); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r())); mockPort = (mock.address() as AddressInfo).port;
  h = await harness(); await login(h);
});
afterAll(async () => { mock.close(); await h.close(); });

describe('penyedia, peran, token', () => {
  it('menyimpan penyedia dan tidak pernah membocorkan key lengkap', async () => {
    await h.call('POST', '/api/provider', { id: 'tiruan', label: 'Tiruan', type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: 'KEY-RAHASIA-1234' });
    await h.call('POST', '/api/provider', { id: 'lain', label: 'Lain', type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: 'KEY-SALAH' });
    const raw = JSON.stringify((await h.call('GET', '/api/config')).json); expect(raw).not.toContain('KEY-RAHASIA'); expect(raw).toContain('1234');
    const row = await h.db.one('SELECT api_key_enc FROM providers WHERE id=$1', ['tiruan']); expect(row!.api_key_enc).not.toContain('KEY-RAHASIA');
  });
  it('mengambil daftar model', async () => expect((await h.call('POST', '/api/models', { id: 'tiruan' })).json.models).toHaveLength(2));
  it('dua peran memakai penyedia berbeda dan token tercatat per peran', async () => {
    await h.call('POST', '/api/role', { role: 'setup', provider: 'tiruan', model: 'm-kuat' }); await h.call('POST', '/api/role', { role: 'monitor', provider: 'lain', model: 'm-murah' });
    const ok = await h.call('POST', '/api/test', { role: 'setup' }); expect(ok.json.usage).toEqual({ input: 21, output: 3 });
    const bad = await h.call('POST', '/api/test', { role: 'monitor' }); expect(bad.status).toBe(502); expect(bad.json.error).toMatch(/key salah/);
  });
  it('biaya dihitung dari harga per juta token', async () => {
    await h.call('POST', '/api/price', { provider: 'tiruan', model: 'm-kuat', in: 3, out: 15 });
    const u = (await h.call('GET', '/api/usage?days=30')).json; expect(u.byRole.setup.input).toBe(21); expect(u.byModel['tiruan/m-kuat'].cost).toBeCloseTo((21 * 3 + 3 * 15) / 1e6, 12);
  });
  it('DELETE/POST dengan Content-Type JSON tetapi tanpa badan diterima (perilaku UI)', async () => {
    const r = await h.app.inject({ method: 'DELETE', url: '/api/provider/tidak-ada', headers: { host: 'localhost', cookie: h.cookie, 'x-aiops': '1', 'content-type': 'application/json' } }); expect(r.statusCode).toBe(200);
    const bad = await h.app.inject({ method: 'POST', url: '/api/provider', headers: { host: 'localhost', cookie: h.cookie, 'x-aiops': '1', 'content-type': 'application/json' }, payload: '{rusak' }); expect(bad.statusCode).toBe(400);
  });
  it('validasi body: id penyedia tidak valid ditolak', async () => expect((await h.call('POST', '/api/provider', { id: 'ID Salah!', apiKey: 'x' })).status).toBe(400));
});

describe('inventaris server', () => {
  let sid = 0;
  it('menolak host berbahaya, nama layanan berbahaya, dan nama ganda', async () => {
    expect((await h.call('POST', '/api/servers', { key_path: '/k', name: 'x', host: 'a b;rm', username: 'root' })).status).toBe(400);
    const r = await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-db', host: '10.0.0.5', username: 'ops', use_sudo: true, services: 'mysql,nginx' }); expect(r.status).toBe(200); sid = r.json.id;
    expect((await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-db', host: '10.0.0.6', username: 'ops' })).status).toBe(400);
    expect((await h.call('POST', '/api/servers', { key_path: '/k', name: 'b', host: '10.0.0.7', username: 'ops', services: 'mysql;halt' })).status).toBe(400);
  });
  it('kunci privat disimpan terenkripsi dan tidak pernah dikembalikan', async () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAKUNCIRAHASIA\n-----END OPENSSH PRIVATE KEY-----';
    const r = await h.call('PUT', `/api/servers/${sid}`, { ssh_key: pem }); expect(r.status).toBe(200); expect(r.json.has_ssh_key).toBe(true); expect(JSON.stringify(r.json)).not.toContain('AAAAKUNCIRAHASIA');
    const raw = await h.db.one('SELECT ssh_key_enc FROM servers WHERE id=$1', [sid]); expect(raw!.ssh_key_enc).not.toContain('KUNCIRAHASIA');
    expect(JSON.stringify((await h.call('GET', '/api/servers')).json)).not.toContain('KUNCIRAHASIA');
    expect((await h.call('PUT', `/api/servers/${sid}`, { ssh_key: 'bukan kunci' })).status).toBe(400);
  });
  it('uji koneksi membaca info OS', async () => {
    Servers.setExec(exec((c) => (/uname/.test(c) ? { stdout: 'Linux 6.1 x86_64\nDebian GNU/Linux 12\ncpu=4\nram_mb=8000\n' } : {})) as never);
    const r = await h.call('POST', `/api/servers/${sid}/test`); expect(r.json.ok).toBe(true); expect(r.json.info).toMatch(/Debian/);
  });
});

describe('agen setup', () => {
  let sid = 0;
  beforeAll(async () => { sid = (await h.call('GET', '/api/servers')).json[0].id; });

  it('validasi pembuatan run', async () => {
    expect((await h.call('POST', '/api/runs', { serverId: sid })).status).toBe(400);
    expect((await h.call('POST', '/api/runs', { serverId: 99999, goal: 'x' })).status).toBe(400);
    const r = await h.call('POST', '/api/runs', { serverId: sid, template: 'diagnosis' }); expect(r.status).toBe(200); expect(r.json.steps).toHaveLength(5);
    expect((await h.call('POST', '/api/steps', { run: r.json.id, step: 99, status: 'done' })).status).toBe(400);
  });
  it('analisis folder proyek dimatikan tanpa PROJECTS_ROOT', async () => {
    const r = await h.call('POST', '/api/runs', { serverId: sid, dir: '/etc' }); expect(r.status).toBe(400); expect(r.json.error).toMatch(/PROJECTS_ROOT/);
  });

  it('baca otomatis, ubah menunggu persetujuan, blokir tidak pernah terkirim, lalu selesai', async () => {
    Agent.configure({ llm: fakeLLM([
      { thought: 'cek beban', command: 'uptime', purpose: 'lihat load', steps: [{ n: 1, status: 'running' }] },
      { thought: 'ubah swappiness', command: 'sysctl -w vm.swappiness=10', purpose: 'kurangi swap' },
      { thought: 'coba reboot', command: 'reboot', purpose: 'terapkan' },
      { thought: 'selesai', command: '', done: true, summary: 'swappiness diubah ke 10' }]) as never });
    sshLog.length = 0; Servers.setExec(exec((c) => (c === 'uptime' ? { stdout: ' 10:00 up 3 days, load average: 0.1' } : /sysctl -w/.test(c) ? { stdout: 'vm.swappiness = 10' } : { stdout: 'ok' })) as never);
    const run = (await h.call('POST', '/api/runs', { serverId: sid, template: 'diagnosis', goal: 'turunkan swappiness' })).json;
    expect((await h.call('POST', `/api/runs/${run.id}/start`)).status).toBe(200);
    expect(await until(async () => (await Store.getRun(run.id))!.status === 'waiting_approval')).toBeTruthy();
    expect(sshLog).toEqual(['uptime']);
    let det = (await h.call('GET', `/api/runs/${run.id}`)).json; const pend = det.commands.find((c: any) => c.status === 'pending_approval');
    expect(pend.class).toBe('change'); expect(det.run.steps[0].status).toBe('running');
    expect((await h.call('POST', `/api/commands/${pend.id}/approve`)).status).toBe(200);
    expect(await until(async () => (await Store.getRun(run.id))!.status === 'done')).toBeTruthy();
    expect(sshLog).toContain('sysctl -w vm.swappiness=10'); expect(sshLog).not.toContain('reboot');
    det = (await h.call('GET', `/api/runs/${run.id}`)).json; expect(det.commands.some((c: any) => c.command === 'reboot' && c.status === 'blocked')).toBe(true); expect(det.run.tokens).toBe(4 * 150); expect(det.run.summary).toMatch(/swappiness/);
    expect(Number((await h.db.one("SELECT COUNT(*)::int AS c FROM audit WHERE action='perintah.setuju'"))!.c)).toBeGreaterThanOrEqual(1);
  });

  it('persetujuan tidak bisa dijalankan dua kali walau dikirim bersamaan', async () => {
    Agent.configure({ llm: fakeLLM([{ thought: 'x', command: 'systemctl reload nginx', purpose: 'reload' }, { thought: 'ok', command: '', done: true, summary: 'selesai' }]) as never });
    sshLog.length = 0; Servers.setExec(exec(() => ({ stdout: 'ok' })) as never);
    const run = (await h.call('POST', '/api/runs', { serverId: sid, goal: 'uji ganda' })).json; await h.call('POST', `/api/runs/${run.id}/start`);
    await until(async () => (await Store.getRun(run.id))!.status === 'waiting_approval');
    const cmd = (await h.db.one("SELECT id FROM commands WHERE run_id=$1 AND status='pending_approval'", [run.id]))!;
    const rs = await Promise.all([1, 2, 3, 4].map(() => h.call('POST', `/api/commands/${cmd.id}/approve`))); await until(async () => (await Store.getRun(run.id))!.status === 'done');
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1); expect(sshLog.filter((c) => c === 'systemctl reload nginx')).toHaveLength(1);
  });

  it('penolakan diteruskan ke agen dan perintah tidak dijalankan', async () => {
    Agent.configure({ llm: fakeLLM([{ thought: 'x', command: 'systemctl restart mysql', purpose: 'restart' }, { thought: 'tanpa restart', command: '', done: true, summary: 'tidak ada perubahan' }]) as never });
    sshLog.length = 0;
    const run = (await h.call('POST', '/api/runs', { serverId: sid, goal: 'uji tolak' })).json; await h.call('POST', `/api/runs/${run.id}/start`);
    await until(async () => (await Store.getRun(run.id))!.status === 'waiting_approval');
    const cmd = (await h.db.one("SELECT id FROM commands WHERE run_id=$1 AND status='pending_approval'", [run.id]))!;
    await h.call('POST', `/api/commands/${cmd.id}/reject`, { reason: 'jangan restart saat jam kerja' });
    expect(await until(async () => (await Store.getRun(run.id))!.status === 'done')).toBeTruthy(); expect(sshLog).not.toContain('systemctl restart mysql');
  });

  it('berhenti saat anggaran token habis', async () => {
    Agent.configure({ llm: fakeLLM([{ thought: 'terus', command: 'uptime', purpose: 'loop' }], 4000) as never });
    const run = (await h.call('POST', '/api/runs', { serverId: sid, goal: 'uji anggaran', tokenBudget: 9000 })).json; await h.call('POST', `/api/runs/${run.id}/start`);
    const d = await until(async () => { const r = (await Store.getRun(run.id))!; return ['stopped', 'done', 'failed'].includes(r.status) ? r : null; }); expect(d!.status).toBe('stopped'); expect(d!.summary).toMatch(/Anggaran/);
  });
  it('balasan model tidak valid berulang membuat run gagal, bukan berputar selamanya', async () => {
    Agent.configure({ llm: fakeLLM([{ thought: 'tidak jelas' }]) as never });
    const run = (await h.call('POST', '/api/runs', { serverId: sid, goal: 'uji format' })).json; await h.call('POST', `/api/runs/${run.id}/start`);
    expect(await until(async () => (await Store.getRun(run.id))!.status === 'failed')).toBeTruthy();
  });
  it('menghentikan run yang menunggu persetujuan menolak perintahnya', async () => {
    Agent.configure({ llm: fakeLLM([{ thought: 'x', command: 'systemctl restart nginx', purpose: 'r' }]) as never });
    const run = (await h.call('POST', '/api/runs', { serverId: sid, goal: 'uji henti' })).json; await h.call('POST', `/api/runs/${run.id}/start`);
    await until(async () => (await Store.getRun(run.id))!.status === 'waiting_approval'); await h.call('POST', `/api/runs/${run.id}/stop`);
    expect((await Store.getRun(run.id))!.status).toBe('stopped'); expect(await h.db.one("SELECT 1 AS x FROM commands WHERE run_id=$1 AND status='pending_approval'", [run.id])).toBeUndefined();
  });
});

describe('SSH key wajib', () => {
  it('server tanpa kunci (tempel atau path) ditolak; dengan kunci diterima; ubah tanpa mengirim kunci mempertahankan yang lama', async () => {
    const h = await harness(); await login(h);
    try {
      const r = await h.call('POST', '/api/servers', { name: 'tanpa-kunci', host: '10.7.7.7', username: 'ops' });
      expect(r.status).toBe(400); expect(r.json.error).toContain('Kunci SSH wajib');
      const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
      const ok = await h.call('POST', '/api/servers', { name: 'dengan-kunci', host: '10.7.7.8', username: 'ops', ssh_key: pem });
      expect(ok.status).toBe(200); expect(ok.json.has_ssh_key).toBe(true);
      expect((await h.call('PUT', `/api/servers/${ok.json.id}`, { notes: 'ubah catatan saja' })).status).toBe(200);
      expect((await h.call('POST', '/api/servers', { name: 'dengan-path', host: '10.7.7.9', username: 'ops', key_path: '/run/secrets/ssh_key' })).status).toBe(200);
    } finally { await h.close(); }
  });
});

const hasKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;
describe.skipIf(!hasKeygen)('kunci SSH dibuat oleh aplikasi', () => {
  it('pasangan kunci dibuat, privat tersimpan terenkripsi dan tak pernah keluar, publik bisa ditampilkan dan cocok dengan privatnya', async () => {
    const h = await harness(); await login(h);
    try {
      const r = await h.call('POST', '/api/servers', { name: 'kunci-otomatis', host: '10.8.8.8', username: 'aiops', generate_key: true });
      expect(r.status).toBe(200); expect(r.json.has_ssh_key).toBe(true); expect(r.json.ssh_pub).toMatch(/^ssh-ed25519 \S+ aiops-kunci-otomatis$/);
      expect(JSON.stringify(r.json)).not.toContain('PRIVATE KEY'); expect(JSON.stringify((await h.call('GET', '/api/servers')).json)).not.toContain('PRIVATE KEY');
      const row = await h.db.one<{ ssh_key_enc: string; ssh_pub: string }>('SELECT ssh_key_enc, ssh_pub FROM servers WHERE id=$1', [r.json.id]);
      expect(row!.ssh_key_enc).not.toContain('OPENSSH');
      const pem = open(row!.ssh_key_enc); expect(pem).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
      const dir = mkdtempSync(join(tmpdir(), 'cek-')), f = join(dir, 'k'); writeFileSync(f, pem + '\n', { mode: 0o600 });
      const derived = spawnSync('ssh-keygen', ['-y', '-f', f], { encoding: 'utf8' }).stdout.trim();
      expect(row!.ssh_pub.split(' ').slice(0, 2).join(' ')).toBe(derived.split(' ').slice(0, 2).join(' '));   // publik memang pasangan dari privat yang tersimpan
      const again = await h.call('POST', '/api/servers', { name: 'kunci-otomatis-2', host: '10.8.8.9', username: 'aiops', generate_key: true });
      expect(again.json.ssh_pub).not.toBe(r.json.ssh_pub);   // tiap server kunci sendiri
      const pasted = await h.call('PUT', `/api/servers/${r.json.id}`, { ssh_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----' });
      expect(pasted.json.ssh_pub).toBe('');   // diganti kunci tempelan: publik lama tidak berlaku lagi
    } finally { await h.close(); }
  });
});

describe('penjelasan galat SSH', () => {
  it('galat umum diterjemahkan jadi saran; yang tidak dikenali kosong', () => {
    expect(Servers.explainSshError('ubuntu@10.0.0.1: Permission denied (publickey,keyboard-interactive).', 'ubuntu')).toMatch(/authorized_keys milik pengguna "ubuntu".*journalctl/);
    expect(Servers.explainSshError('Permission denied (publickey).', 'ubuntu', 'SHA256:abc')).toMatch(/Kunci yang ditawarkan aplikasi: SHA256:abc\. Di server, jalankan: ssh-keygen -lf ~\/\.ssh\/authorized_keys/);
    expect(Servers.fingerprintOf('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMIS aiops-x')).toMatch(/^SHA256:[A-Za-z0-9+/]+$/); expect(Servers.fingerprintOf('rusak')).toBe('');
    expect(Servers.explainSshError('ssh: connect to host 10.0.0.1 port 22: Connection refused', 'x')).toMatch(/Port SSH ditolak/);
    expect(Servers.explainSshError('Connection timed out during banner exchange', 'x')).toMatch(/tidak terjangkau/);
    expect(Servers.explainSshError('ssh: Could not resolve hostname abc', 'x')).toMatch(/tidak dikenali/);
    expect(Servers.explainSshError('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'x')).toMatch(/Sidik jari/);
    expect(Servers.explainSshError('Load key "/tmp/id": error in libcrypto', 'x')).toMatch(/tidak terbaca/);
    expect(Servers.explainSshError('galat aneh', 'x')).toBe('');
  });
  it('uji koneksi yang ditolak kunci mengembalikan saran', async () => {
    const h = await harness(); await login(h);
    try {
      const s = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'tolak-kunci', host: '10.6.6.6', username: 'ubuntu' })).json;
      Servers.setExec((async () => ({ exitCode: 255, stdout: '', stderr: 'ubuntu@10.6.6.6: Permission denied (publickey,keyboard-interactive).', ms: 5, timedOut: false })) as never);
      const r = (await h.call('POST', `/api/servers/${s.id}/test`)).json;
      expect(r.ok).toBe(false); expect(r.error).toContain('Permission denied'); expect(r.hint).toContain('authorized_keys milik pengguna "ubuntu"');
    } finally { Servers.setExec(); await h.close(); }
  });
});

describe.skipIf(!hasKeygen)('komentar kunci buatan aplikasi aman', () => {
  it('nama server dengan tanda kutip atau karakter shell tidak masuk ke komentar kunci publik', async () => {
    const h = await harness(); await login(h);
    try {
      const r = await h.call('POST', '/api/servers', { name: "db'; rm -rf ~ #", host: '10.5.5.5', username: 'aiops', generate_key: true });
      expect(r.status).toBe(200); expect(r.json.ssh_pub).toMatch(/^ssh-ed25519 \S+ aiops-[A-Za-z0-9._-]+$/); expect(r.json.ssh_pub).not.toMatch(/['";&|$` ]#/);
    } finally { await h.close(); }
  });
});
