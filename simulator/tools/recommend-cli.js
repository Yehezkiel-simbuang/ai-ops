#!/usr/bin/env node
// Membuat rekomendasi dari sebuah arsitektur, lalu MEMBUKTIKANNYA lewat simulasi:
// menjalankan skenario gangguan yang sama pada arsitektur sekarang dan arsitektur rekomendasi.
//
//   node tools/recommend-cli.js architectures/contoh-web-hdd.current.json [--facts architectures/contoh-web-hdd.facts.json]
//
// Keluaran (di folder yang sama dengan berkas masukan):
//   <nama>.recommendations.json   daftar saran + hasil uji tiap saran secara terpisah
//   <nama>.recommended.json       arsitektur dengan semua saran non-opsional diterapkan
const fs = require('fs');
const path = require('path');
const Patch = require('../src/patch.js');
const Recommend = require('../src/recommend.js');
const { runScenario } = require('./benchmark.js');

const args = process.argv.slice(2);
const file = args.find(function (x) { return x.indexOf('--') !== 0; });
if (!file) { console.error('Pakai: node tools/recommend-cli.js <arsitektur.json> [--facts fakta.json] [--detik 450]'); process.exit(1); }
const fi = args.indexOf('--facts'), di = args.indexOf('--detik');
const abs = path.resolve(file);
const arch = JSON.parse(fs.readFileSync(abs, 'utf8'));
const facts = fi >= 0 ? JSON.parse(fs.readFileSync(path.resolve(args[fi + 1]), 'utf8')) : null;
const seconds = di >= 0 ? Number(args[di + 1]) : 450;
const faults = (arch.observedFaults || []).map(function (f) { const c = Object.assign({}, f); delete c.name; return c; });

const recs = Recommend.analyze(arch, facts);
const base = runScenario(arch, { faults: faults, seconds: seconds });
function score(r) { return { fastPct: +r.fastPct.toFixed(1), okPct: +r.okPct.toFixed(1), e504: r.e504, p95: +r.p95.toFixed(2) }; }

console.log('\nSkenario uji: ' + (faults.length ? faults.map(function (f) { return f.node + ' ' + f.type; }).join(' + ') : 'tanpa gangguan') + ', ' + seconds + ' detik simulasi');
console.log('Arsitektur sekarang      : dalam 2 d ' + base.fastPct.toFixed(1) + '% | 504 ' + base.e504 + ' | p95 ' + base.p95.toFixed(1) + ' d\n');
recs.forEach(function (r) {
  if (!r.patch.length) { r.test = null; console.log('[' + r.severity.padEnd(6) + '] ' + r.title + '  (tidak dapat disimulasikan)'); return; }
  const a = Patch.apply(arch, r.patch);
  const res = runScenario(a, { faults: faults, seconds: seconds });
  r.test = { sebelum: score(base), sesudah: score(res) };
  console.log('[' + r.severity.padEnd(6) + '] ' + r.title + (r.optional ? '  [opsional, ada risiko]' : ''));
  console.log('         sendiri -> dalam 2 d ' + res.fastPct.toFixed(1) + '% | 504 ' + res.e504 + ' | p95 ' + res.p95.toFixed(1) + ' d');
});
const rec = Recommend.recommended(arch, recs);
const all = runScenario(rec, { faults: faults, seconds: seconds });
console.log('\nSemua saran non-opsional : dalam 2 d ' + all.fastPct.toFixed(1) + '% | 504 ' + all.e504 + ' | p95 ' + all.p95.toFixed(1) + ' d');
Object.keys(all.per).forEach(function (id) { const x = all.per[id], b = base.per[id]; console.log('   ' + id.padEnd(22) + ' dalam 2 d ' + (b ? b.fastPct.toFixed(0) : '-').padStart(3) + '% -> ' + x.fastPct.toFixed(0).padStart(3) + '%'); });

const stem = abs.replace(/\.current\.json$|\.json$/, '');
fs.writeFileSync(stem + '.recommendations.json', JSON.stringify({ skenario: faults, detik: seconds, sekarang: score(base), semuaSaran: score(all), saran: recs }, null, 2));
fs.writeFileSync(stem + '.recommended.json', JSON.stringify(rec, null, 2));
console.log('\nDitulis: ' + path.basename(stem) + '.recommendations.json dan ' + path.basename(stem) + '.recommended.json');
