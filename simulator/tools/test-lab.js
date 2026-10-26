#!/usr/bin/env node
// Uji lab eksperimen: katalog komponen, efek tiap komponen pada simulasi, dan bentuk bingkai untuk animasi.
//   node tools/test-lab.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Load = require('../src/load.js');
const Sim = require('../src/engine.js');
const Lab = require('../src/lab.js');
const C = require('../src/components.js');

const root = path.resolve(__dirname, '..');
const loadArch = function (n) { return JSON.parse(fs.readFileSync(path.join(root, 'architectures', n + '.json'), 'utf8')); };
const toko = loadArch('contoh-toko-online'), api = loadArch('contoh-api-sederhana');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  GAGAL ' + name + '\n         ' + e.message); } }
const heavy = function (arch, users) { const l = Load.defaults(arch); l.users = users; l.rpu = 6; return l; };
const act = function (component, params) { return { kind: 'component', component: component, params: params || {} }; };
const run = function (arch, load, seconds) { return Lab.simulate(arch, { load: load, seconds: seconds || 100 }); };
const node = function (a, id) { return a.nodes.find(function (n) { return n.id === id; }); };

console.log('Katalog');
t('semua komponen tersedia untuk toko online kecuali SSD (disk sudah NVMe)', function () {
  const cat = C.catalog(toko), by = {}; cat.forEach(function (c) { by[c.id] = c; });
  ['redis', 'lb', 'filter', 'replica', 'hadb', 'dbsplit', 'queue', 'scaleup', 'cdn'].forEach(function (id) { assert(by[id].available, id + ' harus tersedia'); });
  assert.strictEqual(by.ssd.available, false); assert(/NVMe/.test(by.ssd.reason));
});
t('opsi parameter dihitung dari arsitekturnya (pool, database, pekerjaan)', function () {
  const q = C.catalog(toko).find(function (c) { return c.id === 'queue'; });
  const wl = q.params.find(function (p) { return p.key === 'workload'; });
  assert.deepStrictEqual(wl.options.map(function (o) { return o.value; }), ['browse', 'checkout', 'report']);
  assert.strictEqual(wl.default, 'report', 'default = pekerjaan paling berat');
});
t('compile tidak mengubah arsitektur asli dan menormalkan parameter di luar batas', function () {
  const before = JSON.stringify(toko);
  const r = C.compile(toko, [act('lb', { instances: 999, efficiency: -5 })]);
  assert.strictEqual(JSON.stringify(toko), before);
  assert.strictEqual(r.applied[0].params.instances, 10); assert.strictEqual(r.applied[0].params.efficiency, 70);
});
t('komponen yang sama dengan target yang sama tidak menumpuk', function () {
  const r = C.compile(toko, [act('lb'), act('lb', { instances: 5 }), act('ssd')]);
  assert.strictEqual(r.applied.length, 1); assert.strictEqual(r.skipped.length, 2);
});

