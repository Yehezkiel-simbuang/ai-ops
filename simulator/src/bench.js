// Menjalankan simulasi tanpa tampilan dan merangkum hasilnya. Dipakai di Node dan di browser (uji A/B).
// Metrik utama: persentase request sinkron yang selesai dalam 2 detik (lebih jujur daripada hanya menghitung 504,
// karena request yang menunggu lama tapi akhirnya berhasil tetap membuat pengguna menunggu).
const Bench = (function () {
  function pct(arr, q) { if (!arr.length) return 0; const s = arr.slice().sort(function (a, b) { return a - b; }); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

  function summarize(arch, all, seconds, warm) {
    const sync = arch.workloads.filter(function (w) { return !w.async; }).map(function (w) { return w.id; });
    const per = {};
    Object.keys(all.w).forEach(function (id) {
      const x = all.w[id], n = x.ok + x.e504 + x.eConn;
      per[id] = { label: (arch.workloads.find(function (w) { return w.id === id; }) || {}).label, ok: x.ok, e504: x.e504, okPct: n ? 100 * x.ok / n : 100,
        fastPct: n ? 100 * x.lats.filter(function (l) { return l <= 2; }).length / n : 100, p95: pct(x.lats, 0.95) };
    });
    let sOk = 0, sAll = 0, sFast = 0;
    sync.forEach(function (id) { const x = all.w[id]; if (!x) return; sOk += x.ok; sAll += x.ok + x.e504 + x.eConn; sFast += x.lats.filter(function (l) { return l <= 2; }).length; });
    return { seconds: seconds - warm, fastPct: sAll ? 100 * sFast / sAll : 100, okPct: sAll ? 100 * sOk / sAll : 100, ok: all.ok, e504: all.e504, eConn: all.eConn, p95: pct(all.lats, 0.95), p50: pct(all.lats, 0.5), per: per };
  }

  // opt: {faults, rates, rateAt(t), seconds, warm, onSecond(eng, t)}; onProgress(0..1) opsional (hanya versi async)
  function makeRunner(arch, opt) {
    opt = opt || {};
    const seconds = opt.seconds || 300, warm = opt.warm || 20;
    const SimMod = (typeof Sim !== 'undefined') ? Sim : require('./engine.js');
    const eng = SimMod.create(arch, { faults: opt.faults || [], rates: opt.rates });
    const setRates = function () { if (!opt.rateAt) return; const r = opt.rateAt(eng.S.t); Object.keys(r).forEach(function (k) { eng.rates[k] = r[k]; }); };
    const total = Math.round(seconds / SimMod.DT), per = Math.round(1 / SimMod.DT);
    const all = { ok: 0, e504: 0, eConn: 0, lats: [], w: {} };
    let i = 0;
    function chunk(n) {
      const end = Math.min(total, i + n);
      for (; i < end; i++) {
        if (i % 5 === 0) setRates();
        eng.step();
        if (opt.onSecond && i > 0 && i % per === 0) opt.onSecond(eng, eng.S.t);   // dipanggil tiap detik simulasi (juga saat pemanasan)
        if (i > 0 && i % per === 0 && eng.S.t > warm) {
          const b = eng.S.buckets[Math.floor(eng.S.t) - 1]; if (!b) continue;
          all.ok += b.ok; all.e504 += b.e504; all.eConn += b.eConn; for (let k = 0; k < b.lats.length; k++) all.lats.push(b.lats[k]);
          Object.keys(b.w).forEach(function (id) { const x = all.w[id] || (all.w[id] = { ok: 0, e504: 0, eConn: 0, lats: [] }), y = b.w[id]; x.ok += y.ok; x.e504 += y.e504; x.eConn += y.eConn; for (let k = 0; k < y.lats.length; k++) x.lats.push(y.lats[k]); });
        }
      }
      return i >= total;
    }
    return { chunk: chunk, progress: function () { return i / total; }, result: function () { return summarize(arch, all, seconds, warm); } };
  }

  function run(arch, opt) { const r = makeRunner(arch, opt); r.chunk(1e9); return r.result(); }
  function runAsync(arch, opt, onProgress) {
    return new Promise(function (resolve) {
      const r = makeRunner(arch, opt);
      (function loop() { const done = r.chunk(2500); if (onProgress) onProgress(r.progress()); if (done) resolve(r.result()); else setTimeout(loop, 0); })();
    });
  }
  return { run: run, runAsync: runAsync, makeRunner: makeRunner };
})();
if (typeof module !== 'undefined') module.exports = Bench;
