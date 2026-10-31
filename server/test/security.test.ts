import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { initCrypto, open, seal, hashPassword, verifyPassword } from '../src/crypto.js';
import { harness, login, ADMIN_PW, TEST_URL, type Harness } from './helpers.js';

describe('konfigurasi', () => {
  const base = { DATABASE_URL: TEST_URL, MASTER_KEY: 'a'.repeat(64) };
  it('menolak MASTER_KEY yang bukan 64 heks', () => expect(() => loadConfig({ ...base, MASTER_KEY: 'pendek' })).toThrow(/MASTER_KEY/));
  it('menolak ADMIN_PASSWORD pendek', () => expect(() => loadConfig({ ...base, ADMIN_PASSWORD: 'pendek' })).toThrow(/ADMIN_PASSWORD/));
  it('DATABASE_URL wajib', () => expect(() => loadConfig({ MASTER_KEY: 'a'.repeat(64) })).toThrow(/DATABASE_URL/));
  it('cookie aman otomatis di produksi', () => { expect(loadConfig({ ...base, NODE_ENV: 'production' }).cookieSecure).toBe(true); expect(loadConfig({ ...base, NODE_ENV: 'development' }).cookieSecure).toBe(false); });
});

describe('kripto', () => {
  it('seal/open bolak-balik dan hasilnya acak tiap kali', () => {
    initCrypto('b'.repeat(64)); const a = seal('rahasia'), b = seal('rahasia'); expect(a).not.toBe(b); expect(open(a)).toBe('rahasia'); expect(a).not.toContain('rahasia');
  });
  it('berkas yang dirusak atau kunci berbeda tidak terbuka', () => {
    initCrypto('b'.repeat(64)); const s = seal('x'); expect(open(s.slice(0, -4) + 'AAAA')).toBe(''); initCrypto('c'.repeat(64)); expect(open(s)).toBe(''); initCrypto('b'.repeat(64));
  });
  it('hash password scrypt dapat diverifikasi dan berbeda tiap kali', async () => {
    const h1 = await hashPassword('kata-sandi-panjang'), h2 = await hashPassword('kata-sandi-panjang');
    expect(h1).not.toBe(h2); expect(await verifyPassword('kata-sandi-panjang', h1)).toBe(true); expect(await verifyPassword('salah', h1)).toBe(false); expect(await verifyPassword('x', 'bukan-hash')).toBe(false);
  });
});