console.log('Bentuk arsitektur hasil komponen');
t('load balancer masuk rantai depan sebelum proxy, worker dan core bertambah, edge benar', function () {
  const a = C.compile(api, [act('lb', { instances: 3, efficiency: 100, ms: 1 })]).arch;
  assert.deepStrictEqual(a.nodes.filter(function (n) { return n.type === 'proxy'; }).map(function (n) { return n.id; }), ['x-lb', 'lb']);
  assert.strictEqual(node(a, 'app').workers, 120); assert.strictEqual(node(a, 'app').cores, 12);
  const e = Sim.edges(a).map(function (x) { return x.join('>'); });
  ['users>x-lb', 'x-lb>lb', 'lb>app'].forEach(function (k) { assert(e.includes(k), 'edge ' + k); });
  assert.strictEqual(a.workloads[0].cpuMs, api.workloads[0].cpuMs + 1);
});
t('replika baca: node + disk baru, rute berbobot, edge ke replika dan disknya, tulis tetap ke primary', function () {
  const a = C.compile(toko, [act('replica', { share: 70 })]).arch;
  assert(node(a, 'x-replica-pg') && node(a, 'x-replica-ssd'), 'node replika dan disknya');
  const read = a.workloads.find(function (w) { return w.id === 'browse'; }).calls.find(function (c) { return c.read; });
  assert.deepStrictEqual(read.route, [{ node: 'pg', w: 30 }, { node: 'x-replica-pg', w: 70 }]);
  const write = a.workloads.find(function (w) { return w.id === 'checkout'; }).calls.find(function (c) { return c.write; });
  assert(!write.route, 'tulis tidak dirutekan ke replika');
  const e = Sim.edges(a).map(function (x) { return x.join('>'); });
  assert(e.includes('api>x-replica-pg') && e.includes('x-replica-pg>x-replica-ssd'));
});
t('redis memakai cache yang sudah ada, tidak menggandakan panggilan, dan menyetel peluang lewati db', function () {
  const a = C.compile(api, [act('redis', { hit: 90 })]).arch;
  assert(!a.nodes.some(function (n) { return n.id === 'x-redis'; }), 'cache yang ada dipakai ulang');
  const read = a.workloads.find(function (w) { return w.id === 'read'; });
  assert.strictEqual(read.calls.filter(function (c) { return c.node === 'cache'; }).length, 1);
  assert(Math.abs(read.calls.find(function (c) { return c.node === 'db'; }).skipProb - 0.9) < 1e-9);
});
t('redis menambah node bila belum ada cache', function () {
  const bare = JSON.parse(JSON.stringify(toko)); bare.nodes = bare.nodes.filter(function (n) { return n.id !== 'cache'; }); bare.workloads.forEach(function (w) { w.calls = w.calls.filter(function (c) { return c.node !== 'cache'; }); });
  const a = C.compile(bare, [act('redis')]).arch; assert(node(a, 'x-redis'));
});
t('antrean mengubah pekerjaan menjadi konsumen latar dengan pool sendiri; cdn mengurangi laju ke origin', function () {
  const a = C.compile(toko, [act('queue', { workload: 'report', workers: 2 }), act('cdn', { share: 50 })]).arch;
  const w = a.workloads.find(function (x) { return x.id === 'report'; });
  assert.strictEqual(w.async, true); assert.strictEqual(w.pool, 'x-queue-report'); assert.strictEqual(node(a, 'x-queue-report').workers, 2);
  const l = Load.defaults(a), r = Load.rates(a, l, 0), base = Load.rates(toko, Load.defaults(toko), 0);
  assert(Math.abs(r.browse / base.browse - 0.5) < 0.01, 'browse (baca-saja) turun ke setengah, rasio=' + r.browse / base.browse);
  assert(Math.abs(r.checkout / base.checkout - 1) < 0.01, 'checkout (menulis) tidak lewat CDN');
});

console.log('Efek pada simulasi (beban tinggi: 300 req/dtk pada toko online)');
const L = heavy(toko, 3000), baseRun = run(toko, L);
t('kondisi awal jenuh: hampir semua request lambat, bottleneck ada di Postgres', function () {
  assert(baseRun.summary.fastPct < 40, 'fastPct=' + baseRun.summary.fastPct);
  assert(baseRun.diags.some(function (d) { return /Postgres/.test(d.title); }), 'diagnosis menyebut Postgres');
});
[['redis', {}], ['lb', { instances: 3 }], ['queue', {}], ['scaleup', {}], ['cdn', { share: 70 }]].forEach(function (p) {
  t(p[0] + ' memperbaiki kondisi (cepat > 90%)', function () {
    const r = run(C.compile(toko, [act(p[0], p[1])]).arch, L);
    assert(r.summary.fastPct > 90, 'fastPct=' + r.summary.fastPct + ' (awal ' + baseRun.summary.fastPct + ')');
  });
});
t('replika tidak otomatis menolong bila leher botolnya bukan baca biasa (hasil jujur)', function () {
  const r = run(C.compile(toko, [act('replica')]).arch, L);
  assert(r.summary.fastPct < 60, 'fastPct=' + r.summary.fastPct);
});
t('antrean: pekerjaan berat tidak lagi dihitung sebagai request sinkron, backlog dipantau di node antrean', function () {
  const r = run(C.compile(toko, [act('queue', { workers: 1 })]).arch, L);
  assert(!r.summary.per.report, 'laporan tidak ada di metrik sinkron');
  assert(r.nodes['x-queue-report'], 'node antrean punya statistik');
});

