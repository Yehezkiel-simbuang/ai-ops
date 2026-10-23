#!/usr/bin/env node
// aiops - alat pribadi: baca proyek apa pun, sarankan perbaikan, buktikan lewat simulasi. Eksperimen visual ada di aplikasi (halaman Arsitektur).
//   aiops scan <dir>                 ringkasan tumpukan yang terbaca (tanpa simulasi)
//   aiops recommend <dir> [--detik N] [--json]   saran + bukti simulasi
//   aiops serve                      (dipindah ke Docker; lihat README)
// Hanya membaca. Tidak mengirim apa pun keluar komputer; .env hanya dibaca kunci aman dan tidak pernah dicetak.
const fs = require('fs');
const path = require('path');
const Pipe = require('../tools/pipeline.js');

const a = process.argv.slice(2), cmd = a[0];
const flag = function (k) { return a.indexOf(k) >= 0; };
const val = function (k, d) { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
if (cmd === 'serve') { console.log('Aplikasi web sekarang berjalan lewat Docker: lihat README (docker compose up -d --build).'); return; }
const dirs = a.slice(1).filter(function (x, i, arr) { return x.indexOf('--') !== 0 && ['--detik', '--out'].indexOf(arr[i - 1]) < 0; });
function usage() { console.log('Pakai:\n  aiops scan <dir>\n  aiops recommend <dir> [--detik 300] [--json]'); process.exit(1); }
if (!cmd || !dirs.length || ['scan', 'recommend'].indexOf(cmd) < 0) usage();
dirs.forEach(function (d) { if (!fs.existsSync(d)) { console.error('Folder tidak ada: ' + d); process.exit(1); } });

function pct(x) { return x.toFixed(1) + '%'; }
function printScan(r, d) {
  const f = r.facts, A = r.arch;
  console.log('\n== ' + path.basename(path.resolve(d)) + ' ==');
  console.log('Tumpukan : ' + f.stack);
  if (f.units) f.units.forEach(function (u) {
    console.log('  - ' + u.dir.padEnd(14) + u.name + (u.workers ? ' | pekerja ' + u.workers : '') + (u.dbs.length ? ' | db: ' + u.dbs.map(function (x) { return x.kind + (x.poolSize ? '(pool ' + x.poolSize + ')' : ''); }).join(',') : '') + (u.caches.length ? ' | cache: ' + u.caches.join(',') : '') + (u.queues.length ? ' | antrean: ' + u.queues.map(function (q) { return q.kind; }).join(',') : '') + (u.external.length ? ' | luar: ' + u.external.map(function (e) { return e.host; }).join(',') : ''));
  });
  console.log('Simulasi : ' + A.nodes.length + ' simpul, ' + A.workloads.length + ' beban' + (A.workloads.some(function (w) { return w.rateAssumed; }) ? ' (laju request = ASUMSI; ganti dengan data nyata bila ada)' : ''));
  (A.smells || []).forEach(function (s) { console.log('  ! ' + s.text); });
}
function printRec(r) {
  console.log('Skenario : ' + r.faults.map(function (f) { return f.node + ' ' + f.type; }).join(' + ') + (r.assumedFaults ? ' (gangguan ASUMSI)' : '') + ', ' + r.seconds + ' d simulasi');
  console.log('Sekarang : selesai <2 d ' + pct(r.base.fastPct) + ' | 504 ' + r.base.e504 + ' | p95 ' + r.base.p95 + ' d');
  if (!r.recs.length) console.log('Tidak ada saran: tidak ada kemacetan yang jelas dari kode + asumsi ini.');
  r.recs.forEach(function (x) {
    console.log('\n[' + x.severity + '] ' + x.title + (x.optional ? ' (opsional, ada risiko)' : ''));
    x.why.forEach(function (w) { console.log('   - ' + w); });
    console.log('   harga: ' + x.tradeoff);
    console.log('   bukti: ' + (x.test ? 'sendiri -> <2 d ' + pct(x.test.sesudah.fastPct) + ' | 504 ' + x.test.sesudah.e504 + ' | p95 ' + x.test.sesudah.p95 + ' d' : 'tidak dapat disimulasikan (perubahan kode/konfigurasi)'));
  });
  console.log('\nSemua saran non-opsional: <2 d ' + pct(r.all.fastPct) + ' | 504 ' + r.all.e504 + ' | p95 ' + r.all.p95 + ' d');
}

if (cmd === 'scan') dirs.forEach(function (d) { printScan(Pipe.run(d, { prove: false, seconds: 20 }), d); });
if (cmd === 'recommend') dirs.forEach(function (d) { const r = Pipe.run(d, { seconds: Number(val('--detik', 300)) }); if (flag('--json')) console.log(JSON.stringify({ stack: r.facts.stack, sekarang: r.base, semuaSaran: r.all, saran: r.recs }, null, 2)); else { printScan(r, d); printRec(r); } });
