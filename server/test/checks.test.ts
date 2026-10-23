import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import * as Checks from '../src/checks.js';

const ev = (type: string, o: object, res: object) => Checks.evaluate({ type, params: {}, warn: null, crit: null, dir: 'gt', delta: false, last_raw: null, ...o } as never, { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...res });
const build = (type: string, params: object) => Checks.buildCommand({ type, params });

describe('templat dan validasi', () => {
  it('membangun perintah systemd dari templat', () => expect(build('systemd', { unit: 'php8.2-fpm' })).toBe('systemctl is-active php8.2-fpm'));
  it('menolak nama unit berbahaya', () => expect(() => build('systemd', { unit: 'x; rm -rf /' })).toThrow());
  it('menolak URL dengan spasi atau $()', () => { expect(() => build('http', { url: 'http://a/ b' })).toThrow(); expect(() => build('http', { url: 'http://a/$(id)' })).toThrow(); });
  it('perintah kustom: hanya baca-saja', () => { expect(() => build('custom', { command: 'systemctl restart nginx' })).toThrow(); expect(build('custom', { command: 'cat /proc/loadavg' })).toBe('cat /proc/loadavg'); });
  it('SQL kustom: menolak penulisan dan tanda kutip ganda', () => { expect(() => build('mysql_sql', { sql: 'DELETE FROM t' })).toThrow(); expect(() => build('mysql_sql', { sql: 'SELECT "x"' })).toThrow(); });
  it('prefix selain sudo ditolak', () => expect(() => build('log_count', { prefix: 'rm -rf ', pattern: 'x', path: '/var/log/a' })).toThrow());
  it('semua paket menghasilkan perintah yang valid', () => { for (const k of Object.keys(Checks.PACKS)) for (const d of Checks.PACKS[k]!.make({ db: 'appdb', log: '/var/log/a.log' }, true)) expect(() => Checks.buildCommand(d)).not.toThrow(); });
});

describe('penilaian hasil', () => {
  it('systemd: aktif ok, gagal kritis', () => { expect(ev('systemd', {}, { stdout: 'active' }).status).toBe('ok'); expect(ev('systemd', {}, { stdout: 'failed', exitCode: 3 }).status).toBe('crit'); });
  it('angka dibandingkan dengan ambang', () => { const o = { warn: 70, crit: 90 }; expect(ev('mysql_conn_pct', o, { stdout: '75' }).status).toBe('warn'); expect(ev('mysql_conn_pct', o, { stdout: '95' }).status).toBe('crit'); expect(ev('mysql_conn_pct', o, { stdout: '10' }).status).toBe('ok'); });
  it('ambang bawah (queue worker habis = kritis)', () => { const o = { warn: 1, crit: 0, dir: 'lt' }; expect(ev('proc_count', o, { stdout: '0' }).status).toBe('crit'); expect(ev('proc_count', o, { stdout: '3' }).status).toBe('ok'); });
  it('delta: kenaikan, log berotasi, pembacaan pertama tidak memicu', () => {
    const o = { warn: 1, crit: 10, delta: true };
    expect(ev('log_count', { ...o, last_raw: 100 }, { stdout: '103' }).value).toBe(3); expect(ev('log_count', { ...o, last_raw: 100 }, { stdout: '5' }).value).toBe(5); expect(ev('log_count', { ...o, last_raw: null }, { stdout: '500' }).status).toBe('ok');
  });
  it('HTTP: kode dan waktu', () => {
    const o = { warn: 1500, crit: 5000 }; expect(ev('http', o, { stdout: '200 0.120' }).status).toBe('ok'); expect(ev('http', o, { stdout: '200 6.000' }).status).toBe('crit'); expect(ev('http', {}, { stdout: '502 0.01' }).status).toBe('crit'); expect(ev('http', {}, { stdout: '000 0' }).status).toBe('crit');
  });
  it('PHP-FPM: antrean worker dari JSON status', () => { const r = ev('fpm_status', { warn: 1, crit: 10 }, { stdout: JSON.stringify({ 'listen queue': 4, 'active processes': 20, 'total processes': 20, 'max children reached': 2 }) }); expect(r.status).toBe('warn'); expect(r.detail).toMatch(/antrean 4/); });
  it('Netdata: alarm CRITICAL jadi kritis dengan nama alarm', () => { const r = ev('netdata_alarms', {}, { stdout: JSON.stringify({ alarms: { mysql_connections: { status: 'CRITICAL' }, disk_space: { status: 'WARNING' } } }) }); expect(r.status).toBe('crit'); expect(r.detail).toMatch(/mysql_connections/); });
  it('tanpa angka atau waktu habis: unknown, bukan kritis palsu', () => { expect(ev('mysql_longq', {}, { stderr: 'ERROR 1045', exitCode: 1 }).status).toBe('unknown'); expect(ev('mysql_longq', {}, { timedOut: true }).status).toBe('unknown'); });
});

const bash = ((): string | null => { for (const c of ['bash', 'C:/Program Files/Git/bin/bash.exe']) { try { if (spawnSync(c, ['-c', 'true']).status === 0) return c; } catch { /* coba berikutnya */ } } return null; })();
describe.skipIf(!bash)('skrip batch (dijalankan sungguhan di bash)', () => {
  const defs = [{ id: 11, type: 'custom', params: { command: "echo 'dia bilang \"halo\"'" } }, { id: 12, type: 'custom', params: { command: 'test -f /tidak/ada' } }, { id: 13, type: 'custom', params: { command: 'echo 42' } }];
  const out = bash ? Checks.parseBatch(spawnSync(bash, ['-c', Checks.batchScript(defs)], { encoding: 'utf8' }).stdout) : {};
  it('tanda kutip lolos tanpa merusak perintah', () => { expect(out['11']?.stdout).toMatch(/dia bilang "halo"/); expect(out['11']?.exitCode).toBe(0); });
  it('kode keluar tiap perintah terpisah', () => expect(out['12']?.exitCode).toBe(1));
  it('keluaran tiap perintah terpisah dan terbaca', () => { expect(out['13']?.stdout.trim()).toBe('42'); expect(ev('custom', {}, out['13']!).value).toBe(42); });
});