console.log('Bingkai animasi');
t('satu bingkai per detik; beban node 0..1; aliran hanya pada sambungan yang ada', function () {
  const r = run(toko, L, 60), edges = r.edges.map(function (x) { return x.join('>'); });
  assert.strictEqual(r.frames.length, 59); assert.strictEqual(r.frames[0].t, 1);
  r.frames.forEach(function (f) {
    Object.keys(f.nodes).forEach(function (id) { assert(f.nodes[id].u >= 0 && f.nodes[id].u <= 1, id + ' u=' + f.nodes[id].u); });
    Object.keys(f.flows).forEach(function (k) { assert(edges.includes(k), 'aliran ' + k + ' tanpa sambungan'); });
    assert(f.diag >= 0 && f.diag < r.diags.length);
  });
});
t('aliran sesuai laju: client -> gateway sama dengan total laju sinkron', function () {
  const r = run(toko, Load.defaults(toko), 40), f = r.frames[r.frames.length - 1];
  const total = f.flows['shopper>gateway'] + f.flows['staff>gateway'];
  assert(Math.abs(total - f.offered) < 0.5, 'aliran=' + total + ' offered=' + f.offered);
});
t('lonjakan beban terlihat di bingkai', function () {
  const l = Load.defaults(toko); l.spike = { on: true, mult: 4, at: 20, len: 20, every: 0, shape: 'step' };
  const r = run(toko, l, 60), before = r.frames[10].offered, during = r.frames[30].offered;
  assert(during > before * 2.5, 'sebelum=' + before + ' saat lonjakan=' + during);
});
t('ukuran hasil kecil: 120 detik < 150 KB', function () {
  const kb = JSON.stringify(run(C.compile(toko, [act('replica'), act('lb')]).arch, L, 120)).length / 1024;
  assert(kb < 150, 'ukuran=' + kb.toFixed(0) + ' KB');
});

