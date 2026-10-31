// Perbaikan hasil audit keamanan: ekspor CSV, umur mutlak sesi, badan terkompresi, pembatas laju agen, penyamaran audit dan log, endpoint kesehatan.
import { gzipSync } from 'node:zlib';
import express from 'express';
import inject from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { agentLimiter } from '../src/http/middleware/rateLimit.js';
import { harness, login, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await harness(); await login(h); });
afterAll(async () => { await h.close(); });

describe('ekspor CSV', () => {
  it('sel yang diawali rumus (= + @ -) dinetralkan dengan apostrof; angka, tanda "-", dan teks biasa tidak berubah', async () => {
    const id = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-csv', host: '10.4.4.4', username: 'ops' })).json.id as number;
    await h.db.exec('UPDATE servers SET os_info=$1, location=$2, owner=$3 WHERE id=$4', ['=HYPERLINK("http://jahat.example","klik")', '@SUM(1+1)', '-cmd|calc', id]);
    await h.db.exec("UPDATE servers SET purpose='-' WHERE id=$1", [id]);
    const csv = await h.app.inject({ method: 'GET', url: '/api/inventory.csv', headers: { host: 'localhost', cookie: h.cookie } });
    expect(csv.statusCode).toBe(200);
    const row = csv.body.split('\n').find((l) => l.startsWith('srv-csv'))!;
    expect(row).toContain(`"'=HYPERLINK(""http://jahat.example"",""klik"")"`); expect(row).toContain("'@SUM(1+1)"); expect(row).toContain("'-cmd|calc");
    expect(row).not.toMatch(/(^|,)=HYPERLINK/); expect(row).not.toMatch(/,@SUM/);
    expect(row.split(',')[0]).toBe('srv-csv');   // teks biasa utuh
    expect(row).toMatch(/,-,/);   // penanda "-" tidak diberi apostrof
  });
});

describe('umur mutlak sesi', () => {
  it('sesi yang lebih tua dari SESSION_MAX_DAYS ditolak walau masih dipakai (kedaluwarsa bergeser); yang lebih muda tetap sah', async () => {
    expect((await h.call('GET', '/api/me')).status).toBe(200);
    await h.db.exec('UPDATE sessions SET created_at=$1', [Date.now() - 29 * 864e5]); expect((await h.call('GET', '/api/me')).status).toBe(200);
    await h.db.exec('UPDATE sessions SET created_at=$1, last_seen=$2', [Date.now() - 31 * 864e5, Date.now()]); expect((await h.call('GET', '/api/me')).status).toBe(401);
    await login(h); expect((await h.call('GET', '/api/me')).status).toBe(200);   // masuk lagi: sesi baru
  });
});

describe('badan terkompresi', () => {
  it('JSON yang dikirim dengan Content-Encoding ditolak 415 di API dan rute agen; JSON biasa tetap diterima', async () => {
    const body = gzipSync(JSON.stringify({ username: 'x', password: 'y' }));
    for (const url of ['/api/login', '/agent/v1/heartbeat']) {   // rute runner memeriksa bearer lebih dulu, sebelum membaca badan
      const r = await h.app.inject({ method: 'POST', url, headers: { host: 'localhost', 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-aiops': '1' }, payload: body });
      expect(r.statusCode, url).toBe(415);
    }
    const plain = await h.app.inject({ method: 'POST', url: '/api/login', headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops': '1' }, payload: { username: 'x', password: 'y' } });
    expect(plain.statusCode).toBe(401);   // diproses normal: kredensial salah
  });
});

describe('pembatas laju agen', () => {
  const app = () => { const a = express(); a.set('trust proxy', false); a.use(agentLimiter()); a.get('/x', (_q, r) => { r.json({ ok: true }); }); return a; };
  const hit = async (a: express.Express, key: string) => (await inject(a, { method: 'GET', url: '/x', headers: key ? { 'x-aiops-key': key } : {}, remoteAddress: '10.9.9.9' })).statusCode;

  it('satu kunci agen dibatasi 120 per menit', async () => {
    const a = app(); let first429 = 0;
    for (let i = 1; i <= 125; i++) if ((await hit(a, 'ak_tetap')) === 429 && !first429) first429 = i;
    expect(first429).toBe(121);
  });
  it('mengganti nilai header x-aiops-key tidak lagi melewati batas: ada batas per IP (600 per menit)', async () => {
    const a = app(); let first429 = 0;
    for (let i = 1; i <= 610; i++) if ((await hit(a, `ak_acak_${i}`)) === 429 && !first429) first429 = i;
    expect(first429).toBe(601);
  });
});

describe('penyamaran audit dan log', () => {
  it('detail audit tidak menyimpan rahasia yang tertulis di perintah', async () => {
    await audit('uji', 'perintah.jalan', 'mysql -u root -pRahasia123 -e "select 1"; export DB_PASSWORD=hunter2; curl -H "Authorization: Bearer abcdef1234567890" x');
    const d = String((await h.db.one("SELECT detail FROM audit WHERE action='perintah.jalan' ORDER BY id DESC LIMIT 1"))!.detail);
    expect(d).not.toContain('Rahasia123'); expect(d).not.toContain('hunter2'); expect(d).not.toContain('abcdef1234567890'); expect(d).toContain('mysql -u root -p***');
    await audit('uji', 'server.uji', 'srv-biasa dari 10.0.0.1'); expect((await h.db.one("SELECT detail FROM audit WHERE action='server.uji' ORDER BY id DESC LIMIT 1"))!.detail).toBe('srv-biasa dari 10.0.0.1');   // detail biasa utuh
  });
  it('log HTTP menyamarkan cookie, Authorization, dan tanda tangan agen', () => {
    let out = ''; const log = createLogger('info', { write: (s: string) => { out += s; } } as never);
    log.info({ req: { headers: { cookie: 'aiops_sid=RAHASIA1', authorization: 'Bearer RAHASIA2', 'x-aiops-sig': 'RAHASIA3', 'x-aiops-key': 'ak_publik' } } }, 'req');
    expect(out).not.toMatch(/RAHASIA[123]/); expect(out).toContain('ak_publik'); expect(out).toContain('[disembunyikan]');
  });
});
