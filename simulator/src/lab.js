// Pelari lab: menjalankan simulasi tanpa tampilan dan menghasilkan bingkai per detik (untuk animasi di UI) serta ringkasan hasil.
//   simulate(arch, { load, seconds, warm, faults, failure }) -> { edges, frames, diags, summary, nodes, failure }
// Bingkai berisi beban tiap node, aliran request tiap sambungan, keadaan node (mati/failover/degradasi), dan diagnosis bottleneck dari mesin.
const Sim = require('./engine.js');
const Load = require('./load.js');
const Bench = require('./bench.js');
const Failures = require('./failures.js');
const Rng = require('./rng.js');

const r2 = function (x) { return Math.round(x * 100) / 100; };
const clamp01 = function (x) { return Math.max(0, Math.min(1, x)); };

/** Aliran (request/detik) tiap sambungan, dihitung dari laju workload dan peluang tiap panggilan. */
function flowsOf(arch, rates) {
  const flows = {}, byId = {}; arch.nodes.forEach(function (n) { byId[n.id] = n; });
  const proxies = arch.nodes.filter(function (n) { return n.type === 'proxy'; });
  const add = function (a, b, v) { if (!a || !b || a === b || !(v > 0)) return; const k = a + '>' + b; flows[k] = (flows[k] || 0) + v; };
  // bagian trafik yang dibuang/dilayani proxy tertentu (CDN: w.cdn, filter: w.shed); trafik yang masuk ke proxy = laju di origin / hasil kali yang lolos setelahnya
  const dropOf = function (p, w) { return p.id === 'x-cdn' ? (w.cdn || 0) : p.id === 'x-filter' ? (w.shed || 0) : 0; };
  arch.workloads.forEach(function (w) {
    const r = rates[w.id] || 0; if (!(r > 0)) return;
    let from = w.client;
    if (!w.async) {
      let cur = w.client;
      proxies.forEach(function (p, i) { let rest = 1; for (let j = i; j < proxies.length; j++) rest *= (1 - dropOf(proxies[j], w)); add(cur, p.id, r / (rest || 1)); cur = p.id; });
      add(cur, w.pool, r); from = w.pool;
    } else if (w.pool) { add(w.client, w.pool, r); from = w.pool; }   // pekerjaan antrean masuk langsung ke worker (sama dengan sambungan yang digambar mesin)
    (w.calls || []).forEach(function (c) {
      const out = r * (1 - (c.skipProb || 0));
      const targets = c.route && c.route.length ? (function () { const tot = c.route.reduce(function (s, x) { return s + x.w; }, 0); return c.route.map(function (x) { return { id: x.node, share: x.w / tot }; }); })() : [{ id: c.node, share: 1 }];
      targets.forEach(function (tg) {
        add(from, tg.id, out * tg.share);
        const n = byId[tg.id], commits = c.write ? out * tg.share * (c.writeProb == null ? 1 : c.writeProb) : 0;
        if (n && n.type === 'db' && n.disk && commits > 0 && n.flush !== 2) add(tg.id, n.disk, commits);
        if (n && n.type === 'db' && n.standby && commits > 0) add(tg.id, n.standby, commits);   // replikasi ke standby
      });
    });
  });
  Object.keys(flows).forEach(function (k) { flows[k] = r2(flows[k]); });
  return flows;
}

/** Beban tiap node pada satu detik: u = pemakaian 0..1, busy/cap = terpakai/kapasitas, q = antrean. */
function nodesOf(arch, sn) {
  const out = {};
  arch.nodes.forEach(function (n) {
    if (n.type === 'pool' && sn.pools[n.id]) { const p = sn.pools[n.id]; out[n.id] = { u: r2(clamp01(p.q > 0 ? 1 : p.busy / p.cap)), busy: p.busy, cap: p.cap, q: p.q }; }
    else if (n.type === 'db' && sn.dbs[n.id]) { const d = sn.dbs[n.id]; out[n.id] = { u: r2(clamp01(d.conn / d.connections)), busy: d.conn, cap: d.connections, q: d.connWait, lock: d.lockN, commit: d.commitN }; }
    else if (n.type === 'disk' && sn.disks[n.id]) { const d = sn.disks[n.id]; out[n.id] = { u: r2(clamp01(Math.max(d.util, d.bg))), q: d.q, stalled: !!d.stalled }; }
  });
  return out;
}

/** Perkiraan transaksi yang berisiko hilang saat failover database dengan replikasi asinkron: laju tulis x lag replikasi. */
function dataAtRisk(arch, rates) {
  const out = [];
  arch.nodes.forEach(function (n) {
    if (n.type !== 'db' || !n.ha) return;
    let writes = 0;
    arch.workloads.forEach(function (w) { (w.calls || []).forEach(function (c) { if (c.node === n.id && c.write) writes += (rates[w.id] || 0) * (1 - (c.skipProb || 0)) * (c.writeProb == null ? 1 : c.writeProb); }); });
    out.push({ db: n.label || n.id, failoverS: n.ha.failoverS, sync: !!n.ha.sync, lagMs: n.ha.lagMs, writesPerSec: r2(writes), rpoTx: n.ha.sync ? 0 : r2(writes * n.ha.lagMs / 1000) });
  });
  return out;
}