console.log('HA, load balancer, dan kegagalan node');
const Failures = require('../src/failures.js');
const withFailure = function (arch, failure, users, secs) { const l = heavy(arch, users || 500); return Lab.simulate(arch, { load: l, seconds: secs || 100, failure: failure }); };
t('database tanpa HA: mati selama gangguan; dengan HA: hanya selama failover, lalu lambat sesaat (cache dingin)', function () {
  const f = { node: 'pg', at: 30, len: 40 };
  const none = withFailure(toko, f), ha = withFailure(C.compile(toko, [act('hadb', { failoverS: 20, warmS: 20 })]).arch, f);
  assert(none.summary.outageSeconds >= 35, 'tanpa HA mati ' + none.summary.outageSeconds + ' dtk');
  assert(ha.summary.outageSeconds >= 15 && ha.summary.outageSeconds <= 25, 'dengan HA mati ' + ha.summary.outageSeconds + ' dtk');
  assert(ha.summary.okPct > none.summary.okPct + 10, 'ketersediaan HA ' + ha.summary.okPct + ' vs ' + none.summary.okPct);
  const st = ha.frames.map(function (x) { return (x.states || {}).pg; });
  assert(st.includes('failover') && st.includes('warm') && st.indexOf('failover') < st.indexOf('warm'), 'urutan keadaan: failover lalu warm');
});
t('database tanpa HA dan gangguan tanpa batas (len 0): tidak pulih sampai akhir simulasi', function () {
  const r = withFailure(toko, { node: 'pg', at: 30, len: 0 }, 500, 90);
  assert(r.summary.outageSeconds >= 55, 'mati ' + r.summary.outageSeconds + ' dtk dari 60 yang tersedia');
});
t('server tunggal mati = mati total; beberapa server di belakang load balancer hanya kehilangan sebagian kapasitas dan sedikit request saat health check belum mendeteksi', function () {
  const f = { node: 'api', at: 30, len: 40 };
  const one = withFailure(toko, f), lb = withFailure(C.compile(toko, [act('lb', { instances: 3, detectS: 10 })]).arch, f);
  assert(one.summary.outageSeconds >= 35, 'tunggal mati ' + one.summary.outageSeconds);
  assert(lb.summary.outageSeconds <= 2, 'LB mati total ' + lb.summary.outageSeconds + ' dtk');
  assert(lb.summary.degradedSeconds <= 14 && lb.summary.okPct > 90, 'degradasi ' + lb.summary.degradedSeconds + ' dtk, ketersediaan ' + lb.summary.okPct);
  assert(lb.frames.some(function (x) { return (x.states || {}).api === 'degraded'; }));
});
t('health check lebih lambat = lebih banyak request gagal (detectS)', function () {
  const f = { node: 'api', at: 30, len: 40 }, mk = function (d) { return withFailure(C.compile(toko, [act('lb', { instances: 3, detectS: d })]).arch, f).summary.eConn; };
  assert(mk(40) > mk(3) * 2, 'detectS 40 -> ' + mk(40) + ' error vs detectS 3 -> ' + mk(3));
});
t('cache mati tidak membuat layanan mati: request jatuh ke database (lebih lambat, bukan error koneksi)', function () {
  const rd = C.compile(toko, [act('redis', { hit: 90 })]).arch, l = heavy(toko, 3000);
  const ok = Lab.simulate(rd, { load: l, seconds: 80 }), down = Lab.simulate(rd, { load: l, seconds: 80, failure: { node: 'cache', at: 20, len: 40 } });
  assert.strictEqual(down.summary.eConn, 0, 'tidak ada error koneksi');
  assert(down.summary.fastPct < ok.summary.fastPct - 20, 'cache mati menurunkan kecepatan: ' + ok.summary.fastPct + ' -> ' + down.summary.fastPct);
});
t('target kegagalan yang tidak ada atau tidak bisa dimatikan dilaporkan, bukan diabaikan diam-diam', function () {
  assert(/tidak ada/.test(Failures.expand(toko, { node: 'x-lb', at: 1, len: 5 }).skipped));
  assert(/tidak bisa dimatikan/.test(Failures.expand(toko, { node: 'gateway', at: 1, len: 5 }).skipped));
  assert.strictEqual(withFailure(toko, { node: 'x-lb', at: 1, len: 5 }, 100, 30).failure.skipped.length > 0, true);
});
t('replikasi asinkron: transaksi berisiko hilang dihitung dari laju tulis x lag; sinkron = 0 tetapi commit lebih lambat', function () {
  const l = heavy(toko, 3000), asyncA = C.compile(toko, [act('hadb', { lagMs: 1000 })]).arch, syncA = C.compile(toko, [act('hadb', { sync: true })]).arch;
  const a = Lab.simulate(asyncA, { load: l, seconds: 30 }).summary.ha[0], s = Lab.simulate(syncA, { load: l, seconds: 30 }).summary.ha[0];
  assert(a.writesPerSec > 5 && a.rpoTx > 5, 'rpo async ' + a.rpoTx + ' dari ' + a.writesPerSec + '/dtk'); assert.strictEqual(s.rpoTx, 0);
  const wr = function (arch) { return arch.workloads.find(function (w) { return w.id === 'checkout'; }).calls.find(function (c) { return c.write; }).read || 0; };
  assert.strictEqual(wr(syncA), wr(toko) + 2, 'commit sinkron menambah 2 ms');
});
t('standby digambar: node + sambungan database -> standby, aliran replikasi sebesar laju commit', function () {
  const a = C.compile(toko, [act('hadb', {})]).arch, e = Sim.edges(a).map(function (x) { return x.join('>'); });
  assert(node(a, 'x-standby-pg') && e.includes('pg>x-standby-pg'));
  const f = Lab.simulate(a, { load: heavy(toko, 500), seconds: 20 }).frames.pop();
  assert(f.flows['pg>x-standby-pg'] > 0 && f.flows['pg>x-standby-pg'] <= f.flows['api>pg'], JSON.stringify(f.flows));
});

