// Monitoring: metrik resource, pemeriksaan layanan, peringatan, dan notifikasi (Telegram, ntfy, webhook, SMTP) ke penerima tiruan lokal.
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agent from '../src/agent.js';
import * as Checks from '../src/checks.js';
import * as Monitor from '../src/monitor.js';
import * as Notify from '../src/notify.js';
import * as Servers from '../src/servers.js';
import * as Store from '../src/store.js';
import { harness, login, sleep, until, type Harness } from './helpers.js';

const got = { telegram: [] as any[], ntfy: [] as any[], hook: [] as any[], mail: [] as any[] };
let h: Harness, recv: http.Server, smtp: net.Server, recvPort = 0, smtpPort = 0, sid = 0;
let batchOut: Record<string, { exitCode: number; stdout: string }> = {};
let resourceOut = 'load=0.1 0.1 0.1\nnproc=4\nmem_total_mb=8000\nmem_avail_pct=60\nswap_used_mb=0\ndisk_root_pct=40\nio_psi10=1\n';
const OK_OUT: Record<string, string> = { systemd: 'active', mysql_ping: 'mysqld is alive', nginx_conf: 'test is successful', redis_ping: 'PONG', ntp_sync: 'yes', zpool_health: 'all pools are healthy', docker_running: 'true', port: 'open', http: '200 0.010', fpm_status: '{"listen queue":0,"active processes":1,"total processes":2}', netdata_alarms: '{"alarms":{}}' };

const fakeExec = (handler?: (cmd: string) => object) => async (_s: unknown, cmd: string) => {
  if (cmd.includes('@@BEGIN')) {
    const ids = (cmd.match(/@@BEGIN \d+/g) ?? []).map((x) => x.split(' ')[1]!);
    const rows = await h.db.query('SELECT id, type FROM checks'); const type = new Map(rows.map((r) => [String(r.id), r.type as string]));
    return { exitCode: 0, stderr: '', ms: 1, timedOut: false, stdout: ids.map((id) => { const r = batchOut[id] ?? { exitCode: 0, stdout: OK_OUT[type.get(id) ?? ''] ?? '0' }; return `@@BEGIN ${id}\n${r.stdout}\n@@EXIT ${id} ${r.exitCode}`; }).join('\n') };
  }
  return { exitCode: 0, stdout: resourceOut, stderr: '', ms: 1, timedOut: false, ...(handler ? handler(cmd) : {}) };
};

