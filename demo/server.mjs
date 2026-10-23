// Aplikasi contoh untuk MENGUJI fitur Uji beban (bukan aplikasi sungguhan): API kecil dengan sumber daya terbatas yang sengaja bisa jenuh.
//   GET  /produk    baca ringan   : CPU 2 ms + query 4 ms
//   POST /checkout  tulis         : CPU 5 ms + query 15 ms + menunggu pembayaran 100 ms (tidak memegang koneksi database)
//   GET  /laporan   baca berat    : CPU 3 ms + query 400 ms (memegang koneksi database lama)
//   GET  /metrics   teks Prometheus (pool database, antrean, lag event loop)
// Leher botolnya: pool koneksi database kecil (DB_POOL, bawaan 4). Laporan yang jarang tetapi lama menghabiskan koneksi, jadi semua request ikut mengantre.
import http from 'node:http';

const PORT = Number(process.env.PORT || 8080), POOL = Number(process.env.DB_POOL || 4), WAIT_MS = Number(process.env.DB_WAIT_MS || 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spin = (ms) => { const t = process.hrtime.bigint() + BigInt(ms) * 1_000_000n; while (process.hrtime.bigint() < t); };

let inUse = 0, requests = 0, rejected = 0, lagMax = 0;
const waiting = [];

/** Pool koneksi: ambil satu, tahan selama `ms`, lepas. Bila antre lebih dari WAIT_MS, request gagal (seperti timeout pool sungguhan). */
async function withDb(ms) {
  if (inUse >= POOL) {
    const ok = await new Promise((resolve) => {
      const w = { resolve };
      w.timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); resolve(false); }, WAIT_MS);
      waiting.push(w);
    });
    if (!ok) throw new Error('pool koneksi habis');
  } else inUse++;
  try { await sleep(ms); } finally {
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(true); } else inUse--;
  }
}

const handlers = {
  'GET /produk': async () => { spin(2); await withDb(4); return { produk: 'ok' }; },
  'POST /checkout': async () => { spin(5); await withDb(15); await sleep(100); return { checkout: 'ok' }; },
  'GET /laporan': async () => { spin(3); await withDb(400); return { laporan: 'ok' }; },
  'GET /health': async () => ({ ok: true })
};

let last = process.hrtime.bigint();
setInterval(() => { const now = process.hrtime.bigint(), lag = Number(now - last) / 1e9 - 0.1; last = now; if (lag > lagMax) lagMax = lag; }, 100).unref();

function metrics() {
  const lag = lagMax; lagMax = 0;
  return [
    '# TYPE demo_db_pool_size gauge', `demo_db_pool_size ${POOL}`,
    '# TYPE demo_db_pool_in_use gauge', `demo_db_pool_in_use ${inUse}`,
    '# TYPE demo_db_pool_waiting gauge', `demo_db_pool_waiting ${waiting.length}`,
    '# TYPE demo_requests_total counter', `demo_requests_total ${requests}`,
    '# TYPE demo_rejected_total counter', `demo_rejected_total ${rejected}`,
    '# TYPE demo_event_loop_lag_seconds gauge', `demo_event_loop_lag_seconds ${Math.max(0, lag).toFixed(4)}`,
    '# TYPE process_cpu_seconds_total counter', `process_cpu_seconds_total ${(process.cpuUsage().user + process.cpuUsage().system) / 1e6}`, ''
  ].join('\n');
}

http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && path === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(metrics()); return; }
  const h = handlers[`${req.method} ${path}`];
  if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"tidak ada"}'); return; }
  req.resume();
  requests++;
  try { const body = await h(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  catch (e) { rejected++; res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
}).listen(PORT, () => console.log(`demo-api di :${PORT}, pool database ${POOL}`));