console.log('Filter/WAF dan database terpisah');
t('filter: membuang sebagian trafik, rate limit membatasi total, dan berada di depan load balancer', function () {
  const a = C.compile(toko, [act('lb', {}), act('filter', { blockPct: 40, limitRps: 0, ms: 1 })]).arch;
  assert.deepStrictEqual(a.nodes.filter(function (n) { return n.type === 'proxy'; }).map(function (n) { return n.id; }), ['x-filter', 'x-lb', 'gateway']);
  const base = Load.rates(toko, Load.defaults(toko), 0), r = Load.rates(a, Load.defaults(a), 0);
  assert(Math.abs(r.browse / base.browse - 0.6) < 0.01, 'rasio=' + r.browse / base.browse);
  const lim = C.compile(toko, [act('filter', { blockPct: 0, limitRps: 20 })]).arch, rl = Load.rates(lim, heavy(lim, 3000), 0);
  assert(Math.abs(Object.keys(rl).reduce(function (s, k) { return s + rl[k]; }, 0) - 20) < 0.5, 'total dibatasi 20/dtk');
  const f = Lab.simulate(a, { load: heavy(a, 500), seconds: 20 }).frames.pop();
  assert(f.flows['users>x-filter'] === undefined && f.flows['shopper>x-filter'] > f.flows['x-filter>x-lb'], 'trafik masuk filter lebih besar daripada yang lolos: ' + JSON.stringify(f.flows));
});
t('filter pada beban tinggi memulihkan layanan (trafik jahat dibuang sebelum menyentuh server)', function () {
  const r = run(C.compile(toko, [act('filter', { blockPct: 40 })]).arch, heavy(toko, 3000));
  assert(r.summary.fastPct > 90, 'fastPct=' + r.summary.fastPct);
});
t('database terpisah: fitur dipindah ke database dan disk sendiri, dengan sambungan baru', function () {
  const a = C.compile(toko, [act('dbsplit', { workload: 'report' })]).arch;
  assert(node(a, 'x-db-report-pg') && node(a, 'x-disk-report-ssd') && node(a, 'x-db-report-pg').disk === 'x-disk-report-ssd');
  assert(a.workloads.find(function (w) { return w.id === 'report'; }).calls.every(function (c) { return c.node === 'x-db-report-pg'; }));
  assert(a.workloads.find(function (w) { return w.id === 'browse'; }).calls.some(function (c) { return c.node === 'pg'; }), 'fitur lain tetap di database lama');
  const e = Sim.edges(a).map(function (x) { return x.join('>'); });
  assert(e.includes('api>x-db-report-pg') && e.includes('x-db-report-pg>x-disk-report-ssd'));
});
t('simulasi berbenih: masukan yang sama selalu memberi hasil yang sama', function () {
  const a = run(toko, heavy(toko, 700), 40), b = run(toko, heavy(toko, 700), 40);
  assert.deepStrictEqual(a.summary, b.summary); assert.deepStrictEqual(a.frames[10], b.frames[10]);
});

console.log('Berlaku umum (tidak condong ke satu tumpukan)');
const Recommend = require('../src/recommend.js');
t('flush=2 (InnoDB) hanya disarankan untuk keluarga MySQL, bukan database lain atau yang tak dikenal', function () {
  const mk = function (label) { const a = JSON.parse(JSON.stringify(api)); node(a, 'ssd').fsyncMs = 14; node(a, 'ssd').amp = 1; node(a, 'db').label = label; return a; };
  const ids = function (a) { return Recommend.analyze(a, null).map(function (r) { return r.id; }); };
  assert(ids(mk('MySQL 8.0')).some(function (i) { return i.indexOf('flush2') === 0; }), 'MySQL harus dapat saran flush');
  ['Database Postgres', 'MongoDB', 'Database', 'Oracle'].forEach(function (l) { assert(!ids(mk(l)).some(function (i) { return i.indexOf('flush2') === 0; }), l + ' tidak boleh dapat saran InnoDB'); });
});
t('saran penyimpanan tidak memaksa istilah ZFS/Proxmox/SLOG sebagai satu-satunya jalan', function () {
  const a = JSON.parse(JSON.stringify(api)); node(a, 'ssd').fsyncMs = 14; a.observedFaults = [{ node: 'ssd', type: 'stall', every: 150, len: 60 }];
  const r = Recommend.analyze(a, null).find(function (x) { return x.id === 'slog'; });
  assert(r, 'saran percepat commit muncul karena ada bukti ukur'); assert(/NVMe/.test(r.title) && /(mis\.|misalnya) SLOG/.test(r.title), r.title); assert(!/Proxmox/i.test(JSON.stringify(r)));
});
t('uji ketahanan bawaan diberi nama netral (bukan kejadian nyata)', function () {
  Recommend.defaultFaults(toko).forEach(function (f) { assert(/^Uji ketahanan/.test(f._nama), f._nama); });
});

