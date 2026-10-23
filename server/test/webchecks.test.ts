import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockedAddress, parseTarget, probe } from '../src/webchecks/probe.js';
import * as Web from '../src/webchecks/service.js';
import * as Vercel from '../src/webchecks/vercel.js';
import { harness, login, type Harness } from './helpers.js';

describe('penjagaan alamat tujuan', () => {
  it('memblokir link-local dan metadata cloud, termasuk bentuk IPv4-mapped; alamat privat biasa boleh', () => {
    for (const ip of ['169.254.169.254', '169.254.0.1', '0.0.0.0', 'fe80::1', '::', '::ffff:a9fe:a9fe', '::ffff:169.254.169.254']) expect(blockedAddress(ip), ip).toBe(true);
    for (const ip of ['10.0.0.5', '127.0.0.1', '192.168.1.1', '8.8.8.8', '::1', 'fd00::5']) expect(blockedAddress(ip), ip).toBe(false);
  });
  it('URL berbahaya atau salah ditolak; yang wajar diterima', () => {
    for (const u of ['ftp://x.com', 'file:///etc/passwd', 'http://u:p@x.com', 'http://169.254.169.254/latest/meta-data', 'http://[fe80::1]/', 'bukan url']) expect(() => parseTarget(u), u).toThrow();
    expect(parseTarget(' https://contoh.com/health ')).toBe('https://contoh.com/health'); expect(parseTarget('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
  });
});

describe('penilaian dan keadaan', () => {
  const rule = { expect_status: 0, slow_ms: 1000 }, ok = { ok: true, code: 200, ms: 120, error: '', certExpires: null };
  const DAY = 864e5, now = 1_000_000_000_000;
  it('sehat, lambat, status salah, tak terjangkau, dan sertifikat', () => {
    expect(Web.judge(rule, ok, now).severity).toBeNull();
    expect(Web.judge(rule, { ...ok, ms: 1500 }, now)).toMatchObject({ severity: 'peringatan', title: 'Lambat (1500 ms)' });
    expect(Web.judge(rule, { ...ok, code: 500 }, now)).toMatchObject({ severity: 'kritis', title: 'Status 500' });
    expect(Web.judge(rule, { ...ok, code: 301 }, now).severity).toBeNull();   // pengalihan tanpa tujuan akhir tetap dianggap hidup
    expect(Web.judge({ ...rule, expect_status: 204 }, ok, now).severity).toBe('kritis');
    expect(Web.judge(rule, { ok: false, code: null, ms: 10000, error: 'Waktu habis (10000 ms)', certExpires: null }, now)).toMatchObject({ severity: 'kritis', title: 'Tidak bisa dijangkau' });
    expect(Web.judge(rule, { ...ok, certExpires: now + 10 * DAY }, now)).toMatchObject({ severity: 'peringatan' });
    expect(Web.judge(rule, { ...ok, certExpires: now + 2 * DAY }, now).severity).toBe('kritis');
    expect(Web.judge(rule, { ...ok, certExpires: now - DAY }, now).title).toContain('sejak 1 hari lalu');
    expect(Web.judge(rule, { ...ok, certExpires: now + 60 * DAY }, now).severity).toBeNull();
  });
  it('notifikasi hanya setelah pemeriksaan buruk berturut-turut, sekali saat naik, dan sekali saat pulih', () => {
    const warn: Web.Verdict = { severity: 'peringatan', title: 't', detail: '' }, crit: Web.Verdict = { ...warn, severity: 'kritis' }, good: Web.Verdict = { severity: null, title: 'Sehat', detail: '' };
    let s = { bad_count: 0, alert_level: '' as string };
    const step = (v: Web.Verdict, confirm = 2) => { const t = Web.transition(s, v, confirm); s = { bad_count: t.bad_count, alert_level: t.alert_level }; return t.notify; };
    expect(step(crit)).toBeNull(); expect(step(crit)).toBe('baru'); expect(step(crit)).toBeNull();   // tidak berulang
    expect(step(good)).toBe('pulih'); expect(step(good)).toBeNull();
    expect(step(crit)).toBeNull(); expect(step(good)).toBeNull();   // sempat buruk sekali lalu pulih: tidak berisik
    expect(step(warn)).toBeNull(); expect(step(warn)).toBe('baru'); expect(step(crit)).toBe('naik'); expect(step(warn)).toBeNull();
  });
});

describe('probe sungguhan', () => {
  let srv: http.Server, base = '';
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/ok') { res.end('halo'); } else if (req.url === '/gagal') { res.statusCode = 503; res.end('x'); }
      else if (req.url === '/pindah') { res.statusCode = 302; res.setHeader('location', '/ok'); res.end(); }
      else if (req.url === '/meta') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/latest'); res.end(); }
      else if (req.url === '/loop') { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); }
      else if (req.url === '/lambat') { setTimeout(() => res.end('x'), 1500); } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }));

  it('status dan waktu tercatat; pengalihan diikuti', async () => {
    expect(await probe(base + '/ok', 3000)).toMatchObject({ ok: true, code: 200 });
    expect(await probe(base + '/gagal', 3000)).toMatchObject({ ok: true, code: 503 });
    expect((await probe(base + '/pindah', 3000)).code).toBe(200);
  });
  it('pengalihan ke alamat metadata diblokir, pengalihan tanpa ujung dihentikan, waktu habis dilaporkan', async () => {
    expect(await probe(base + '/meta', 3000)).toMatchObject({ ok: false, code: null, error: expect.stringContaining('diblokir') });
    expect(await probe(base + '/loop', 3000)).toMatchObject({ ok: false, error: 'Terlalu banyak pengalihan' });
    expect(await probe(base + '/lambat', 400)).toMatchObject({ ok: false, code: null, error: expect.stringContaining('Waktu habis') });
  });
  it('server mati: galat jaringan, bukan crash', async () => {
    const r = await probe('http://127.0.0.1:1/', 2000); expect(r.ok).toBe(false); expect(r.code).toBeNull(); expect(r.error).toMatch(/ECONNREFUSED|refused/i);
  });
});

