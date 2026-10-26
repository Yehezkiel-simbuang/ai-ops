// Analisis potensi bottleneck TANPA meramal angka mutlak: "komponen mana yang jenuh lebih dulu, dan seberapa yakin".
//
// Beban dinaikkan bertahap (kelipatan dari beban dasar yang sedang disetel), lalu dicatat komponen penyebab saat sistem pertama kali
// tidak sehat. Karena waktu per panggilan dan CPU per request biasanya TEBAKAN, analisis diulang dengan nilai itu divariasikan
// (x0,5 sampai x2) dan hasilnya dihitung per komponen: "X jadi leher botol pertama di 7 dari 8 variasi". Nilai yang DIUKUR (node tanpa
// penanda assumed) tidak divariasikan. Variasi memakai pengacak berbenih, jadi analisis yang sama selalu menghasilkan jawaban yang sama.
const Bench = require('./bench.js');
const Load = require('./load.js');

const MULTIPLES = [1, 2, 4, 8, 16, 32];
const FACTORS = [0.5, 0.7, 1, 1.4, 2];
const WARM = 10, SECONDS = 40;
const SICK = function (r) { return r.fastPct < 90 || r.okPct < 99; };

const Rng = require('./rng.js');
const mulberry32 = Rng.mulberry32, seedOf = Rng.seedOf;
const clone = function (o) { return JSON.parse(JSON.stringify(o)); };

/** Salinan arsitektur dengan nilai yang tidak terukur dikalikan faktor acak. Mengembalikan juga keterangan apa yang divariasikan. */
function perturb(arch, rnd) {
  const a = clone(arch), pick = function () { return FACTORS[Math.floor(rnd() * FACTORS.length)]; };
  a.workloads.forEach(function (w) {
    if (w.cpuMs && w.cpuAssumed !== false) w.cpuMs = w.cpuMs * pick();   // cpuAssumed:false = diisi pengguna, tidak divariasikan
    (w.calls || []).forEach(function (c) { if (c.ms) c.ms = c.ms * pick(); if (c.read) c.read = c.read * pick(); });
  });
  a.nodes.forEach(function (n) {
    (n.assumed || []).forEach(function (k) { if (typeof n[k] === 'number' && k !== 'timeoutS') n[k] = Math.max(1, n[k] * pick()); });
  });
  return a;
}

/** Satu percobaan pada kelipatan beban tertentu: ringkasan + komponen yang paling sering didiagnosis sebagai leher botol. */
function probe(arch, load, seconds) {
  const votes = {}, titles = {}, sum = {};
  const r = Bench.run(arch, {
    seconds: seconds, warm: WARM, rates: Load.rates(arch, load, 0), rateAt: function (t) { return Load.rates(arch, load, t); },
    onSecond: function (eng, t) {
      if (t <= WARM) return;
      const d = eng.diagnose(); if (!d.node || d.lv < 1) return;
      votes[d.node] = (votes[d.node] || 0) + 1; (titles[d.node] || (titles[d.node] = {}))[d.title + '|' + d.text] = 1;
      sum[d.node] = d;
    }
  });
  let node = null, best = 0; Object.keys(votes).forEach(function (id) { if (votes[id] > best) { best = votes[id]; node = id; } });
  return { fastPct: r.fastPct, okPct: r.okPct, node: node, diag: node ? sum[node] : null };
}

function median(a) { const s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[Math.floor(s.length / 2)] : 0; }

/** Kelipatan terkecil yang membuat sistem tidak sehat, dengan pencarian berurutan; berhenti di batas puncak request/detik. */
function firstFailure(arch, load, maxPeak) {
  const base = Load.totalRpm(load) / 60 * (load.spike && load.spike.on ? load.spike.mult : 1);
  for (let i = 0; i < MULTIPLES.length; i++) {
    const m = MULTIPLES[i]; if (base * m > maxPeak) return { capped: true, m: m };
    const l = Object.assign({}, load, { users: load.users * m }), r = probe(arch, l, SECONDS);
    if (SICK(r)) return { m: m, node: r.node, diag: r.diag, fastPct: r.fastPct };
  }
  return { none: true, m: MULTIPLES[MULTIPLES.length - 1] };
}

/**
 * analyze(arch, { load, variations = 8, budgetMs = 8000, maxPeak = 4000, seed })
 * -> { ranking:[{node,label,count,share,medianMultiple,title,text}], variations, planned, multiples, healthyThrough, capped, complete, varied }
 */
function analyze(arch, opt) {
  opt = opt || {};
  const load = opt.load || Load.defaults(arch), planned = opt.variations || 8, budget = opt.budgetMs || 8000, maxPeak = opt.maxPeak || 4000;
  const seed = seedOf(opt.seed || arch.name || 'arsitektur'), rnd = mulberry32(seed), t0 = Date.now(), runs = [];
  // mesin simulasi memakai Math.random (kedatangan dan jitter): dibenihkan selama analisis supaya masukan yang sama selalu menghasilkan jawaban yang sama
  const realRandom = Math.random; Math.random = mulberry32(seed ^ 0x9E3779B9);
  try {
    for (let v = 0; v < planned; v++) {
      if (v > 0 && Date.now() - t0 > budget) break;
      runs.push(firstFailure(v === 0 ? arch : perturb(arch, rnd), load, maxPeak));
    }
  } finally { Math.random = realRandom; }
  const failed = runs.filter(function (r) { return r.node || (!r.none && !r.capped); }), healthy = runs.filter(function (r) { return r.none; }), capped = runs.filter(function (r) { return r.capped; });
  const by = {};
  failed.forEach(function (r) { const k = r.node || '?'; (by[k] || (by[k] = [])).push(r); });
  const label = function (id) { const n = arch.nodes.find(function (x) { return x.id === id; }); return n ? (n.label || n.id) : id; };
  const ranking = Object.keys(by).map(function (id) {
    const g = by[id], top = g.filter(function (x) { return x.diag; })[0];
    return { node: id, label: label(id), count: g.length, share: g.length / runs.length, medianMultiple: median(g.map(function (x) { return x.m; })), title: top ? top.diag.title : 'Tidak sehat', text: top ? top.diag.text : '' };
  }).sort(function (a, b) { return b.count - a.count || a.medianMultiple - b.medianMultiple; });
  const varied = ['lama tiap panggilan dan CPU per request (x0,5 sampai x2)'];
  if (arch.nodes.some(function (n) { return (n.assumed || []).length; })) varied.push('parameter node yang ditandai asumsi (jumlah worker, kecepatan disk, dst.)');
  return {
    ranking: ranking, variations: runs.length, planned: planned, multiples: MULTIPLES, complete: runs.length === planned,
    healthyCount: healthy.length, cappedCount: capped.length, healthyThrough: healthy.length || capped.length ? MULTIPLES[MULTIPLES.length - 1] : null,
    varied: varied, ms: Date.now() - t0
  };
}

module.exports = { analyze: analyze, perturb: perturb, mulberry32: mulberry32, MULTIPLES: MULTIPLES };