console.log('Potensi bottleneck (urutan jenuh, bukan angka mutlak)');
const Sens = require('../src/sensitivity.js');
t('hasil sama untuk masukan yang sama (pengacak berbenih)', function () {
  const a = Sens.analyze(toko, { load: Load.defaults(toko), variations: 4 }), b = Sens.analyze(toko, { load: Load.defaults(toko), variations: 4 });
  assert.deepStrictEqual(a.ranking.map(function (x) { return [x.node, x.count, x.medianMultiple]; }), b.ranking.map(function (x) { return [x.node, x.count, x.medianMultiple]; }));
});
t('toko online: leher botol pertama ada di pool server API (laporan berat menahan worker), dengan keyakinan terukur', function () {
  const r = Sens.analyze(toko, { load: Load.defaults(toko), variations: 8 });
  assert.strictEqual(r.ranking[0].node, 'api'); assert(r.ranking[0].share >= 0.5, 'share=' + r.ranking[0].share);
  assert.strictEqual(r.variations, 8); assert(r.ranking.every(function (x) { return x.title && x.medianMultiple > 0; }));
});
t('memasang Redis menaikkan ambang jenuh (kelipatan beban median lebih besar)', function () {
  const before = Sens.analyze(toko, { load: Load.defaults(toko), variations: 6 }), after = Sens.analyze(C.compile(toko, [act('redis', { hit: 90 })]).arch, { load: Load.defaults(toko), variations: 6 });
  assert(after.ranking[0].medianMultiple >= before.ranking[0].medianMultiple, before.ranking[0].medianMultiple + ' -> ' + after.ranking[0].medianMultiple);
});
t('arsitektur yang sangat longgar: tidak ada leher botol sampai kelipatan terbesar', function () {
  const big = JSON.parse(JSON.stringify(api)); big.nodes.forEach(function (n) { if (n.type === 'pool') { n.workers = 4000; n.cores = 400; } if (n.type === 'db') n.connections = 5000; });
  const r = Sens.analyze(big, { load: Object.assign(Load.defaults(big), { users: 10 }), variations: 3, maxPeak: 100000 });
  assert.strictEqual(r.ranking.length, 0); assert.strictEqual(r.healthyCount, 3);
});
t('batas peak: kelipatan yang melebihi batas request/detik tidak dijalankan (capped)', function () {
  const r = Sens.analyze(toko, { load: Object.assign(Load.defaults(toko), { users: 100 }), variations: 2, maxPeak: 5 });
  assert(r.cappedCount + r.ranking.length > 0 && r.ms < 5000);
});
t('anggaran waktu: berhenti lebih awal tetapi tetap memberi hasil dan menandai tidak lengkap', function () {
  const r = Sens.analyze(toko, { load: Load.defaults(toko), variations: 8, budgetMs: 1 });
  assert(r.variations >= 1 && r.variations < 8 && r.complete === false);
});
t('yang diukur tidak divariasikan; yang ditandai asumsi divariasikan', function () {
  const a = JSON.parse(JSON.stringify(toko)); node(a, 'api').assumed = ['workers']; node(a, 'pg').connections = 100;
  const rnd = Sens.mulberry32(7); let changed = false;
  for (let i = 0; i < 10; i++) { const p = Sens.perturb(a, rnd); assert.strictEqual(node(p, 'pg').connections, 100, 'nilai terukur tetap'); if (node(p, 'api').workers !== node(a, 'api').workers) changed = true; }
  assert(changed, 'worker asumsi berubah pada sebagian variasi');
});

t('waktu CPU yang diisi pengguna (cpuAssumed:false) tidak divariasikan; yang tebakan divariasikan', function () {
  const a = JSON.parse(JSON.stringify(toko)); a.workloads[0].cpuMs = 10; a.workloads[0].cpuAssumed = false; a.workloads[1].cpuMs = 10; a.workloads[1].cpuAssumed = true;
  const rnd = Sens.mulberry32(11); let guessChanged = false;
  for (let i = 0; i < 10; i++) { const p = Sens.perturb(a, rnd); assert.strictEqual(p.workloads[0].cpuMs, 10, 'nilai pengguna tetap'); if (p.workloads[1].cpuMs !== 10) guessChanged = true; }
  assert(guessChanged, 'cpuMs tebakan berubah pada sebagian variasi');
});

console.log('\n' + pass + ' lolos, ' + fail + ' gagal');
process.exit(fail ? 1 : 0);
