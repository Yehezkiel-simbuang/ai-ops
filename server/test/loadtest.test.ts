import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, type StageRow } from '../src/loadtest/analysis.js';
import { checkTarget } from '../src/loadtest/safety.js';
import * as Explain from '../src/loadtest/explain.js';
import * as Store from '../src/loadtest/store.js';
import { harness, login, type Harness } from './helpers.js';

const SECRET = 'rahasia-pembangkit-beban-1234567890';
const ALLOWED = ['staging.contoh.com', '.uji.contoh.com'];

describe('keamanan target', () => {
  it('menerima alamat privat/lokal dan nama layanan tanpa titik; hanya origin yang disimpan', () => {
    for (const u of ['http://10.0.0.5:8080', 'http://192.168.1.20', 'http://172.20.0.3:3000', 'http://127.0.0.1:4317', 'http://localhost:8080', 'http://demo-api:8080', 'http://[::1]:8080', 'http://[fd00::5]/', 'http://[::ffff:10.1.2.3]:80']) {
      expect(() => checkTarget(u, []), u).not.toThrow();
    }
    expect(checkTarget('http://10.0.0.5:8080/', []).origin).toBe('http://10.0.0.5:8080');
    expect(checkTarget('http://10.0.0.5:8080', []).allowPublic).toBe(false);
  });
  it('menolak alamat publik, termasuk yang mirip privat', () => {
    for (const u of ['http://8.8.8.8', 'https://example.com', 'http://172.32.0.1', 'http://11.0.0.1', 'http://192.169.0.1', 'http://[2001:db8::1]/', 'http://0.0.0.0:80x']) {
      expect(() => checkTarget(u, []), u).toThrow();
    }
  });
  it('menolak bentuk berbahaya: kredensial di URL, path, query, skema lain', () => {
    for (const u of ['http://user:pw@10.0.0.5', 'http://10.0.0.5/admin', 'http://10.0.0.5/?x=1', 'ftp://10.0.0.5', 'file:///etc/passwd', 'not-a-url']) expect(() => checkTarget(u, []), u).toThrow();
  });
  it('host publik hanya boleh bila Anda daftarkan sendiri (persis atau subdomain berawalan titik)', () => {
    expect(checkTarget('https://staging.contoh.com', ALLOWED)).toMatchObject({ allowPublic: true, origin: 'https://staging.contoh.com' });
    expect(checkTarget('https://a.uji.contoh.com', ALLOWED).allowPublic).toBe(true);
    expect(() => checkTarget('https://contoh.com', ALLOWED)).toThrow(/bukan alamat privat/);
    expect(() => checkTarget('https://evilstaging.contoh.com', ALLOWED)).toThrow();
  });
});

describe('analisis hasil bertahap', () => {
  const crit = { p95Ms: 500, errPct: 1 };
  const st = (idx: number, vus: number, rps: number, p95: number, errPct = 0, genCpu = 0.2): StageRow => ({ idx, vus, seconds: 30, rps, p95, errPct, genCpu, valid: genCpu <= 0.7 });
  it('menemukan tahap sehat terakhir dan lutut, serta dataran throughput', () => {
    const a = analyze([st(0, 10, 9, 80), st(1, 25, 22, 120), st(2, 50, 40, 450), st(3, 100, 41, 2500), st(4, 200, 40, 9000, 12)], crit, true);
    expect(a.healthy).toMatchObject({ vus: 50, rps: 40 }); expect(a.knee).toMatchObject({ idx: 3, vus: 100 }); expect(a.knee!.reason).toMatch(/p95 2500 ms melebihi batas 500 ms/);
    expect(a.plateau).toMatchObject({ fromVus: 50 }); expect(a.verdict.tone).toBe('warn'); expect(a.verdict.title).toContain('Sehat sampai 50 pengguna');
  });
  it('semua sehat: hijau; sejak awal tidak sehat: merah; tanpa hasil: netral', () => {
    expect(analyze([st(0, 10, 9, 80), st(1, 25, 22, 100)], crit, true).verdict.tone).toBe('ok');
    expect(analyze([st(0, 10, 9, 900)], crit, true).verdict).toMatchObject({ tone: 'bad', title: 'Tidak sehat sejak tahap pertama' });
    expect(analyze([], crit, false).verdict.tone).toBe('mute');
  });
  it('pembangkit yang terlalu sibuk membuat hasil ditandai tidak murni, bukan disimpulkan sebagai leher botol server', () => {
    const a = analyze([st(0, 10, 9, 80), st(1, 400, 30, 3000, 5, 0.95)], crit, true);
    expect(a.invalidStages).toEqual([1]); expect(a.verdict.title).toBe('Sebagian hasil tidak murni'); expect(a.verdict.text).toContain('pembangkitnya');
  });
  it('kenaikan throughput wajar bukan dataran', () => {
    expect(analyze([st(0, 10, 9, 80), st(1, 20, 18, 90), st(2, 40, 35, 100)], crit, true).plateau).toBeNull();
  });
});

