// Dokumentasi server: profil, pencarian inventaris, vault kredensial (enkripsi, ungkap dengan konfirmasi, versi, rotasi, pembangkit),
// fakta dari server, ekspor tanpa rahasia, pemeliharaan, dan ringkasan harian.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Docs from '../src/docs.js';
import * as Maint from '../src/maintenance.js';
import * as Servers from '../src/servers.js';
import * as Vault from '../src/vault.js';
import { ADMIN_PW, harness, login, sleep, until, type Harness } from './helpers.js';

let h: Harness, recv: http.Server;
const hooks: string[] = [];
let a = 0, b = 0;
const DAY = 864e5;
let ipn = 10; const rv = (url: string, body: unknown) => h.call('POST', url, body, { ip: '10.7.0.' + ++ipn });

beforeAll(async () => {
  recv = http.createServer((req, res) => { let x = ''; req.on('data', (c) => { x += c; }); req.on('end', () => { hooks.push(JSON.parse(x).text); res.end('ok'); }); });
  await new Promise<void>((r) => recv.listen(0, '127.0.0.1', () => r())); const port = (recv.address() as AddressInfo).port;
  h = await harness(); await login(h);
  await h.call('POST', '/api/channels', { type: 'webhook', name: 'hook', min_level: 'semua', config: { url: `http://127.0.0.1:${port}/h`, format: 'slack' } });
  a = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-app-db', host: '10.0.0.21', username: 'ops' })).json.id;
  b = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-auth', host: '10.0.0.22', username: 'ops' })).json.id;
});
afterAll(async () => { recv.close(); await h.close(); });

