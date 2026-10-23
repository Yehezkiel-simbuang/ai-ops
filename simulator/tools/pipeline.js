// Alur lengkap untuk satu proyek: baca -> arsitektur -> saran -> bukti simulasi.
const path = require('path');
const { analyze } = require('./analyze.js');
const Patch = require('../src/patch.js');
const Recommend = require('../src/recommend.js');
const { runScenario } = require('./benchmark.js');

function score(r) { return { fastPct: +r.fastPct.toFixed(1), okPct: +r.okPct.toFixed(1), e504: r.e504, p95: +r.p95.toFixed(2) }; }

function run(root, opt) {
  opt = opt || {};
  const res = analyze(path.resolve(root), opt.observed || null), arch = res.arch, facts = res.facts;
  const seconds = opt.seconds || 300;
  let faults = (arch.observedFaults || []).map(function (f) { const c = Object.assign({}, f); delete c.name; return c; }), assumedFaults = false;
  if (!faults.length) { faults = Recommend.defaultFaults(arch).map(function (f) { const c = Object.assign({}, f); delete c._nama; return c; }); assumedFaults = true; arch.observedFaults = Recommend.defaultFaults(arch); }
  const recs = Recommend.analyze(arch, facts), base = runScenario(arch, { faults: faults, seconds: seconds });
  if (opt.prove !== false) recs.forEach(function (r) {
    if (!r.patch.length) { r.test = null; return; }
    const res2 = runScenario(Patch.apply(arch, r.patch), { faults: faults, seconds: seconds }); r.test = { sebelum: score(base), sesudah: score(res2) };
  });
  const rec = Recommend.recommended(arch, recs), all = runScenario(rec, { faults: faults, seconds: seconds });
  return { arch: arch, facts: facts, recs: recs, rec: rec, faults: faults, assumedFaults: assumedFaults, seconds: seconds, base: score(base), all: score(all) };
}
module.exports = { run: run, score: score };