describe('deteksi layanan', () => {
  it('menyarankan paket sesuai layanan yang berjalan', () => {
    const s = Checks.suggest('unit=nginx.service\nunit=php8.3-fpm.service\nunit=mariadb.service\nunit=redis-server.service\nlisten=0.0.0.0:80\ncmd=zpool\nfpmlog=php8.3-fpm.log\n');
    expect(s.mysql).toEqual({ unit: 'mariadb' }); expect(s.phpfpm).toEqual({ unit: 'php8.3-fpm', log: '/var/log/php8.3-fpm.log' }); expect(s.nginx).toBeTruthy(); expect(s.redis).toBeTruthy(); expect(s.proxmox).toBeUndefined(); expect(s.laravel).toBeUndefined();   // PHP-FPM + Nginx belum tentu Laravel expect(s.postgres).toBeUndefined();
  });
});

describe('pemeriksaan angka yang perintahnya gagal', () => {
  const ev = (res: object) => Checks.evaluate({ type: 'pg_conn_pct', params: {}, warn: 70, crit: 90, dir: 'gt', delta: false, last_raw: null } as never, res as never);
  it('galat dengan angka di pesannya tidak dibaca sebagai nilai: tidak terbaca, dengan pesan galatnya', () => {
    const r = ev({ exitCode: 1, stdout: 'ERROR 1045 (28000): Access denied', stderr: '', timedOut: false });
    expect(r).toMatchObject({ status: 'unknown', value: null }); expect(r.detail).toContain('1045');
    expect(ev({ exitCode: 127, stdout: '', stderr: 'psql: command not found', timedOut: false })).toMatchObject({ status: 'unknown', detail: 'psql: command not found' });
  });
  it('perintah yang berhasil tetap dinilai seperti biasa', () => {
    expect(ev({ exitCode: 0, stdout: '95\n', stderr: '', timedOut: false })).toMatchObject({ status: 'crit', value: 95 });
    expect(ev({ exitCode: 0, stdout: '10\n', stderr: '', timedOut: false })).toMatchObject({ status: 'ok', value: 10 });
  });
});

describe('katalog paket', () => {
  const sets = Object.entries(Checks.PACKS) as Array<[string, { fields: Array<{ k: string; def: string }>; make: (o: object, sudo: boolean) => Array<{ name: string; type: string; params: object; warn?: number; crit?: number; dir?: string }> }]>;
  it('Proxmox dan ZFS sudah tidak ada; paket baru tersedia', () => {
    expect(Object.keys(Checks.PACKS)).not.toContain('proxmox'); expect(Object.keys(Checks.TYPES).filter((t) => /zpool/.test(t))).toEqual([]);
    for (const p of ['apache', 'caddy', 'haproxy', 'mongodb', 'rabbitmq', 'elasticsearch', 'memcached', 'supervisor', 'fail2ban', 'postfix', 'tls']) expect(Object.keys(Checks.PACKS)).toContain(p);
  });
  it('setiap pemeriksaan dari setiap paket (dengan dan tanpa sudo) membangun perintah yang valid dan tidak ada nama ganda dalam satu paket', () => {
    for (const [id, P] of sets) for (const sudo of [false, true]) {
      const defs = P.make(Object.fromEntries(P.fields.map((f) => [f.k, f.def])), sudo);
      expect(new Set(defs.map((d) => d.name)).size, id).toBe(defs.length);
      for (const d of defs) expect(() => Checks.buildCommand(d as never), `${id}: ${d.name}`).not.toThrow();
    }
  });
  it('ambang masuk akal: kritis tidak lebih ringan dari peringatan (arah gt naik, lt turun)', () => {
    for (const [id, P] of sets) for (const d of P.make(Object.fromEntries(P.fields.map((f) => [f.k, f.def])), false)) {
      if (d.warn == null || d.crit == null) continue;
      if ((d.dir ?? 'gt') === 'gt') expect(d.crit, `${id}: ${d.name}`).toBeGreaterThanOrEqual(d.warn); else expect(d.crit, `${id}: ${d.name}`).toBeLessThanOrEqual(d.warn);
    }
  });
  it('deteksi mengenali layanan baru dan menawarkan sertifikat HTTPS bila port 443 mendengarkan', () => {
    const s = Checks.suggest('unit=apache2.service\nunit=mongod.service\nunit=rabbitmq-server.service\nunit=supervisor.service\nunit=postfix@-.service\nunit=fail2ban.service\nunit=haproxy.service\nlisten=0.0.0.0:443\nlisten=[::]:22');
    for (const p of ['apache', 'mongodb', 'rabbitmq', 'supervisor', 'postfix', 'fail2ban', 'haproxy', 'tls', 'host']) expect(s[p], p).toBeDefined();
    expect(s.proxmox).toBeUndefined(); expect(Checks.suggest('unit=cron.service').tls).toBeUndefined();
  });
  it('nama domain sertifikat divalidasi (tidak bisa menyisipkan perintah)', () => {
    expect(() => Checks.buildCommand({ type: 'cert_days', params: { host: 'a.com; rm -rf /', port: '443' } })).toThrow();
    expect(Checks.buildCommand({ type: 'cert_days', params: { host: 'contoh.com', port: '443' } })).toContain('-connect contoh.com:443 -servername contoh.com');
  });
});