describe('pembangkit password dan username', () => {
  it('panjang, kelas karakter, dan pengecualian karakter ambigu dihormati', () => {
    for (let i = 0; i < 200; i++) {
      const p = Vault.generatePassword({ length: 32 }); expect(p).toHaveLength(32); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[^A-Za-z0-9]/);
      expect(Vault.generatePassword({ length: 24, avoidAmbiguous: true })).not.toMatch(/[Il1O0o|`'"\\/]/);
      expect(Vault.generatePassword({ length: 20, symbols: false })).toMatch(/^[A-Za-z0-9]+$/);
    }
    expect(Vault.generatePassword({ digits: true, upper: false, lower: false, symbols: false, length: 16 })).toMatch(/^[0-9]{16}$/);
  });
  it('batas panjang dan opsi tidak valid ditolak', () => {
    expect(Vault.generatePassword({ length: 1 })).toHaveLength(8); expect(Vault.generatePassword({ length: 9999 })).toHaveLength(128);
    expect(() => Vault.generatePassword({ upper: false, lower: false, digits: false, symbols: false })).toThrow(/minimal satu/);
  });
  it('acak: tidak ada duplikat dalam 2000 password dan sebaran karakter tidak miring', () => {
    const set = new Set(Array.from({ length: 2000 }, () => Vault.generatePassword({ length: 20 }))); expect(set.size).toBe(2000);
    const counts: Record<string, number> = {}; for (let i = 0; i < 400; i++) for (const c of Vault.generatePassword({ length: 30, upper: false, symbols: false, digits: false })) counts[c] = (counts[c] ?? 0) + 1;
    const vals = Object.values(counts), mean = vals.reduce((x, y) => x + y, 0) / 26; expect(Object.keys(counts)).toHaveLength(26); expect(Math.max(...vals)).toBeLessThan(mean * 1.25); expect(Math.min(...vals)).toBeGreaterThan(mean * 0.75);
  });
  it('username acak berformat awalan-xxxxx dan aman', () => {
    for (let i = 0; i < 100; i++) expect(Vault.generateUsername('App DB!!')).toMatch(/^app-db-[a-z2-9]{5}$/); expect(Vault.generateUsername('')).toMatch(/^svc-/);
  });
  it('API /api/vault/generate mengembalikan password dan username', async () => {
    const r = await h.call('POST', '/api/vault/generate', { length: 30, username_prefix: 'radius' }); expect(r.status).toBe(200); expect(r.json.password).toHaveLength(30); expect(r.json.username).toMatch(/^radius-/);
    expect((await h.call('POST', '/api/vault/generate', { upper: false, lower: false, digits: false, symbols: false })).status).toBe(400);
  });
});

describe('profil dan inventaris', () => {
  it('menyimpan fungsi, lingkungan, tag, alamat (satu utama), layanan, dan dependensi', async () => {
    const r = await h.call('PUT', `/api/servers/${a}/profile`, { purpose: 'Database MySQL aplikasi web', environment: 'prod', tags: ['Database', 'MySQL', 'webapp', 'webapp'], location: 'Rak 2 / Proxmox pve-01 VMID 121', owner: 'Tim NOC',
      runbook: 'Restart hanya di luar jam kerja.', addresses: [{ label: 'LAN', address: '10.0.0.21' }, { label: 'Mgmt', address: '10.9.0.21', is_primary: true }, { label: 'DNS', address: 'db1.lan', kind: 'hostname' }], services: [{ name: 'MySQL', port: 3306, notes: 'hanya dari 10.0.0.0/24' }, { name: 'node_exporter', port: '9100' }], dependsOn: [{ id: b, note: 'autentikasi RADIUS' }] });
    expect(r.status).toBe(200); const p = r.json;
    expect(p.server).toMatchObject({ purpose: 'Database MySQL aplikasi web', environment: 'prod', location: 'Rak 2 / Proxmox pve-01 VMID 121', owner: 'Tim NOC' }); expect(p.server.tags).toEqual(['database', 'mysql', 'webapp']);
    expect(p.addresses.filter((x: any) => x.is_primary)).toHaveLength(1); expect(p.addresses[0].address).toBe('10.9.0.21'); expect(p.services.map((s: any) => s.port)).toEqual([3306, 9100]); expect(p.depends[0]).toMatchObject({ id: b, name: 'srv-auth' });
    expect((await h.call('GET', `/api/servers/${b}/profile`)).json.dependents[0].name).toBe('srv-app-db');
  });
  it('validasi: IP salah, MAC salah, lingkungan salah, port salah, dependensi tidak ada; perubahan tidak parsial', async () => {
    expect((await h.call('PUT', `/api/servers/${a}/profile`, { addresses: [{ address: '999.1.1.1', kind: 'ip' }] })).status).toBe(400);
    expect((await h.call('PUT', `/api/servers/${a}/profile`, { addresses: [{ address: 'zz:zz', kind: 'mac' }] })).status).toBe(400);
    expect((await h.call('PUT', `/api/servers/${a}/profile`, { environment: 'production' })).status).toBe(400);
    expect((await h.call('PUT', `/api/servers/${a}/profile`, { services: [{ name: 'x', port: 70000 }] })).status).toBe(400);
    const before = (await h.call('GET', `/api/servers/${a}/profile`)).json.server.purpose;
    expect((await h.call('PUT', `/api/servers/${a}/profile`, { purpose: 'TIDAK BOLEH TERSIMPAN', dependsOn: [{ id: 99999 }] })).status).toBe(400);
    expect((await h.call('GET', `/api/servers/${a}/profile`)).json.server.purpose).toBe(before);
    const self = await h.call('PUT', `/api/servers/${a}/profile`, { dependsOn: [{ id: a }, { id: b }] }); expect(self.json.depends.map((d: any) => d.id)).toEqual([b]);
    expect((await h.call('GET', '/api/servers/99999/profile')).status).toBe(404);
  });
  it('pencarian: nama, IP, username kredensial, port layanan, tag, pemilik, lokasi; filter lingkungan', async () => {
    await h.call('POST', `/api/servers/${b}/credentials`, { label: 'root AUTH', username: 'authsrv-admin', generate: true }); await h.call('PUT', `/api/servers/${b}/profile`, { purpose: 'FreeRADIUS autentikasi pelanggan', environment: 'staging', addresses: [{ address: '10.0.0.22' }] });
    const find = async (q: string) => (await h.call('GET', `/api/inventory?q=${encodeURIComponent(q)}`)).json.map((r: any) => r.name);
    expect(await find('webapp')).toEqual(['srv-app-db']); expect(await find('10.9.0.21')).toEqual(['srv-app-db']); expect(await find('authsrv-admin')).toEqual(['srv-auth']); expect(await find('3306')).toEqual(['srv-app-db']);
    expect(await find('noc')).toEqual(['srv-app-db']); expect(await find('pve-01')).toEqual(['srv-app-db']); expect(await find('autentikasi')).toEqual(['srv-auth']); expect(await find('tidak-ada-xyz')).toEqual([]);
    expect((await find('%')).length).toBe(0); expect(await find('_')).toEqual(['srv-app-db']);   // karakter LIKE di-escape: '%' tidak cocok dengan semua; '_' hanya cocok dengan garis bawah harfiah (node_exporter)
    expect((await h.call('GET', '/api/inventory?env=staging')).json.map((r: any) => r.name)).toEqual(['srv-auth']); expect((await h.call('GET', '/api/inventory?tag=mysql')).json.map((r: any) => r.name)).toEqual(['srv-app-db']);
    const row = (await h.call('GET', '/api/inventory?q=webapp')).json[0]; expect(row).toMatchObject({ primary_address: '10.9.0.21', credentials: 0, environment: 'prod' });
  });
  it("injeksi SQL lewat pencarian tidak berpengaruh", async () => {
    const r = await h.call('GET', `/api/inventory?q=${encodeURIComponent("' OR 1=1; DROP TABLE servers;--")}`); expect(r.status).toBe(200); expect(r.json).toEqual([]); expect((await h.call('GET', '/api/servers')).json).toHaveLength(2);
  });
});

describe('vault kredensial', () => {
  let cid = 0, secret = '';
  it('membuat dengan password otomatis: ditampilkan sekali, tidak pernah ada di daftar, terenkripsi di database', async () => {
    const r = await h.call('POST', `/api/servers/${a}/credentials`, { label: 'MySQL root', kind: 'database', username: 'root', generate: { length: 28, avoidAmbiguous: true }, port: 3306, rotate_every_days: 90, notes: 'dipakai aplikasi web' });
    expect(r.status).toBe(200); secret = r.json.generated; cid = r.json.credential.id; expect(secret).toHaveLength(28);
    expect(JSON.stringify(r.json.credential)).not.toContain(secret); expect(r.json.credential.has_secret).toBe(true);
    const listing = JSON.stringify((await h.call('GET', `/api/servers/${a}/credentials`)).json); expect(listing).not.toContain(secret); expect(listing).not.toContain('secret_enc');
    expect(JSON.stringify((await h.call('GET', '/api/vault')).json)).not.toContain(secret);
    const row = await h.db.one('SELECT secret_enc FROM credentials WHERE id=$1', [cid]); expect(row!.secret_enc).not.toContain(secret); expect(row!.secret_enc).toMatch(/^v2:[0-9a-f]{8}:/);
    expect(JSON.stringify(await h.db.query('SELECT * FROM credential_versions'))).not.toContain(secret);
  });
  it('ungkap: password salah ditolak dan tercatat; benar mengembalikan rahasia; audit tanpa isi rahasia', async () => {
    const bad = await rv(`/api/credentials/${cid}/reveal`, { password: 'salah-banget' }); expect(bad.status).toBe(403); expect(JSON.stringify(bad.json)).not.toContain(secret);
    const ok = await rv(`/api/credentials/${cid}/reveal`, { password: ADMIN_PW }); expect(ok.status).toBe(200); expect(ok.json).toMatchObject({ secret, username: 'root', label: 'MySQL root' });
    const audit = JSON.stringify(await h.db.query("SELECT * FROM audit WHERE action LIKE 'vault.%'")); expect(audit).toContain('vault.ungkap'); expect(audit).toContain('vault.ungkap-ditolak'); expect(audit).not.toContain(secret);
    expect((await h.db.one('SELECT last_revealed FROM credentials WHERE id=$1', [cid]))!.last_revealed).toBeTruthy();
    expect((await rv(`/api/credentials/${cid}/reveal`, {})).status).toBe(400);
  });
  it('batas laju ungkap: percobaan beruntun dibatasi (anti tebak password)', async () => {
    const s = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-limit', host: '1.1.1.1', username: 'ops' })).json.id; const c = (await h.call('POST', `/api/servers/${s}/credentials`, { label: 'x', secret: 'abc' })).json.credential.id;
    const codes: number[] = []; for (let i = 0; i < 14; i++) codes.push((await h.call('POST', `/api/credentials/${c}/reveal`, { password: 'salah' }, { ip: '10.99.0.1' })).status); expect(codes).toContain(429); expect(codes.slice(0, 10).every((x) => x === 403)).toBe(true);
    await h.call('DELETE', `/api/servers/${s}`);
  });
  it('mengganti rahasia membuat versi baru, memperbarui rotated_at, dan versi lama tetap bisa diungkap (dengan password)', async () => {
    const before = (await h.db.one('SELECT rotated_at FROM credentials WHERE id=$1', [cid]))!.rotated_at; await sleep(15);
    const u = await h.call('PUT', `/api/credentials/${cid}`, { secret: 'Password-Baru-123!' }); expect(u.status).toBe(200); expect(u.json.rotated_at).toBeGreaterThan(before); expect(JSON.stringify(u.json)).not.toContain('Password-Baru');
    const vs = (await h.call('GET', `/api/credentials/${cid}/versions`)).json; expect(vs).toHaveLength(2);
    expect((await rv(`/api/credentials/${cid}/reveal`, { password: ADMIN_PW })).json.secret).toBe('Password-Baru-123!');
    expect((await rv(`/api/credential-versions/${vs[1].id}/reveal`, { password: ADMIN_PW })).json.secret).toBe(secret); expect((await rv(`/api/credential-versions/${vs[1].id}/reveal`, { password: 'salah' })).status).toBe(403);
  });
  it('rotasi otomatis menghasilkan password baru dan menyimpan yang lama; riwayat dipangkas maksimal 10 versi', async () => {
    const old = (await rv(`/api/credentials/${cid}/reveal`, { password: ADMIN_PW })).json.secret;
    const r = await h.call('POST', `/api/credentials/${cid}/rotate`, { length: 30 }); expect(r.json.secret).toHaveLength(30); expect(r.json.secret).not.toBe(old);
    for (let i = 0; i < 12; i++) await Vault.rotate(cid, {}, 'admin'); expect((await h.call('GET', `/api/credentials/${cid}/versions`)).json).toHaveLength(10);
  });
  it('jatuh tempo rotasi dan kedaluwarsa ditandai', async () => {
    await h.db.exec('UPDATE credentials SET rotated_at=$1, expires_at=$2 WHERE id=$3', [Date.now() - 100 * DAY, Date.now() - DAY, cid]);
    const c = (await h.call('GET', `/api/servers/${a}/credentials`)).json[0]; expect(c.rotation_overdue).toBe(true); expect(c.expired).toBe(true); expect(c.age_days).toBeGreaterThanOrEqual(100);
    expect((await h.call('GET', '/api/inventory?q=webapp')).json[0].rotation_due).toBe(1);
  });
  it('validasi: label wajib, jenis dan port tidak valid; kredensial umum (tanpa server) dan pencarian vault', async () => {
    expect((await h.call('POST', `/api/servers/${a}/credentials`, { kind: 'password' })).status).toBe(400); expect((await h.call('POST', `/api/servers/${a}/credentials`, { label: 'x', kind: 'ngawur' })).status).toBe(400); expect((await h.call('POST', `/api/servers/${a}/credentials`, { label: 'x', port: 99999 })).status).toBe(400);
    expect((await h.call('POST', '/api/vault', { label: 'Panel Cloudflare', kind: 'web', username: 'noc@contoh.id', secret: 'x', url: 'https://dash.cloudflare.com' })).status).toBe(200);
    expect((await h.call('GET', '/api/vault?q=cloudflare')).json.map((c: any) => c.label)).toEqual(['Panel Cloudflare']); expect((await h.call('GET', '/api/vault?q=authsrv-admin')).json[0].server_name).toBe('srv-auth');
  });
  it('PUT parsial tidak menghapus field lain (regresi: port dan periode rotasi dulu ikut terhapus)', async () => {
    const c = (await h.call('POST', `/api/servers/${a}/credentials`, { label: 'Parsial', port: 2222, rotate_every_days: 45, notes: 'n', secret: 's' })).json.credential; const u = (await h.call('PUT', `/api/credentials/${c.id}`, { notes: 'baru' })).json;
    expect(u).toMatchObject({ port: 2222, rotate_every_days: 45, notes: 'baru' }); const cleared = (await h.call('PUT', `/api/credentials/${c.id}`, { port: null, rotate_every_days: '' })).json; expect(cleared.port).toBeNull(); expect(cleared.rotate_every_days).toBeNull(); await h.call('DELETE', `/api/credentials/${c.id}`);
  });
  it('menghapus kredensial', async () => { expect((await h.call('DELETE', `/api/credentials/${cid}`)).status).toBe(200); expect((await h.call('GET', `/api/servers/${a}/credentials`)).json).toHaveLength(0); expect((await h.db.query('SELECT 1 FROM credential_versions WHERE credential_id=$1', [cid]))).toHaveLength(0); });
});

describe('fakta otomatis dari server', () => {
  it('parseFacts mengurai keluaran skrip', () => {
    const f = Docs.parseFacts('os=Debian GNU/Linux 12\nkernel=6.1.0\ncpu_cores=8\nram_mb=16000\nip=eth0 10.0.0.21/24\nip=eth1 10.9.0.21/24\nport=22\nport=3306\nport=99999\nsvc=mysql.service\ntool=nginx\nupdates=12\nreboot_required=1\n');
    expect(f).toMatchObject({ os: 'Debian GNU/Linux 12', cpu_cores: 8, ram_mb: 16000, updates: 12, reboot_required: true }); expect(f.ports).toEqual([22, 3306]); expect(f.services).toEqual(['mysql']); expect(f.ips).toHaveLength(2);
  });
  it('mengumpulkan fakta lewat SSH, menyimpan, dan menyarankan IP yang belum terdokumentasi', async () => {
    Servers.setExec((async (_s: unknown, cmd: string) => { expect(cmd).toBe(Docs.FACTS_SCRIPT); return { exitCode: 0, stderr: '', ms: 1, timedOut: false, stdout: 'os=Debian GNU/Linux 12\nkernel=6.1.0\ncpu_cores=4\nram_mb=8000\nip=eth0 10.0.0.21/24\nip=eth2 192.168.50.7/24\nport=3306\nupdates=3\nreboot_required=0\n' }; }) as never);
    const r = await h.call('POST', `/api/servers/${a}/facts`); expect(r.status).toBe(200); expect(r.json.facts.cpu_cores).toBe(4); expect(r.json.suggestions.addresses).toEqual(['10.0.0.21', '192.168.50.7'].filter((x) => x !== '10.0.0.21'));
    const p = (await h.call('GET', `/api/servers/${a}/profile`)).json; expect(p.server.facts.ram_mb).toBe(8000); expect(p.server.os_info).toContain('Debian'); expect(p.server.facts_at).toBeTruthy();
  });
  it('skrip fakta murni baca-saja (lolos kebijakan perintah kecuali konstruksi shell majemuk) dan galat SSH dijelaskan', async () => {
    expect(Docs.FACTS_SCRIPT).not.toMatch(/(^|[;|&]\s*|\$\()\s*(rm|reboot|shutdown|halt|poweroff)\s|apt-get (install|upgrade)|systemctl (restart|stop)/);
    Servers.setExec((async () => ({ exitCode: 255, stdout: '', stderr: 'ssh: Permission denied (publickey)', ms: 1, timedOut: false })) as never);
    const r = await h.call('POST', `/api/servers/${b}/facts`); expect(r.status).toBe(400); expect(r.json.error).toMatch(/SSH/);
  });
});

describe('ekspor tanpa rahasia', () => {
  it('Markdown memuat dokumentasi dan username tetapi tidak ada password apa pun', async () => {
    await h.call('POST', `/api/servers/${a}/credentials`, { label: 'Panel admin', kind: 'web', username: 'admin', secret: 'RAHASIA-SANGAT-PENTING-987', url: 'https://db1.lan:8443' });
    await Maint.addTemplates(a, ['os-update']);
    const r = await h.app.inject({ method: 'GET', url: `/api/servers/${a}/export.md`, headers: { host: 'localhost', cookie: h.cookie } }); expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toMatch(/markdown/); expect(r.headers['content-disposition']).toMatch(/srv-app-db\.md/);
    expect(r.body).toContain('# srv-app-db'); expect(r.body).toContain('Database MySQL aplikasi web'); expect(r.body).toContain('10.9.0.21'); expect(r.body).toContain('Panel admin'); expect(r.body).toContain('admin'); expect(r.body).toContain('Pembaruan keamanan OS'); expect(r.body).toContain('Restart hanya di luar jam kerja.');
    expect(r.body).not.toContain('RAHASIA-SANGAT-PENTING-987'); expect(r.body).not.toMatch(/secret_enc|v1:/);
  });
  it('CSV inventaris: kolom, escaping koma dan kutip, tanpa rahasia', async () => {
    await h.call('PUT', `/api/servers/${b}/profile`, { purpose: 'Auth, "RADIUS" pelanggan' });
    const r = await h.app.inject({ method: 'GET', url: '/api/inventory.csv', headers: { host: 'localhost', cookie: h.cookie } }); expect(r.statusCode).toBe(200); expect(r.body.split('\n')[0]).toContain('nama,alamat_utama'); expect(r.body).toContain('"Auth, ""RADIUS"" pelanggan"'); expect(r.body).not.toContain('RAHASIA-SANGAT');
  });
});

describe('pemeliharaan', () => {
  it('templat standar ditambahkan tanpa menggandakan', async () => {
    const t = (await h.call('GET', '/api/maintenance/templates')).json; expect(t.length).toBeGreaterThanOrEqual(8);
    const r1 = await h.call('POST', `/api/servers/${b}/maintenance/templates`, { ids: ['os-update', 'backup-restore', 'disk-health'] }); expect(r1.json.added).toHaveLength(3);
    expect((await h.call('POST', `/api/servers/${b}/maintenance/templates`, { ids: ['os-update', 'backup-restore'] })).json.added).toHaveLength(0); expect((await h.call('POST', `/api/servers/${b}/maintenance/templates`, { ids: ['tidak-ada'] })).status).toBe(400);
  });
  it('tugas berulang: selesai -> riwayat, jatuh tempo berikutnya = sekarang + periode, tidak menumpuk walau terlambat', async () => {
    const t = (await h.call('POST', `/api/servers/${b}/maintenance`, { title: 'Ganti baterai UPS', every_days: 30, due_at: Date.now() - 20 * DAY, priority: 'tinggi' })).json; expect(t.status).toBe('terlambat');
    const done = await h.call('POST', `/api/maintenance/${t.id}/complete`, { notes: 'baterai diganti' }); expect(done.status).toBe(200);
    expect(Math.abs(done.json.due_at - (Date.now() + 30 * DAY))).toBeLessThan(5000); expect(done.json.status).toBe('ok'); expect(done.json.last_done_by).toBe('admin');
    const log = (await h.call('GET', `/api/servers/${b}/maintenance-log`)).json; expect(log[0]).toMatchObject({ title: 'Ganti baterai UPS', done_by: 'admin', notes: 'baterai diganti' });
  });
  it('tugas sekali: selesai -> nonaktif; tanggal masa depan ditolak', async () => {
    const t = (await h.call('POST', `/api/servers/${b}/maintenance`, { title: 'Migrasi rak', due_at: Date.now() + DAY })).json; expect((await h.call('POST', `/api/maintenance/${t.id}/complete`, {})).json.enabled).toBe(false);
    expect((await h.call('GET', `/api/servers/${b}/maintenance`)).json.some((x: any) => x.id === t.id)).toBe(false);
    expect((await Maint.complete(t.id, 'x', '', Date.now() + 10 * DAY).catch((e) => e.message))).toMatch(/masa depan/);
  });
  it('status terlambat/segera/ok, filter scope, tunda, ubah, hapus, validasi', async () => {
    const mk = async (title: string, days: number) => (await h.call('POST', `/api/servers/${a}/maintenance`, { title, due_at: Date.now() + days * DAY })).json;
    const late = await mk('T-terlambat', -3), soon = await mk('T-segera', 3), far = await mk('T-jauh', 60);
    expect([late.status, soon.status, far.status]).toEqual(['terlambat', 'segera', 'ok']);
    const names = async (scope: string) => (await h.call('GET', `/api/maintenance?scope=${scope}&server=${a}`)).json.map((x: any) => x.title); expect(await names('overdue')).toContain('T-terlambat'); expect(await names('overdue')).not.toContain('T-jauh'); expect(await names('soon')).toContain('T-segera'); expect(await names('soon')).not.toContain('T-jauh');
    const sn = await h.call('POST', `/api/maintenance/${late.id}/snooze`, { days: 7 }); expect(sn.json.due_at).toBeGreaterThan(Date.now() + 6 * DAY); expect((await h.call('POST', `/api/maintenance/${late.id}/snooze`, { days: 0 })).status).toBe(400);
    expect((await h.call('PUT', `/api/maintenance/${far.id}`, { title: 'T-jauh (ubah)', priority: 'rendah' })).json.title).toBe('T-jauh (ubah)'); expect((await h.call('PUT', `/api/maintenance/${far.id}`, { priority: 'ngawur' })).status).toBe(400);
    expect((await h.call('POST', `/api/servers/${a}/maintenance`, { title: '' })).status).toBe(400); expect((await h.call('POST', `/api/servers/${a}/maintenance`, { title: 'x', every_days: 99999 })).status).toBe(400); expect((await h.call('DELETE', `/api/maintenance/${far.id}`)).status).toBe(200);
  });
  it('inventaris dan ringkasan menunjukkan pemeliharaan terlambat', async () => {
    const row = (await h.call('GET', '/api/inventory?q=webapp')).json[0]; expect(row.overdue).toBeGreaterThanOrEqual(0); const ov = (await h.call('GET', '/api/overview')).json; expect(ov.maintenance).toHaveProperty('overdue'); expect(ov.rotationDue).toBeGreaterThanOrEqual(0);
  });
});

describe('ringkasan harian', () => {
  const at = (hour: number) => new Date(2031, 2, 10, hour, 0, 0).getTime();
  it('mengirim satu ringkasan per hari lokal setelah jam yang diatur, memuat tugas terlambat, rotasi, dan kedaluwarsa', async () => {
    await h.db.exec('DELETE FROM maintenance_tasks'); await h.db.exec('DELETE FROM credentials'); await h.db.exec("DELETE FROM meta WHERE key LIKE 'digest_%'");
    const now = at(9); await Maint.add(a, { title: 'Uji pulih cadangan', due_at: now - 5 * DAY }); await Maint.add(b, { title: 'Tinjau firewall', due_at: now + 2 * DAY }); await Maint.add(b, { title: 'Jauh', due_at: now + 40 * DAY });
    await Vault.create(a, { label: 'root SSH', secret: 'x', rotate_every_days: 30 }, 'admin'); await h.db.exec('UPDATE credentials SET rotated_at=$1', [now - 45 * DAY]); await Vault.create(b, { label: 'API token', secret: 'y', expires_at: now + 5 * DAY }, 'admin');
    hooks.length = 0; expect(await Maint.runDigest(at(7))).toBe(false); expect(hooks).toHaveLength(0);   // sebelum jam 08:00
    expect(await Maint.runDigest(now)).toBe(true); expect(await until(() => hooks.some((t) => /PEMELIHARAAN/.test(t)))).toBeTruthy();
    const msg = hooks.find((t) => /PEMELIHARAAN/.test(t))!; expect(msg).toMatch(/Uji pulih cadangan \(terlambat 5 hari\)/); expect(msg).toMatch(/Tinjau firewall/); expect(msg).toMatch(/ganti password "root SSH" \(terlambat 15 hari\)/); expect(msg).toMatch(/"API token" kedaluwarsa dalam 5 hari/); expect(msg).not.toMatch(/Jauh/); expect(msg).toMatch(/terlambat/);
    hooks.length = 0; expect(await Maint.runDigest(now + 3600e3)).toBe(false); await sleep(200); expect(hooks).toHaveLength(0);   // hari yang sama: tidak dikirim ulang
    expect(await Maint.runDigest(now + DAY)).toBe(true);   // hari berikutnya: dikirim lagi
  });
  it('bisa dimatikan, dan tidak mengirim apa pun bila tidak ada yang perlu diperhatikan', async () => {
    await h.call('POST', '/api/settings', { digest_enabled: false }); expect(await Maint.runDigest(at(9) + 5 * DAY)).toBe(false);
    await h.call('POST', '/api/settings', { digest_enabled: true, digest_hour: 6 }); expect((await h.call('GET', '/api/settings')).json).toMatchObject({ digest_enabled: true, digest_hour: 6 });
    await h.db.exec('DELETE FROM maintenance_tasks'); await h.db.exec('DELETE FROM credentials'); hooks.length = 0; expect(await Maint.runDigest(at(9) + 9 * DAY)).toBe(false); await sleep(150); expect(hooks).toHaveLength(0);
  });
});

describe('akses', () => {
  it('semua rute dokumentasi, vault, dan pemeliharaan butuh sesi', async () => {
    for (const [m, u] of [['GET', '/api/inventory'], ['GET', '/api/inventory.csv'], ['GET', '/api/vault'], ['POST', '/api/vault/generate'], ['GET', `/api/servers/${a}/profile`], ['GET', `/api/servers/${a}/credentials`], ['POST', '/api/credentials/1/reveal'], ['GET', '/api/maintenance'], ['GET', `/api/servers/${a}/export.md`]] as const)
      expect((await h.call(m, u, m === 'POST' ? {} : undefined, { cookie: null })).status, `${m} ${u}`).toBe(401);
  });
});
