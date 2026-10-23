import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Scan from '../src/checks-scan.js';
import * as Servers from '../src/servers.js';
import { harness, login, type Harness } from './helpers.js';

const SCAN_OUT = ['unit=mysql.service', 'unit=nginx.service', 'unit=kafka.service', 'unit=aplikasi-kustom.service', 'unit=systemd-journald.service', 'unit=ssh.service', 'unit=bad name.service',
  'listen=0.0.0.0:3306', 'listen=127.0.0.1:5672', 'listen=[::]:8080', 'listen=0.0.0.0:3306', 'cmd=docker'].join('\n');

describe('pemindaian layanan', () => {
  it('semua layanan terbaca (bukan hanya yang dikenal); yang dikenal bertanda paket, yang bising ditandai; port unik dan terurut; nama aneh dibuang', () => {
    const r = Scan.parseScan(SCAN_OUT);
    expect(r.services.map((s) => s.unit)).toEqual(['aplikasi-kustom', 'kafka', 'mysql', 'nginx', 'ssh', 'systemd-journald']);
    const by = (u: string) => r.services.find((s) => s.unit === u)!;
    expect(by('mysql').pack).toBe('mysql'); expect(by('nginx').pack).toBe('nginx'); expect(by('kafka').pack).toBeNull(); expect(by('aplikasi-kustom')).toMatchObject({ pack: null, noise: false });
    expect(by('systemd-journald').noise).toBe(true); expect(by('ssh').noise).toBe(true);
    expect(r.ports).toEqual([3306, 5672, 8080]);
  });
});

describe('scan, coba, dan saran lewat API', () => {
  let h: Harness, sid: number; const ran: string[] = [];
  let reply = (cmd: string): { exitCode: number; stdout: string; stderr?: string } => ({ exitCode: 0, stdout: '' });
  beforeAll(async () => {
    h = await harness(); await login(h);
    Servers.setExec((async (_s: unknown, cmd: string) => { ran.push(cmd); const r = reply(cmd); return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '', ms: 4, timedOut: false }; }) as never);
    sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-scan', host: '10.4.4.4', username: 'ops' })).json.id;
  });
  afterAll(async () => { Servers.setExec(); await h.close(); });

  it('GET scan mengembalikan layanan dan port dari server', async () => {
    reply = () => ({ exitCode: 0, stdout: SCAN_OUT });
    const r = await h.call('GET', `/api/servers/${sid}/scan`); expect(r.status).toBe(200); expect(r.json.services.find((s: { unit: string }) => s.unit === 'kafka')).toMatchObject({ pack: null }); expect(r.json.ports).toContain(5672);
    reply = () => ({ exitCode: 255, stdout: '', stderr: 'Permission denied (publickey).' }); expect((await h.call('GET', `/api/servers/${sid}/scan`)).status).toBe(400);
  });

  it('Coba: menjalankan sekali tanpa menyimpan; menampilkan perintah, keluaran, dan penilaian', async () => {
    reply = () => ({ exitCode: 0, stdout: '42\n' }); ran.length = 0;
    const r = await h.call('POST', `/api/servers/${sid}/checks/try`, { type: 'custom', params: { command: 'cat /proc/loadavg | cut -d" " -f1' }, warn: 10, crit: 40 });
    expect(r.status).toBe(200); expect(r.json).toMatchObject({ command: 'cat /proc/loadavg | cut -d" " -f1', exitCode: 0, stdout: '42\n', evaluation: { status: 'crit', value: 42 } }); expect(ran).toHaveLength(1);
    expect((await h.call('GET', `/api/servers/${sid}/checks`)).json).toEqual([]);   // tidak ada yang tersimpan
  });
  it('Coba: perintah yang mengubah sesuatu ditolak sebelum dijalankan; perintah gagal dinilai tidak terbaca dengan galatnya', async () => {
    ran.length = 0;
    const bad = await h.call('POST', `/api/servers/${sid}/checks/try`, { type: 'custom', params: { command: 'rm -rf /tmp/x' } }); expect(bad.status).toBe(400); expect(ran).toHaveLength(0);
    reply = () => ({ exitCode: 1, stdout: 'ERROR 1045 (28000): Access denied', stderr: '' });
    const r = await h.call('POST', `/api/servers/${sid}/checks/try`, { type: 'custom', params: { command: 'mysqladmin ping' } }); expect(r.json.evaluation).toMatchObject({ status: 'unknown', value: null }); expect(r.json.exitCode).toBe(1);
    expect((await h.call('POST', `/api/servers/${sid}/checks/try`, { type: 'tidak-ada', params: {} })).status).toBe(400);
  });

  it('Saran AI: ditolak tanpa model; hanya unit yang diminta; perintah non baca-saja ditandai ditolak; tidak ada yang tersimpan', async () => {
    reply = () => ({ exitCode: 0, stdout: SCAN_OUT });
    expect((await h.call('POST', `/api/servers/${sid}/checks/suggest`, {})).status).toBe(400);   // belum ada model
    await h.call('POST', '/api/provider', { id: 'lain', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }); await h.call('POST', '/api/role', { role: 'monitor', provider: 'lain', model: 'm' });
    let prompt = '';
    Scan.configure({ llm: (async (_r: string, req: { messages: Array<{ content: string }> }) => {
      prompt = req.messages[0]!.content;
      return { text: 'Ini: ' + JSON.stringify({ suggestions: [
        { unit: 'kafka', title: 'Antrean Kafka', command: 'systemctl is-active kafka', why: 'aktif' },
        { unit: 'aplikasi-kustom', title: 'Hapus log', command: 'rm -rf /var/log/aplikasi', why: 'jahat' },
        { unit: 'mysql', title: 'bukan diminta', command: 'systemctl is-active mysql', why: '' }
      ] }), usage: { input: 1, output: 1 } };
    }) as never });
    const r = await h.call('POST', `/api/servers/${sid}/checks/suggest`, {}); expect(r.status).toBe(200);
    expect(prompt).toContain('kafka'); expect(prompt).toContain('aplikasi-kustom'); expect(prompt).not.toContain('systemd-journald'); expect(prompt).not.toMatch(/Layanan berjalan[^\n]*\bmysql\b/);   // yang sudah punya paket dan yang bising tidak dikirim
    const s = r.json.suggestions as Array<{ unit: string; readOnly: boolean; problem: string }>;
    expect(s.map((x) => x.unit)).toEqual(['kafka', 'aplikasi-kustom']);   // 'mysql' tidak diminta: dibuang
    expect(s[0]).toMatchObject({ readOnly: true, problem: '' }); expect(s[1]!.readOnly).toBe(false); expect(s[1]!.problem).toContain('Ditolak');
    expect((await h.call('GET', `/api/servers/${sid}/checks`)).json).toEqual([]);
  });
});