describe('cek HTTP lewat API', () => {
  let h: Harness, srv: http.Server, base = '', status = 200, hooks: string[] = [];
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/hook') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(b); res.end('ok'); }); return; }
      res.statusCode = status; res.end('x');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    h = await harness(); await login(h);
  });
  afterAll(async () => { srv.closeAllConnections(); srv.close(); await h.close(); });

  it('validasi: URL metadata, skema aneh, dan kolom di luar batas ditolak', async () => {
    for (const body of [{ name: 'a', url: 'http://169.254.169.254/' }, { name: 'a', url: 'ftp://x' }, { name: '', url: base }, { name: 'a', url: base, interval_s: 5 }, { name: 'a', url: base, expect_status: 42 }]) {
      expect((await h.call('POST', '/api/webchecks', body)).status, JSON.stringify(body)).toBe(400);
    }
  });
  it('alur lengkap: tambah, jalankan, riwayat, notifikasi saat mati dan pulih, ubah, hapus', async () => {
    expect((await h.call('POST', '/api/channels', { type: 'webhook', name: 'tes', config: { url: base + '/hook' }, min_level: 'semua' })).status).toBe(200);
    const c = (await h.call('POST', '/api/webchecks', { name: 'Situs saya', url: base + '/', confirm: 2, slow_ms: 5000 })).json;
    expect(c).toMatchObject({ name: 'Situs saya', last_status: 'belum', confirm: 2 });
    const run = async () => (await h.call('POST', `/api/webchecks/${c.id}/run`)).json;
    expect((await run()).verdict.severity).toBeNull();
    status = 500; await run(); expect(hooks).toHaveLength(0);   // sekali buruk belum memberi tahu
    await run(); await new Promise((r) => setTimeout(r, 300)); expect(hooks).toHaveLength(1); expect(hooks[0]).toContain('Status 500');
    await run(); await new Promise((r) => setTimeout(r, 200)); expect(hooks).toHaveLength(1);   // tidak berulang
    status = 200; await run(); await new Promise((r) => setTimeout(r, 300)); expect(hooks).toHaveLength(2); expect(hooks[1]).toContain('Kembali normal');

    const list = (await h.call('GET', '/api/webchecks')).json.find((x: { id: number }) => x.id === c.id);
    expect(list).toMatchObject({ last_status: 'sehat', samples24h: 5, alert_level: '' }); expect(list.uptime24h).toBe(40);   // 2 dari 5 sehat
    const res = (await h.call('GET', `/api/webchecks/${c.id}/results`)).json; expect(res).toHaveLength(5); expect(res[1]).toMatchObject({ ok: false, code: 500 });
    const up = await h.call('PATCH', `/api/webchecks/${c.id}`, { name: 'Situs baru', slow_ms: 3000 }); expect(up.json).toMatchObject({ name: 'Situs baru', slow_ms: 3000, url: base + '/' });
    expect((await h.call('PATCH', `/api/webchecks/${c.id}`, { url: 'http://169.254.169.254/' })).status).toBe(400);
    const audit = (await h.call('GET', '/api/audit')).json.map((x: { action: string }) => x.action); expect(audit).toEqual(expect.arrayContaining(['webcheck.tambah', 'webcheck.ubah']));
    expect((await h.call('DELETE', `/api/webchecks/${c.id}`)).status).toBe(200); expect((await h.call('POST', `/api/webchecks/${c.id}/run`)).status).toBe(400);
  });
  it('penjadwal menjalankan yang jatuh tempo saja, dan satu kali per interval', async () => {
    status = 200;
    const a = (await h.call('POST', '/api/webchecks', { name: 'Jadwal', url: base + '/', interval_s: 3600 })).json, b = (await h.call('POST', '/api/webchecks', { name: 'Mati', url: base + '/', enabled: false })).json;
    await Web.runDue(); await Web.runDue();
    const rows = (await h.call('GET', '/api/webchecks')).json;
    expect(rows.find((x: { id: number }) => x.id === a.id).samples24h).toBe(1);   // panggilan kedua belum jatuh tempo
    expect(rows.find((x: { id: number }) => x.id === b.id).samples24h).toBe(0);   // nonaktif tidak dijalankan
  });
});