beforeAll(async () => {
  recv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      if (req.url!.startsWith('/bot')) got.telegram.push({ url: req.url, body: JSON.parse(b) }); else if (req.url!.startsWith('/topik-rahasia')) got.ntfy.push({ headers: req.headers, body: b }); else if (req.url!.startsWith('/hook')) got.hook.push({ body: JSON.parse(b) });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => recv.listen(0, '127.0.0.1', () => r())); recvPort = (recv.address() as AddressInfo).port;
  smtp = net.createServer((s) => {
    let mode = 'cmd', buf = '', mail: any = { to: [], raw: '' }; s.setEncoding('utf8'); s.write('220 tiruan ESMTP\r\n');
    s.on('data', (d: string) => {
      buf += d;
      for (;;) {
        if (mode === 'data') { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; mail.raw = buf.slice(0, i); buf = buf.slice(i + 5); mode = 'cmd'; got.mail.push(mail); mail = { to: [], raw: '' }; s.write('250 diterima\r\n'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) s.write('250-tiruan\r\n250 AUTH PLAIN\r\n'); else if (/^AUTH PLAIN/i.test(line)) { mail.auth = Buffer.from(line.slice(11), 'base64').toString().replace(/\0/g, '|'); s.write('235 ok\r\n'); }
        else if (/^MAIL FROM/i.test(line)) s.write('250 ok\r\n'); else if (/^RCPT TO/i.test(line)) { mail.to.push(line); s.write('250 ok\r\n'); } else if (/^DATA/i.test(line)) { mode = 'data'; s.write('354 kirim\r\n'); } else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); return; } else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r())); smtpPort = (smtp.address() as AddressInfo).port;
  h = await harness(); await login(h);
  sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-uji', host: '10.9.9.9', username: 'ops', use_sudo: true })).json.id;
  Servers.setExec(fakeExec() as never);
});
afterAll(async () => { await Monitor.stop(); recv.close(); smtp.close(); await h.close(); });

const checksOf = async () => (await h.call('GET', `/api/servers/${sid}/checks`)).json as Array<{ id: number; type: string; name: string }>;
const by = async (type: string) => (await checksOf()).find((c) => c.type === type)!;
const openAlerts = async () => (await Monitor.alerts(sid, true)) as Array<{ key: string; level: string; source: string }>;

describe('paket dan peringatan layanan', () => {
  it('paket MySQL menambah 7 pemeriksaan dan tidak menggandakan saat diterapkan ulang', async () => {
    expect((await h.call('POST', `/api/servers/${sid}/packs`, { pack: 'mysql', opts: { unit: 'mysql' } })).json.added).toHaveLength(7);
    expect((await h.call('POST', `/api/servers/${sid}/packs`, { pack: 'mysql', opts: { unit: 'mysql' } })).json.added).toHaveLength(0);
    expect(Checks.buildCommand(await h.db.one('SELECT * FROM checks WHERE type=$1', ['mysql_longq']) as never)).toMatch(/sudo -n mysql/);
  });
  it('API menolak pemeriksaan kustom berbahaya dan menerima yang baca-saja', async () => {
    expect((await h.call('POST', `/api/servers/${sid}/checks`, { name: 'bahaya', type: 'custom', params: { command: 'rm -rf /tmp/x' } })).status).toBe(400);
    expect((await h.call('POST', `/api/servers/${sid}/checks`, { name: 'Beban kustom', type: 'custom', params: { command: 'cat /proc/loadavg' }, warn: 5, crit: 10 })).status).toBe(200);
  });

  it('konfirmasi 2x: gagal sekali belum jadi peringatan, dua kali jadi kritis bersumber layanan', async () => {
    const c = await by('mysql_commitwait'); batchOut = { [c.id]: { exitCode: 0, stdout: '42' } };
    const r1 = await Monitor.check(sid); expect(r1.ok).toBe(true); expect((r1 as any).checks.find((x: any) => x.id === c.id).status).toBe('crit');
    expect((await openAlerts()).some((a) => a.key === `chk:${c.id}`)).toBe(false);
    await Monitor.check(sid); const a = (await openAlerts()).find((x) => x.key === `chk:${c.id}`); expect(a?.level).toBe('critical'); expect(a?.source).toBe('service');
  });
  it('peringatan yang sama tidak digandakan dan indeks unik menjaganya', async () => {
    const before = (await openAlerts()).length; await Monitor.check(sid); expect((await openAlerts()).length).toBe(before);
    const c = await by('mysql_commitwait'); await expect(h.db.exec("INSERT INTO alerts(server_id,ts,level,key,title) VALUES($1,$2,'critical',$3,'dup')", [sid, Date.now(), `chk:${c.id}`])).rejects.toThrow(/duplicate|unik|unique/i);
  });
  it('layanan systemd mati: kritis pada pemeriksaan pertama; menonaktifkan menutup peringatan', async () => {
    const u = await by('systemd'); batchOut = { [u.id]: { exitCode: 3, stdout: 'inactive' } }; await Monitor.check(sid);
    expect((await openAlerts()).some((a) => a.key === `chk:${u.id}` && a.level === 'critical')).toBe(true);
    await h.call('PUT', `/api/checks/${u.id}`, { enabled: false }); expect((await openAlerts()).some((a) => a.key === `chk:${u.id}`)).toBe(false);
    await h.call('PUT', `/api/checks/${u.id}`, { enabled: true }); batchOut = {};
  });
  it('pemulihan menutup peringatan otomatis', async () => { batchOut = {}; await Monitor.check(sid); expect(await openAlerts()).toHaveLength(0); });
  it('server tidak terjangkau tercatat kritis', async () => {
    Servers.setExec((async () => ({ exitCode: 255, stdout: '', stderr: 'ssh: connect to host: Connection timed out', ms: 1, timedOut: false })) as never);
    const r = await Monitor.check(sid); expect(r.ok).toBe(false); expect((await h.call('GET', '/api/overview')).json.servers[0].status).toBe('tidak terjangkau'); expect((await openAlerts()).some((a) => a.key === 'unreachable')).toBe(true);
    Servers.setExec(fakeExec() as never); await Monitor.check(sid); expect(await openAlerts()).toHaveLength(0);
  });
  it('deteksi otomatis menyarankan paket dari layanan yang berjalan', async () => {
    Servers.setExec((async () => ({ exitCode: 0, stderr: '', ms: 1, timedOut: false, stdout: 'unit=nginx.service\nunit=php8.3-fpm.service\nunit=mariadb.service\nlisten=0.0.0.0:80\nfpmlog=php8.3-fpm.log\n' })) as never);
    const d = (await h.call('POST', `/api/servers/${sid}/discover`)).json; expect(d.mysql.opts.unit).toBe('mariadb'); expect(d.phpfpm.opts.log).toBe('/var/log/php8.3-fpm.log'); expect(d.laravel).toBeUndefined(); expect(d.postgres).toBeUndefined();
    Servers.setExec(fakeExec() as never);
  });
  it('analisis memakai peran monitor dan tersimpan sebagai laporan', async () => {
    await h.call('POST', '/api/provider', { id: 'lain', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }); await h.call('POST', '/api/role', { role: 'monitor', provider: 'lain', model: 'm-murah' });
    Monitor.configure({ llm: (async (role: string) => { await Store.addUsage({ role, provider: 'lain', model: 'm-murah', input: 300, output: 80 }); return { text: 'Sehat. Perhatikan swap.', usage: { input: 300, output: 80 } }; }) as never });
    const r = await h.call('POST', `/api/servers/${sid}/analyze`); expect(r.json.text).toMatch(/Sehat/); expect((await Store.summary(1)).byRole.monitor!.input).toBe(300);
  });
});

describe('notifikasi', () => {
  it('daftar kanal tidak membocorkan token/sandi dan menolak konfigurasi tak lengkap', async () => {
    await Notify.save({ type: 'webhook', name: 'Slack uji', min_level: 'critical', config: { url: `http://127.0.0.1:${recvPort}/hook/slack`, format: 'slack' } });
    await Notify.save({ type: 'telegram', name: 'Telegram uji', min_level: 'critical', config: { token: '123:ABCDEF', chatId: '777', apiBase: `http://127.0.0.1:${recvPort}` } });
    await Notify.save({ type: 'ntfy', name: 'ntfy uji', min_level: 'major', config: { url: `http://127.0.0.1:${recvPort}`, topic: 'topik-rahasia' } });
    await Notify.save({ type: 'email', name: 'Email uji', min_level: 'critical', config: { host: '127.0.0.1', port: String(smtpPort), secure: 'none', user: 'akun', pass: 'sandi-email', from: 'aiops@contoh.id', to: 'saya@contoh.id, lain@contoh.id' } });
    const raw = JSON.stringify((await h.call('GET', '/api/channels')).json); expect(raw).not.toContain('123:ABCDEF'); expect(raw).not.toContain('sandi-email');
    expect((await h.call('POST', '/api/channels', { type: 'ntfy', name: 'x', config: { topic: 'a' } })).status).toBe(400); expect((await h.call('POST', '/api/channels', { type: 'telegram', name: 'x', config: { token: 't' } })).status).toBe(400);
  });

  it('kritis dikirim ke webhook, Telegram, ntfy (prioritas 5), dan email (SMTP, AUTH, dua penerima, UTF-8)', async () => {
    const c = await by('mysql_commitwait'); batchOut = { [c.id]: { exitCode: 0, stdout: '42' } }; await Monitor.check(sid); await Monitor.check(sid);
    await until(() => got.hook.length && got.telegram.length && got.ntfy.length && got.mail.length, 6000);
    expect(got.hook).toHaveLength(1); expect(got.hook[0].body.text).toMatch(/CRITICAL/);
    expect(got.telegram).toHaveLength(1); expect(got.telegram[0].body.chat_id).toBe('777'); expect(got.telegram[0].url).toMatch(/^\/bot123:ABCDEF\/sendMessage/);
    expect(got.ntfy).toHaveLength(1); expect(got.ntfy[0].headers.priority).toBe('5'); expect(got.ntfy[0].body).toMatch(/42/);
    const m = got.mail[0]; const subj = Buffer.from((m.raw.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/) ?? [])[1] ?? '', 'base64').toString(), body = Buffer.from(m.raw.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString();
    expect(subj).toMatch(/CRITICAL/); expect(body).toMatch(/42/); expect(m.to).toHaveLength(2); expect(m.auth).toBe('|akun|sandi-email');
    await Monitor.check(sid); await sleep(150); expect(got.hook).toHaveLength(1);
  });
  it('level rendah hanya sampai ke kanal dengan level minimum "peringatan"', async () => {
    const lq = await by('mysql_longq'); batchOut[lq.id] = { exitCode: 0, stdout: '5' }; await Monitor.check(sid); await Monitor.check(sid); await sleep(300);
    expect(got.ntfy).toHaveLength(2); expect(got.hook).toHaveLength(1); expect(got.telegram).toHaveLength(1);
  });
  it('pemulihan dikabari ke kanal yang pernah dikabari', async () => {
    batchOut = {}; await Monitor.check(sid); await until(() => got.hook.length === 2, 4000); expect(got.hook[1].body.text).toMatch(/RESOLVED/); expect(await openAlerts()).toHaveLength(0);
  });
  it('pengingat bila kritis belum dilihat, berhenti setelah ditandai dilihat; klaim atomik mencegah ganda', async () => {
    const c = await by('mysql_commitwait'); batchOut = { [c.id]: { exitCode: 0, stdout: '50' } }; await Monitor.check(sid); await Monitor.check(sid); await until(() => got.hook.length === 3, 4000);
    await h.db.exec("UPDATE alerts SET notified_ts=$1 WHERE NOT resolved", [Date.now() - 5 * 60_000]); await h.call('POST', '/api/settings', { reminder_min: 1 });
    await Promise.all([Notify.reminders(), Notify.reminders(), Notify.reminders()]); await until(() => got.hook.length >= 4, 4000); await sleep(300);
    expect(got.hook).toHaveLength(4); expect(got.hook[3].body.text).toMatch(/pengingat/);
    const al = (await openAlerts())[0] as any; await h.call('POST', `/api/alerts/${al.id}/ack`); await h.db.exec('UPDATE alerts SET notified_ts=$1 WHERE NOT resolved', [Date.now() - 5 * 60_000]); await Notify.reminders(); await sleep(250); expect(got.hook).toHaveLength(4);
  });
  it('permintaan persetujuan perintah agen dikirim ke kanal', async () => {
    await Store.setRole('setup', 'lain', 'm');
    Agent.configure({ llm: (async (role: string, req: { run?: string }) => { await Store.addUsage({ role, provider: 'lain', model: 'm', input: 10, output: 5, run: req.run }); return { text: JSON.stringify({ thought: 'ubah', command: 'systemctl restart nginx', purpose: 'restart' }), usage: { input: 10, output: 5 } }; }) as never });
    Servers.setExec(fakeExec(() => ({ stdout: 'ok' })) as never);
    const run = await Store.newRun({ name: 'Uji persetujuan', serverId: sid, goal: 'restart' }); await Agent.start(run.id);
    expect(await until(() => got.hook.some((x) => /PERSETUJUAN/.test(x.body.text) && /systemctl restart nginx/.test(x.body.text)), 5000)).toBeTruthy(); await Agent.stop(run.id);
  });
  it('kirim uji menjangkau penerima dan riwayat tercatat', async () => {
    const ch = (await h.call('GET', '/api/channels')).json.find((c: any) => c.name === 'ntfy uji'); got.ntfy.length = 0;
    expect((await h.call('POST', `/api/channels/${ch.id}/test`)).json.ok).toBe(true); expect(got.ntfy.some((n) => /uji berhasil/i.test(n.body))).toBe(true);
    expect((await h.call('GET', '/api/notifications')).json.some((n: any) => n.kind === 'alert' && n.ok === true)).toBe(true);
  });
  it('kegagalan pengiriman dicatat (tidak melempar) dan terlihat di riwayat', async () => {
    await Notify.save({ type: 'webhook', name: 'Mati', min_level: 'info', config: { url: 'http://127.0.0.1:1/hook' } });
    const res = await Notify.dispatch({ kind: 'uji', level: 'info', importance: 1, title: 'x', text: 'y' }); expect(res.some((r) => !r.ok)).toBe(true);
    expect((await Notify.history()).some((n) => n.channel_name === 'Mati' && n.ok === false && n.error)).toBe(true);
  });
});