describe('akses HTTP', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h.close(); });

  it('API tanpa sesi ditolak 401 (JSON), termasuk API lab', async () => {
    for (const p of ['/api/overview', '/api/lab/projects', '/api/inventory']) { const r = await h.call('GET', p, undefined, { cookie: null }); expect(r.status, p).toBe(401); expect(r.json.error).toBe('Belum masuk'); }
  });
  it('login salah ditolak, benar memberi cookie HttpOnly SameSite=Strict', async () => {
    expect((await h.call('POST', '/api/login', { username: 'admin', password: 'salah' }, { cookie: null })).status).toBe(401);
    const r = await h.call('POST', '/api/login', { username: 'admin', password: ADMIN_PW }, { cookie: null }); expect(r.status).toBe(200);
    const c = String(r.headers['set-cookie']); expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=Strict/i); h.cookie = c.split(';')[0]!;
    expect((await h.call('GET', '/api/me')).json.user.username).toBe('admin');
  });
  it('API yang tidak ada menjawab JSON 404', async () => {
    const r = await h.call('GET', '/api/tidak-ada'); expect(r.status).toBe(404); expect(r.json).toEqual({ error: 'Tidak ada' });
    expect((await h.call('GET', '/api/tidak-ada', undefined, { cookie: null })).status).toBe(401);
  });
  it('token sesi tidak disimpan polos di database', async () => {
    const tok = h.cookie.split('=')[1]!; const rows = await h.db.query('SELECT id FROM sessions'); expect(rows.length).toBeGreaterThan(0); expect(rows.some((r) => r.id === tok)).toBe(false);
  });
  it('perubahan tanpa header X-AIOps ditolak (CSRF)', async () => { expect((await h.call('POST', '/api/settings', { auto_report: false }, { csrf: false })).status).toBe(403); });
  it('Origin asing ditolak', async () => { expect((await h.call('POST', '/api/settings', { auto_report: false }, { headers: { origin: 'https://evil.example' } })).status).toBe(403); });
  it('Host asing ditolak (DNS rebinding)', async () => { expect((await h.call('GET', '/api/overview', undefined, { headers: { host: 'evil.example' } })).status).toBe(403); });
  it('UI (SPA) tersedia tanpa login: rute klien jatuh ke index.html yang tidak di-cache', async () => {
    for (const p of ['/', '/login', '/insiden/3', '/inventaris']) { const r = await h.app.inject({ method: 'GET', url: p, headers: { host: 'localhost' } }); expect(r.statusCode, p).toBe(200); expect(r.headers['cache-control']).toBe('no-store'); expect(r.body).toContain('id="root"'); }
  });
  it('aset ber-hash di-cache lama; aset yang hilang 404 (bukan index.html)', async () => {
    const ok = await h.app.inject({ method: 'GET', url: '/assets/app-abc123.js', headers: { host: 'localhost' } }); expect(ok.statusCode).toBe(200); expect(ok.headers['cache-control']).toMatch(/immutable/);
    const miss = await h.app.inject({ method: 'GET', url: '/assets/hilang.js', headers: { host: 'localhost' } }); expect(miss.statusCode).toBe(404);
  });
  it('UI juga menolak Host asing', async () => { expect((await h.app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(403); });
  it('health tersedia tanpa login, readiness memeriksa database', async () => {
    expect((await h.call('GET', '/healthz', undefined, { cookie: null })).status).toBe(200);
    const r = await h.call('GET', '/readyz', undefined, { cookie: null }); expect(r.status).toBe(200); expect(r.json).toEqual({ ok: true });   // tanpa statistik pool: endpoint tanpa autentikasi tidak membocorkan keadaan internal
  });
  it('/metrics mati tanpa METRICS_TOKEN', async () => { expect((await h.call('GET', '/metrics', undefined, { cookie: null })).status).toBe(404); });
  it('header keamanan terpasang (CSP, nosniff, frame)', async () => {
    const r = await h.call('GET', '/login', undefined, { cookie: null }); expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(String(r.headers['content-security-policy'])).toMatch(/frame-ancestors 'none'/);
  });
  it('batas percobaan login: dibatasi setelah beberapa kali gagal', async () => {
    const codes: number[] = []; for (let i = 0; i < 12; i++) codes.push((await h.call('POST', '/api/login', { username: 'admin', password: 'salah' }, { cookie: null })).status);
    expect(codes).toContain(429);
  });
  it('X-Forwarded-For palsu tidak menghindari batas laju saat TRUST_PROXY mati', async () => {
    const codes: number[] = []; for (let i = 0; i < 12; i++) codes.push((await h.call('POST', '/api/login', { username: 'admin', password: 'salah' }, { cookie: null, ip: '10.9.9.9', headers: { 'x-forwarded-for': `203.0.113.${i + 1}` } })).status);
    expect(codes).toContain(429);
  });
  it('ganti password mencabut semua sesi lama', async () => {
    await new Promise((r) => setTimeout(r, 100)); const h2 = await harness({}); await login(h2);
    expect((await h2.call('POST', '/api/account/password', { current: 'salah-banget', next: 'password-baru-12345' })).status).toBe(400);
    expect((await h2.call('POST', '/api/account/password', { current: ADMIN_PW, next: 'password-baru-12345' })).status).toBe(200);
    expect((await h2.call('GET', '/api/me')).status).toBe(401); await h2.close();
  });
  it('logout mencabut sesi', async () => {
    const h3 = await harness({}); await login(h3); expect((await h3.call('POST', '/api/logout', {})).status).toBe(200); expect((await h3.call('GET', '/api/me')).status).toBe(401); await h3.close();
  });
});

describe('metrik Prometheus', () => {
  it('aktif dengan METRICS_TOKEN dan butuh bearer', async () => {
    const h = await harness({ METRICS_TOKEN: 'token-metrik-panjang-123' });
    expect((await h.call('GET', '/metrics', undefined, { cookie: null })).status).toBe(401);
    const r = await h.app.inject({ method: 'GET', url: '/metrics', headers: { host: 'localhost', authorization: 'Bearer token-metrik-panjang-123' } });
    expect(r.statusCode).toBe(200); expect(r.body).toMatch(/aiops_db_pool_connections/); expect(r.body).toMatch(/process_cpu/); await h.close();
  });
});