describe('pengumpul Vercel', () => {
  const now = 1_000_000_000_000, dep = (over: Record<string, unknown>) => ({ uid: 'dpl_1', readyState: 'READY', created: now - 60_000, ...over });
  it('menilai deploy produksi terakhir: gagal kritis, macet peringatan, dibatalkan diabaikan', () => {
    expect(Vercel.deploymentVerdict([], now)).toMatchObject({ severity: null, title: 'Belum ada deploy produksi' });
    expect(Vercel.deploymentVerdict([dep({})], now)).toMatchObject({ severity: null, title: 'Sehat' });
    expect(Vercel.deploymentVerdict([dep({ uid: 'lama', created: now - 9e6 }), dep({ uid: 'baru', readyState: 'ERROR', errorCode: 'BUILD_FAILED', errorMessage: 'Build gagal', created: now - 1000 })], now))
      .toMatchObject({ severity: 'kritis', title: 'Deploy produksi terakhir gagal', detail: expect.stringContaining('BUILD_FAILED') });
    expect(Vercel.deploymentVerdict([dep({}), dep({ uid: 'x', readyState: 'CANCELED', created: now - 10 })], now).severity).toBeNull();   // yang dibatalkan tidak dianggap terbaru
    expect(Vercel.deploymentVerdict([dep({ readyState: 'BUILDING', created: now - 5 * 60_000 })], now).severity).toBeNull();
    expect(Vercel.deploymentVerdict([dep({ readyState: 'BUILDING', created: now - 45 * 60_000 })], now)).toMatchObject({ severity: 'peringatan', title: expect.stringContaining('macet') });
    expect(Vercel.deploymentVerdict([dep({ readyState: 'BLOCKED' })], now).severity).toBe('peringatan');
  });

  let h: Harness, calls: Array<{ url: string; auth: string }> = [], reply: { status: number; body: unknown } = { status: 200, body: { deployments: [dep({ created: Date.now() - 1000 })] } };
  beforeAll(async () => {
    Web.configure({ fetch: (async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, auth: init.headers.authorization! }); return { status: reply.status, json: async () => reply.body }; }) as never });
    h = await harness(); await login(h);
  });
  afterAll(async () => { await h.close(); });
  const body = (over: object = {}) => ({ kind: 'vercel', name: 'Toko di Vercel', interval_s: 300, confirm: 1, vercel: { token: 'vercel-token-rahasia-123', project: 'tokoku', teamId: 'team_abc' }, ...over });

  it('validasi: token dan proyek wajib, interval minimal 300 dtk', async () => {
    expect((await h.call('POST', '/api/webchecks', body({ vercel: undefined }))).status).toBe(400);
    expect((await h.call('POST', '/api/webchecks', body({ vercel: { token: 'x', project: 'p' } }))).status).toBe(400);
    expect((await h.call('POST', '/api/webchecks', body({ interval_s: 60 }))).status).toBe(400);
  });
  it('token terenkripsi dan tak pernah dikembalikan; permintaan ke api.vercel.com berisi Bearer, proyek, target produksi, dan tim', async () => {
    const c = (await h.call('POST', '/api/webchecks', body())).json;
    expect(c).toMatchObject({ kind: 'vercel', url: 'vercel:tokoku', has_token: true }); expect(JSON.stringify(c)).not.toContain('vercel-token-rahasia');
    const raw = await h.db.one<{ provider_enc: string }>('SELECT provider_enc FROM web_checks WHERE id=$1', [c.id]); expect(raw!.provider_enc).not.toContain('vercel-token'); expect(raw!.provider_enc.length).toBeGreaterThan(20);
    const run = (await h.call('POST', `/api/webchecks/${c.id}/run`)).json; expect(run.verdict.severity).toBeNull();
    expect(calls.at(-1)).toMatchObject({ auth: 'Bearer vercel-token-rahasia-123' });
    const u = new URL(calls.at(-1)!.url); expect(u.origin + u.pathname).toBe('https://api.vercel.com/v7/deployments'); expect(Object.fromEntries(u.searchParams)).toMatchObject({ projectId: 'tokoku', target: 'production', teamId: 'team_abc' });
    expect(JSON.stringify((await h.call('GET', '/api/webchecks')).json)).not.toContain('vercel-token-rahasia');
  });
  it('deploy gagal memberi peringatan kritis; token ditolak dijelaskan; ganti token tidak membocorkan yang lama', async () => {
    const c = (await h.call('POST', '/api/webchecks', body({ name: 'Gagal' }))).json, run = async () => (await h.call('POST', `/api/webchecks/${c.id}/run`)).json;
    reply = { status: 200, body: { deployments: [dep({ readyState: 'ERROR', errorCode: 'BUILD_FAILED', created: Date.now() })] } };
    expect((await run()).verdict).toMatchObject({ severity: 'kritis', title: 'Deploy produksi terakhir gagal' });
    reply = { status: 401, body: {} }; expect((await run()).verdict.title).toBe('Token Vercel ditolak');
    reply = { status: 404, body: {} }; expect((await run()).verdict.title).toBe('Proyek Vercel tidak ditemukan');
    const up = (await h.call('PATCH', `/api/webchecks/${c.id}`, { vercel: { token: 'token-baru-yang-panjang' } })).json; expect(up).toMatchObject({ url: 'vercel:tokoku', has_token: true });
    reply = { status: 200, body: { deployments: [dep({ created: Date.now() })] } }; await run(); expect(calls.at(-1)!.auth).toBe('Bearer token-baru-yang-panjang'); expect(new URL(calls.at(-1)!.url).searchParams.get('projectId')).toBe('tokoku');
    expect((await h.call('PATCH', `/api/webchecks/${c.id}`, { interval_s: 60 })).status).toBe(400);
  });
});

describe('ubah sebagian tidak mereset kolom lain', () => {
  it('PATCH nama saja mempertahankan interval, batas lambat, dan jumlah konfirmasi', async () => {
    const h = await harness(); await login(h);
    try {
      const c = (await h.call('POST', '/api/webchecks', { name: 'A', url: 'http://127.0.0.1:9/', interval_s: 120, slow_ms: 700, confirm: 4 })).json;
      const up = (await h.call('PATCH', `/api/webchecks/${c.id}`, { name: 'B' })).json;
      expect(up).toMatchObject({ name: 'B', interval_s: 120, slow_ms: 700, confirm: 4, url: 'http://127.0.0.1:9/' });
    } finally { await h.close(); }
  });
});