/** Simulasi satu skenario. Hasilnya deterministik: benih diturunkan dari masukan (atau opt.seed), jadi skenario yang sama selalu memberi hasil yang sama. */
function simulate(arch, opt) {
  opt = opt || {};
  return Rng.withSeed(opt.seed != null ? opt.seed : JSON.stringify([arch, opt.load, opt.seconds, opt.faults, opt.failure]), function () { return run(arch, opt); });
}

function run(arch, opt) {
  const seconds = Math.max(10, Math.min(300, opt.seconds || 120)), warm = Math.min(opt.warm == null ? 15 : opt.warm, Math.floor(seconds / 3));
  const load = opt.load || Load.defaults(arch), ex = opt.failure ? Failures.expand(arch, opt.failure) : null;
  const faults = (opt.faults || []).concat(ex ? ex.faults : []);
  const frames = [], diags = [], diagAt = {}, pool = {};
  let degraded = 0, outage = 0;
  const runner = Bench.makeRunner(arch, {
    seconds: seconds, warm: warm, faults: faults, rates: Load.rates(arch, load, 0),
    rateAt: function (t) { return Load.rates(arch, load, t); },
    onSecond: function (eng, t) {
      const sn = eng.snapshot(), d = eng.diagnose(), key = d.title + '|' + d.node;
      if (diagAt[key] == null) { diagAt[key] = diags.length; diags.push({ node: d.node, lv: d.lv, title: d.title, text: d.text }); }
      const sync = arch.workloads.filter(function (w) { return !w.async; }).reduce(function (s, w) { return s + (eng.rates[w.id] || 0); }, 0);
      const nodes = nodesOf(arch, sn), states = Failures.statesAt(faults, t);
      Object.keys(nodes).forEach(function (id) { const x = pool[id] || (pool[id] = { sumU: 0, n: 0, maxU: 0, maxQ: 0 }); if (t > warm) { x.sumU += nodes[id].u; x.n++; x.maxU = Math.max(x.maxU, nodes[id].u); x.maxQ = Math.max(x.maxQ, nodes[id].q || 0); } });
      // ketersediaan per detik dari hasil nyata detik sebelumnya: terganggu bila banyak error atau penyelesaian jauh di bawah beban masuk; mati bila hampir tidak ada yang berhasil
      const b = eng.S.buckets[Math.floor(t) - 1];
      if (b && t >= 5 && sync > 0) {
        const all = b.ok + b.e504 + b.eConn, errRatio = all ? (b.e504 + b.eConn) / all : 0;
        if (b.ok < 0.1 * sync || errRatio > 0.9) outage++;
        if (b.ok < 0.5 * sync || errRatio > 0.1) degraded++;
      }
      const f = { t: Math.round(t), offered: r2(sync), ok: r2(sn.rate.ok), e504: r2(sn.rate.e504), eConn: r2(sn.rate.eConn), p95: r2(sn.rate.p95), nodes: nodes, flows: flowsOf(arch, eng.rates), diag: diagAt[key] };
      if (Object.keys(states).length) f.states = states;
      frames.push(f);
    }
  });
  runner.chunk(1e9);
  const res = runner.result(), nodes = {};
  Object.keys(pool).forEach(function (id) { const x = pool[id]; nodes[id] = { avgU: r2(x.n ? x.sumU / x.n : 0), maxU: x.maxU, maxQ: x.maxQ }; });
  const worst = Object.keys(nodes).sort(function (a, b) { return nodes[b].avgU - nodes[a].avgU; })[0] || null;
  const asyncIds = {}; arch.workloads.forEach(function (w) { if (w.async) asyncIds[w.id] = 1; });
  const per = {}; Object.keys(res.per).filter(function (id) { return !asyncIds[id]; }).forEach(function (id) { const x = res.per[id]; per[id] = { label: x.label, okPct: r2(x.okPct), fastPct: r2(x.fastPct), p95: r2(x.p95), e504: x.e504 }; });
  const failure = opt.failure ? { node: opt.failure.node, label: ex.label, at: opt.failure.at || 0, len: opt.failure.len || 0, skipped: ex.skipped || null } : null;
  return {
    edges: Sim.edges(arch), frames: frames, diags: diags, nodes: nodes, failure: failure,
    summary: {
      seconds: res.seconds, fastPct: r2(res.fastPct), okPct: r2(res.okPct), e504: res.e504, eConn: res.eConn, p50: r2(res.p50), p95: r2(res.p95), throughput: r2(res.ok / Math.max(1, res.seconds)),
      worstNode: worst, per: per, outageSeconds: outage, degradedSeconds: degraded, ha: dataAtRisk(arch, Load.rates(arch, load, 0))
    }
  };
}

module.exports = { simulate: simulate, flowsOf: flowsOf };
