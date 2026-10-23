#!/usr/bin/env node
// Uji regresi: memastikan mesin simulasi, aturan rekomendasi, dan analyzer tetap berperilaku seperti yang sudah dibuktikan.
//   node tools/test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Patch = require('../src/patch.js');
const Recommend = require('../src/recommend.js');
const Bench = require('../src/bench.js');

const root = path.resolve(__dirname, '..');
const load = function (p) { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); };
const web = load('architectures/contoh-web-hdd.current.json');
const toko = load('architectures/contoh-toko-online.json');
const facts = load('architectures/contoh-web-hdd.facts.json');
const incident = (web.observedFaults || []).map(function (f) { const c = Object.assign({}, f); delete c.name; return c; });
const SECS = 300;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  GAGAL ' + name + '\n         ' + e.message); }
}
function run(arch, faults) { return Bench.run(arch, { faults: faults || [], seconds: SECS }); }
function rec(id) { return Recommend.analyze(web, facts).find(function (r) { return r.id === id || r.id.indexOf(id) === 0; }); }

console.log('Mesin simulasi (contoh aplikasi web)');
const normal = run(web, []), base = run(web, incident);
t('normal: hampir semua request selesai dalam 2 detik', function () { assert(normal.fastPct >= 99, 'fastPct=' + normal.fastPct.toFixed(1)); assert.strictEqual(normal.e504, 0); });
t('insiden: stall disk membuat banyak request lambat dan 504', function () { assert(base.fastPct <= 70, 'fastPct=' + base.fastPct.toFixed(1)); assert(base.e504 >= 500, '504=' + base.e504); });

console.log('Rekomendasi (pengaruh tiap saran pada insiden)');
function gain(id) { const r = rec(id); assert(r, 'saran ' + id + ' tidak ditemukan'); return run(Patch.apply(web, r.patch), incident).fastPct - base.fastPct; }
t('SLOG menaikkan request cepat minimal 20 poin', function () { const g = gain('slog'); assert(g >= 20, 'naik ' + g.toFixed(1)); });
t('flush_log=2 menaikkan request cepat minimal 20 poin (opsional, ada risiko)', function () { const g = gain('flush2'); assert(g >= 20, 'naik ' + g.toFixed(1)); assert(rec('flush2').optional === true); });
t('pisah pool saja TIDAK menyelesaikan stall disk (pelajaran: bukan sumber masalahnya)', function () { const g = gain('split'); assert(g < 15, 'naik ' + g.toFixed(1)); });
t('kurangi tulis token saja tidak cukup untuk stall disk', function () { const g = gain('hot-write'); assert(g < 15, 'naik ' + g.toFixed(1)); });
t('semua saran non-opsional bersama: hampir tanpa request lambat', function () {
  const r = run(Recommend.recommended(web, Recommend.analyze(web, facts)), incident);
  assert(r.fastPct >= 97, 'fastPct=' + r.fastPct.toFixed(1)); assert(r.e504 <= 5, '504=' + r.e504);
});

console.log('Arsitektur lain (toko online)');
t('toko online normal sehat', function () { const r = run(toko, []); assert(r.fastPct >= 98, 'fastPct=' + r.fastPct.toFixed(1)); assert.strictEqual(r.e504, 0); });
t('toko online: laporan berat 2/dtk memicu saran pisah pool dan cache query', function () {
  const a = Patch.clone(toko); a.workloads.find(function (w) { return w.id === 'report'; }).rate = 2;
  const ids = Recommend.analyze(a, null).map(function (r) { return r.id; });
  assert(ids.some(function (i) { return i.indexOf('split') === 0; }), 'tidak ada saran pisah pool: ' + ids.join(','));
  assert(ids.some(function (i) { return i.indexOf('loop') === 0; }), 'tidak ada saran query berulang: ' + ids.join(','));
  assert(!ids.some(function (i) { return i === 'slog'; }), 'SLOG tidak boleh disarankan untuk SSD cepat');
});
t('layanan pembayaran tidak pernah disarankan untuk di-cache', function () {
  const a = Patch.clone(toko); a.workloads.find(function (w) { return w.id === 'checkout'; }).rate = 30;
  assert(!Recommend.analyze(a, null).some(function (r) { return r.id.indexOf('cache') === 0; }));
});

console.log('Patch');
t('Patch.apply tidak mengubah arsitektur asli', function () {
  const copy = JSON.stringify(web); Patch.apply(web, rec('slog').patch); assert.strictEqual(JSON.stringify(web), copy);
});
t('splitPool memetakan workload ke pool baru dan memisahkan yang berat', function () {
  const a = Patch.apply(web, rec('split').patch);
  assert(a.nodes.some(function (n) { return n.id === 'fpm_light'; }) && a.nodes.some(function (n) { return n.id === 'fpm_heavy'; }));
  assert.strictEqual(a.workloads.find(function (w) { return w.id === 'admin_report'; }).pool, 'fpm_heavy');
  assert.strictEqual(a.workloads.find(function (w) { return w.id === 'mobile_api'; }).pool, 'fpm_light');
  assert(!a.nodes.some(function (n) { return n.id === 'fpm'; }), 'pool lama harus hilang');
});

console.log('\n' + pass + ' lolos, ' + fail + ' gagal');
process.exit(fail ? 1 : 0);
