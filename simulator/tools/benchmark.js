#!/usr/bin/env node
// Menjalankan simulasi tanpa tampilan untuk sebuah arsitektur, lalu mencetak ringkasannya.
//   node tools/benchmark.js architectures/contoh-web-hdd.current.json [--faults insiden|tanpa] [--detik 300]
const fs = require('fs');
const path = require('path');
const Bench = require('../src/bench.js');

function runScenario(arch, opt) { return Bench.run(arch, opt); }
function print(title, r) {
  console.log('\n=== ' + title + ' ===');
  console.log('dalam 2 detik ' + r.fastPct.toFixed(1) + '% | berhasil ' + r.okPct.toFixed(1) + '% | 504: ' + r.e504 + ' | p50 ' + r.p50.toFixed(2) + ' d | p95 ' + r.p95.toFixed(2) + ' d');
  Object.keys(r.per).forEach(function (id) {
    const x = r.per[id];
    console.log('  ' + id.padEnd(22) + ' <2d ' + x.fastPct.toFixed(0).padStart(3) + '%  ok ' + x.okPct.toFixed(0).padStart(3) + '%  504=' + String(x.e504).padStart(5) + '  p95 ' + x.p95.toFixed(2) + ' d');
  });
}
module.exports = { runScenario: runScenario, print: print };

if (require.main === module) {
  const a = process.argv.slice(2);
  const file = a.find(function (x) { return x.indexOf('--') !== 0; });
  if (!file) { console.error('Pakai: node tools/benchmark.js <arsitektur.json> [--faults insiden|tanpa] [--detik 300]'); process.exit(1); }
  const arch = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const fi = a.indexOf('--faults'), di = a.indexOf('--detik');
  const mode = fi >= 0 ? a[fi + 1] : 'insiden', seconds = di >= 0 ? Number(a[di + 1]) : 300;
  const faults = mode === 'tanpa' ? [] : (arch.observedFaults || []).map(function (f) { const c = Object.assign({}, f); delete c.name; return c; });
  print(arch.name + ' | gangguan: ' + mode, runScenario(arch, { faults: faults, seconds: seconds }));
}
