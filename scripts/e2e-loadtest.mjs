#!/usr/bin/env node
// Uji ujung-ke-ujung NYATA fitur Uji beban: k6 sungguhan (kontainer loadgen) menyerang aplikasi demo (demo-api) bertahap, lalu dicek
// bahwa hasil per tahap, deteksi "lutut", metrik server uji, penolakan target publik, dan pembatalan bekerja.
// Prasyarat: docker compose --profile demo --profile loadtest up -d --build   (dan ALLOWED_HOSTS memuat "app" di .env)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4317', PW = readFileSync(join(import.meta.dirname, '..', 'secrets', 'admin_password.txt'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  GAGAL ' + m); } };
let cookie = '';
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-aiops': '1', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  return { status: r.status, json };
}
const until = async (fn, ms, step = 1000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

const base = {
  confirmNotProduction: true, thinkSeconds: 1, headers: {}, criteria: { p95Ms: 500, errPct: 1 },
  requests: [{ name: 'produk', method: 'GET', path: '/produk', weight: 70 }, { name: 'checkout', method: 'POST', path: '/checkout', weight: 20, body: '{"item":1}' }, { name: 'laporan', method: 'GET', path: '/laporan', weight: 10 }],
  scrape: [{ label: 'pool terpakai', url: 'http://demo-api:8080/metrics', metric: 'demo_db_pool_in_use' }, { label: 'antre pool', url: 'http://demo-api:8080/metrics', metric: 'demo_db_pool_waiting' }]
};

console.log('Persiapan');
ok((await api('POST', '/api/login', { username: 'admin', password: PW })).status === 200, 'login ke aplikasi');
const st = (await api('GET', '/api/loadtests/status')).json; ok(st && st.enabled === true, 'fitur uji beban aktif (LOADGEN_SECRET terpasang)');
for (const t of (await api('GET', '/api/loadtests')).json || []) { await api('POST', `/api/loadtests/${t.id}/cancel`); }
await sleep(1000);

console.log('Keamanan target');
for (const target of ['https://example.com', 'http://8.8.8.8', 'http://demo-api:8080/admin']) {
  const r = await api('POST', '/api/loadtests', { ...base, name: 'ditolak', target, stages: [{ vus: 1, seconds: 5 }] });
  ok(r.status === 400, `target ${target} ditolak (${(r.json && r.json.error || '').slice(0, 60)})`);
}
ok((await api('POST', '/api/loadtests', { ...base, name: 'tanpa konfirmasi', target: 'http://demo-api:8080', confirmNotProduction: false, stages: [{ vus: 1, seconds: 5 }] })).status === 400, 'tanpa konfirmasi "bukan produksi" ditolak');

console.log('Uji bertahap terhadap aplikasi demo (k6 sungguhan)');
const created = await api('POST', '/api/loadtests', { ...base, name: 'Demo bertahap', target: 'http://demo-api:8080', stages: [{ vus: 5, seconds: 8 }, { vus: 20, seconds: 8 }, { vus: 80, seconds: 8 }, { vus: 250, seconds: 8 }] });
ok(created.status === 200 && created.json.status === 'draft', 'uji dibuat sebagai draf (belum berjalan)');
await sleep(3000); ok((await api('GET', `/api/loadtests/${created.json.id}`)).json.status === 'draft', 'draf tidak berjalan sendiri: runner hanya mengambil yang disetujui');
ok((await api('POST', `/api/loadtests/${created.json.id}/run`)).json.status === 'queued', 'disetujui: masuk antrean');
const done = await until(async () => { const g = (await api('GET', `/api/loadtests/${created.json.id}`)).json; return ['done', 'failed', 'cancelled'].includes(g.status) ? g : null; }, 150000, 2000);
ok(done && done.status === 'done', 'uji selesai' + (done && done.status !== 'done' ? `: ${done.status} ${done.error}` : ''));
if (done) {
  ok(done.stages.length === 4, `4 tahap dilaporkan (${done.stages.length})`);
  const [a, b, c, d] = done.stages;
  ok(a.rps > 2 && a.reqs > 10, `tahap 1 menghasilkan lalu lintas nyata (${a.rps.toFixed(1)} req/dtk, ${a.reqs} request)`);
  ok(d.p95 > a.p95 * 3, `p95 naik tajam saat beban naik: ${a.p95.toFixed(0)} ms -> ${d.p95.toFixed(0)} ms`);
  ok(d.rps < d.vus * 0.8 || d.p95 > 500, `pada 250 pengguna sistem jenuh (throughput ${d.rps.toFixed(0)} req/dtk, p95 ${d.p95.toFixed(0)} ms)`);
  ok(done.analysis.knee && done.analysis.knee.vus >= 20, `lutut terdeteksi di ${done.analysis.knee && done.analysis.knee.vus} pengguna: ${done.analysis.knee && done.analysis.knee.reason}`);
  ok(done.analysis.healthy && done.analysis.healthy.vus < done.analysis.knee.vus, `kapasitas sehat terakhir: ${done.analysis.healthy && done.analysis.healthy.vus} pengguna (≈ ${done.analysis.healthy && done.analysis.healthy.rps.toFixed(1)} req/dtk)`);
  const pool = d.scraped['pool terpakai'], wait = d.scraped['antre pool'];
  ok(pool && pool.max >= 4, `metrik server uji terbaca: pool database penuh di tahap terberat (maks ${pool && pool.max} dari 4)`);
  ok(wait && wait.max >= 1, `antrean pool tercatat saat jenuh (maks ${wait && wait.max}) = bukti leher botol ada di pool koneksi database`);
  ok(a.scraped['pool terpakai'].max < pool.max, 'metrik tahap ringan lebih rendah daripada tahap berat (penelusuran per tahap benar)');
  ok(done.stages.every((s) => s.gen_cpu >= 0 && s.gen_cpu <= 1) && done.stages.some((s) => s.gen_cpu > 0), `CPU pembangkit terukur per tahap (${done.stages.map((s) => Math.round(s.gen_cpu * 100) + '%').join(', ')})`);
  ok(done.runner && /k6 v0\.54/.test(done.runner.k6) && done.runner.cpus >= 0.5, `info runner tercatat (${done.runner && done.runner.k6}, ${done.runner && done.runner.cpus} CPU)`);
  console.log('  ringkasan: ' + done.analysis.verdict.title);
}

console.log('Pembatalan');
const long = await api('POST', '/api/loadtests', { ...base, name: 'Demo panjang', target: 'http://demo-api:8080', stages: [{ vus: 10, seconds: 120 }] });
await api('POST', `/api/loadtests/${long.json.id}/run`);
ok(await until(async () => (await api('GET', `/api/loadtests/${long.json.id}`)).json.status === 'running', 30000), 'uji panjang mulai berjalan');
await sleep(3000);
const t0 = Date.now(); await api('POST', `/api/loadtests/${long.json.id}/cancel`);
const cancelled = await until(async () => (await api('GET', `/api/loadtests/${long.json.id}`)).json.status === 'cancelled', 40000, 1000);
ok(!!cancelled, `pembatalan menghentikan k6 (${Math.round((Date.now() - t0) / 1000)} dtk, bukan menunggu 120 dtk)`);

console.log('Pembersihan');
for (const id of [created.json.id, long.json.id]) await api('DELETE', `/api/loadtests/${id}`);
console.log(`\n${pass} lolos, ${fail} gagal`); process.exit(fail ? 1 : 0);