describe('uji beban: API, persetujuan, dan runner', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness({ LOADGEN_SECRET: SECRET, LOADTEST_ALLOWED_HOSTS: ALLOWED.join(',') }); await login(h); });
  afterAll(async () => { await h.close(); });

  const body = (over: Record<string, unknown> = {}) => ({
    name: 'Uji toko', target: 'http://10.0.0.5:8080', confirmNotProduction: true, requests: [{ name: 'produk', method: 'GET', path: '/produk', weight: 8 }, { name: 'checkout', method: 'POST', path: '/checkout', weight: 1, body: '{"a":1}' }],
    thinkSeconds: 1, headers: { Authorization: 'Bearer staging-token-rahasia' }, stages: [{ vus: 5, seconds: 10 }, { vus: 20, seconds: 10 }], criteria: { p95Ms: 500, errPct: 1 }, scrape: [{ label: 'app', url: 'http://10.0.0.5:8080/metrics', metric: 'demo_db_pool_in_use' }], ...over
  });
  const runner = async (method: string, url: string, payload?: unknown, token = SECRET) => {
    const r = await h.app.inject({ method: method as never, url, headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: payload === undefined ? '{}' : (payload as object) });
    let json: any = null; try { json = r.json(); } catch { /* bukan JSON */ }
    return { statusCode: r.statusCode, json };
  };

  it('membuat draf: konfirmasi bukan-produksi wajib, header tersimpan terenkripsi dan tak pernah dikembalikan', async () => {
    expect((await h.call('POST', '/api/loadtests', body({ confirmNotProduction: false }))).status).toBe(400);
    const r = await h.call('POST', '/api/loadtests', body()); expect(r.status).toBe(200);
    expect(r.json.status).toBe('draft'); expect(r.json.scenario.headerNames).toEqual(['Authorization']); expect(JSON.stringify(r.json)).not.toContain('staging-token-rahasia');
    const raw = await h.db.one<{ headers_enc: string }>('SELECT headers_enc FROM load_tests WHERE id=$1', [r.json.id]); expect(raw!.headers_enc).not.toContain('staging-token'); expect(raw!.headers_enc.length).toBeGreaterThan(20);
    const g = await h.call('GET', `/api/loadtests/${r.json.id}`); expect(JSON.stringify(g.json)).not.toContain('staging-token');
  });

  it('masukan berbahaya atau tidak masuk akal ditolak', async () => {
    const bad = async (over: Record<string, unknown>) => (await h.call('POST', '/api/loadtests', body(over))).status;
    expect(await bad({ target: 'https://example.com' })).toBe(400);
    expect(await bad({ target: 'http://10.0.0.5/path' })).toBe(400);
    expect(await bad({ scrape: [{ label: 'x', url: 'https://example.com/metrics', metric: 'm' }] })).toBe(400);
    expect(await bad({ requests: [{ name: 'x', method: 'GET', path: 'tanpa-slash', weight: 1 }] })).toBe(400);
    expect(await bad({ requests: [{ name: 'x', method: 'GET', path: 'http://evil.example/x', weight: 1 }] })).toBe(400);
    expect(await bad({ headers: { Host: 'evil.example' } })).toBe(400);
    expect(await bad({ stages: Array.from({ length: 13 }, () => ({ vus: 1, seconds: 5 })) })).toBe(400);
    expect(await bad({ stages: [{ vus: 5000, seconds: 10 }] })).toBe(400);
    expect(await bad({ stages: [{ vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }] })).toBe(400);   // total > 3600 dtk
    expect(await bad({ requests: [] })).toBe(400);
    expect((await h.call('POST', '/api/loadtests', body({ target: 'https://staging.contoh.com' }))).json.allow_public).toBe(true);
  });

  it('runner wajib bearer yang benar; tanpa persetujuan runner tidak mendapat apa pun', async () => {
    expect((await runner('POST', '/loadgen/v1/next', {}, 'salah')).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/loadgen/v1/next', headers: { host: 'localhost', 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(401);
    for (const t of await h.call('GET', '/api/loadtests').then((r) => r.json as Array<{ id: number }>)) await h.db.exec("UPDATE load_tests SET status='cancelled' WHERE id=$1 AND status='draft'", [t.id]);   // bersihkan draf sebelumnya
    expect((await runner('POST', '/loadgen/v1/next', {})).json).toEqual({ job: null });
  });

  it('alur penuh: setujui -> runner mengambil (atomik) -> melapor tahap -> selesai; hasil dianalisis', async () => {
    const created = (await h.call('POST', '/api/loadtests', body({ name: 'Alur penuh' }))).json;
    const run = await h.call('POST', `/api/loadtests/${created.id}/run`); expect(run.status).toBe(200); expect(run.json.status).toBe('queued'); expect(run.json.approved_by).toBe('admin');
    expect((await h.call('POST', `/api/loadtests/${created.id}/run`)).status).toBe(400);   // sudah antre
    const second = await h.call('POST', '/api/loadtests', body({ name: 'Kedua' })); expect((await h.call('POST', `/api/loadtests/${second.json.id}/run`)).status).toBe(400);   // satu uji pada satu waktu

    const info = { k6: '0.52', cpus: 1, version: '1.0.0' };   // dua runner bersaing; siapa pun yang menang, info yang tercatat sama
    const [a, b] = await Promise.all([runner('POST', '/loadgen/v1/next', info), runner('POST', '/loadgen/v1/next', info)]);
    const jobs = [a.json.job, b.json.job].filter(Boolean); expect(jobs).toHaveLength(1);   // hanya satu runner yang mendapat uji
    const job = jobs[0]; expect(job).toMatchObject({ id: created.id, target: 'http://10.0.0.5:8080', allowPublic: false });
    expect(job.headers).toEqual({ Authorization: 'Bearer staging-token-rahasia' }); expect(job.stages).toHaveLength(2); expect(job.requests[1].body).toBe('{"a":1}');

    const stage = (idx: number, vus: number, rps: number, p95: number, over: Record<string, unknown> = {}) => ({ idx, vus, seconds: 10, started: 1000 * idx, ended: 1000 * idx + 10000, reqs: rps * 10, rps, p50: p95 / 3, p95, p99: p95 * 1.5, errPct: 0, genCpu: 0.2, scraped: { app: { avg: 3, max: 8, last: 5 } }, ...over });
    expect((await runner('POST', `/loadgen/v1/jobs/${created.id}/stage`, stage(0, 5, 4.5, 80))).json).toEqual({ cancel: false });
    await runner('POST', `/loadgen/v1/jobs/${created.id}/stage`, stage(1, 20, 18, 900, { errPct: 3 }));
    expect((await runner('POST', `/loadgen/v1/jobs/${created.id}/stage`, { idx: 0 })).statusCode).toBe(400);   // laporan tidak valid
    expect((await runner('POST', `/loadgen/v1/jobs/${created.id}/heartbeat`)).json).toEqual({ cancel: false });
    expect((await runner('POST', `/loadgen/v1/jobs/${created.id}/finish`, { status: 'done' })).json).toEqual({ ok: true });
    expect((await runner('POST', `/loadgen/v1/jobs/${created.id}/stage`, stage(2, 50, 1, 1))).statusCode).toBe(400);   // sudah selesai

    const g = (await h.call('GET', `/api/loadtests/${created.id}`)).json;
    expect(g.status).toBe('done'); expect(g.plan).toEqual([{ vus: 5, seconds: 10 }, { vus: 20, seconds: 10 }]); expect(g.stages).toHaveLength(2); expect(g.stages[1]).toMatchObject({ vus: 20, p95: 900, scraped: { app: { max: 8 } } });
    expect(g.analysis.healthy).toMatchObject({ vus: 5 }); expect(g.analysis.knee).toMatchObject({ vus: 20 }); expect(g.runner).toMatchObject({ cpus: 1, k6: '0.52' });
    const l = (await h.call('GET', '/api/loadtests')).json; expect(l.find((x: { id: number }) => x.id === created.id).analysis.verdict.title).toContain('Sehat sampai 5 pengguna');
    const audit = (await h.call('GET', '/api/audit')).json.map((x: { action: string }) => x.action); expect(audit).toEqual(expect.arrayContaining(['loadtest.setujui', 'loadtest.done']));
    // penjelasan AI: ditolak tanpa model; dengan model, prompt hanya berisi angka dan tanpa nilai header rahasia
    expect((await h.call('POST', `/api/loadtests/${created.id}/explain`)).status).toBe(400);
    await h.call('POST', '/api/provider', { id: 'lain', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }); await h.call('POST', '/api/role', { role: 'monitor', provider: 'lain', model: 'm-murah' });
    let seen = '', calls = 0, release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });   // menahan model supaya keadaan "sedang berjalan" bisa diperiksa
    Explain.configure({ llm: (async (_r: string, req: { messages: Array<{ content: string }> }) => { calls++; seen = req.messages[0]!.content; await gate; return { text: 'Dugaan: pool DB. Keyakinan sedang.', usage: { input: 10, output: 5 } }; }) as never });
    // diminta: langsung kembali "running"; penjelasan dikerjakan di server dan disimpan, jadi tidak hilang bila pengguna pindah halaman
    const ex = await h.call('POST', `/api/loadtests/${created.id}/explain`); expect(ex.status).toBe(200); expect(ex.json).toEqual({ status: 'running' });
    expect((await h.call('GET', `/api/loadtests/${created.id}`)).json.ai).toMatchObject({ status: 'running', text: '' });
    expect((await h.call('POST', `/api/loadtests/${created.id}/explain`)).json).toEqual({ status: 'running' });   // klik kedua tidak membayar model dua kali
    release(); await Explain.settled(); expect(calls).toBe(1);
    expect((await h.call('GET', `/api/loadtests/${created.id}`)).json.ai).toMatchObject({ status: 'done', text: expect.stringContaining('pool DB'), model: 'm-murah', error: '' });
    expect(seen).toContain('tahap 2: 20 pengguna'); expect(seen).not.toContain('staging-token-rahasia');
    // jawaban kosong (model penalaran kehabisan anggaran): dicatat gagal dengan alasan, tidak pernah "selesai" kosong; anggaran cukup besar untuk penalaran
    let budget = 0; Explain.configure({ llm: (async (_r: string, req: { maxTokens?: number }) => { budget = req.maxTokens ?? 0; return { text: '  ', usage: { input: 10, output: 700 } }; }) as never });
    await h.call('POST', `/api/loadtests/${created.id}/explain`); await Explain.settled();
    expect((await h.call('GET', `/api/loadtests/${created.id}`)).json.ai).toMatchObject({ status: 'failed', error: expect.stringContaining('jawaban kosong') }); expect(budget).toBeGreaterThanOrEqual(2000);
    // gagal: galatnya tersimpan dan terlihat, bukan hilang; bisa diminta lagi
    Explain.configure({ llm: (async () => { throw new Error('model tidak menjawab'); }) as never });
    await h.call('POST', `/api/loadtests/${created.id}/explain`); await Explain.settled();
    expect((await h.call('GET', `/api/loadtests/${created.id}`)).json.ai).toMatchObject({ status: 'failed', error: expect.stringContaining('model tidak menjawab') });
    // terhenti di tengah jalan (mis. aplikasi dimulai ulang): lewat batas waktu dianggap gagal, bukan "sedang berjalan" selamanya
    await h.db.exec("UPDATE load_tests SET ai_status='running', ai_ts=$1 WHERE id=$2", [Date.now() - 10 * 60_000, created.id]);
    expect((await h.call('GET', `/api/loadtests/${created.id}`)).json.ai).toMatchObject({ status: 'failed', error: expect.stringContaining('Terhenti') });
  });

  it('pembatalan: uji antre langsung batal; uji berjalan memberi tahu runner lewat balasan', async () => {
    const q = (await h.call('POST', '/api/loadtests', body({ name: 'Batal antre' }))).json; await h.call('POST', `/api/loadtests/${q.id}/run`);
    expect((await h.call('POST', `/api/loadtests/${q.id}/cancel`)).status).toBe(200); expect((await h.call('GET', `/api/loadtests/${q.id}`)).json.status).toBe('cancelled');
    const r = (await h.call('POST', '/api/loadtests', body({ name: 'Batal jalan' }))).json; await h.call('POST', `/api/loadtests/${r.id}/run`);
    expect((await runner('POST', '/loadgen/v1/next', {})).json.job.id).toBe(r.id);
    expect((await h.call('DELETE', `/api/loadtests/${r.id}`)).status).toBe(400);   // tidak boleh dihapus saat berjalan
    await h.call('POST', `/api/loadtests/${r.id}/cancel`);
    expect((await runner('POST', `/loadgen/v1/jobs/${r.id}/heartbeat`)).json).toEqual({ cancel: true });
    await runner('POST', `/loadgen/v1/jobs/${r.id}/finish`, { status: 'cancelled' });
    expect((await h.call('GET', `/api/loadtests/${r.id}`)).json.status).toBe('cancelled');
    expect((await h.call('DELETE', `/api/loadtests/${r.id}`)).status).toBe(200);
  });

  it('watchdog menutup uji yang runner-nya berhenti melapor; salin membuat draf baru', async () => {
    const t = (await h.call('POST', '/api/loadtests', body({ name: 'Runner hilang' }))).json; await h.call('POST', `/api/loadtests/${t.id}/run`);
    await runner('POST', '/loadgen/v1/next', {});
    expect(await Store.watchdog()).toBe(0);   // baru saja melapor
    expect(await Store.watchdog(Date.now() + 5 * 60_000)).toBe(1);
    const g = (await h.call('GET', `/api/loadtests/${t.id}`)).json; expect(g.status).toBe('failed'); expect(g.error).toMatch(/berhenti melapor/);
    const copy = await h.call('POST', `/api/loadtests/${t.id}/duplicate`); expect(copy.json.status).toBe('draft'); expect(copy.json.name).toContain('(ulang)');
    const job = await h.db.one<{ headers_enc: string }>('SELECT headers_enc FROM load_tests WHERE id=$1', [copy.json.id]); expect(job!.headers_enc.length).toBeGreaterThan(20);   // header ikut tersalin
  });

  it('status fitur: aktif bila LOADGEN_SECRET ada, memuat host yang diizinkan, dan menandai runner online setelah ia menghubungi aplikasi', async () => {
    const s = (await h.call('GET', '/api/loadtests/status')).json;
    expect(s).toMatchObject({ enabled: true, allowedHosts: ALLOWED, runner: { online: true, info: { k6: expect.any(String) } } });   // runner sudah memanggil /next di tes sebelumnya
    expect(s.runner.lastSeen).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('perbandingan uji dan ringkasan susunan', () => {
  it('uji yang dibuat dari susunan playground menyimpan ringkasannya; compare mengembalikan 2-4 uji, kurang dari itu ditolak', async () => {
    const h = await harness({ LOADGEN_SECRET: SECRET }); await login(h);
    try {
      const mk = async (name: string, playgroundId?: number) => (await h.call('POST', '/api/loadtests', { name, target: 'http://10.0.0.5:8080', confirmNotProduction: true, requests: [{ name: 'a', method: 'GET', path: '/', weight: 1 }], stages: [{ vus: 5, seconds: 10 }], playgroundId })).json;
      const srv = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'pg', host: '10.1.1.1', username: 'a', playground: true })).json.id;
      const pg = (await h.call('POST', '/api/playground', { server_id: srv, name: 'dgn-redis', compose: 'services:\n  app:\n    image: x:1\n    ports: ["8080:80"]\n    deploy: {resources: {limits: {cpus: "0.5", memory: 512m}}}\n' })).json;
      const a = await mk('A', pg.id), b = await mk('B');
      expect(a.setup).toEqual({ name: 'dgn-redis', services: [{ name: 'app', image: 'x:1', published: true, limit: { cpus: 0.5, memMb: 512 } }], limits: ['app: 0.5 CPU, 512m'] }); expect(b.setup).toBeNull();
      const c = await h.call('GET', `/api/loadtests/compare?ids=${a.id},${b.id}`); expect(c.status).toBe(200); expect(c.json.map((x: { name: string }) => x.name)).toEqual(['A', 'B']); expect(c.json[0].setup.name).toBe('dgn-redis');
      expect((await h.call('GET', `/api/loadtests/compare?ids=${a.id}`)).status).toBe(400); expect((await h.call('GET', '/api/loadtests/compare')).status).toBe(400);
    } finally { await h.close(); }
  });
});
