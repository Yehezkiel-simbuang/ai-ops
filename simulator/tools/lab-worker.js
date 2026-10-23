// Worker thread untuk lab: semua pekerjaan CPU (analisis proyek, simulasi) dijalankan di sini supaya server HTTP tidak tertahan.
// Protokol: pesan { id, op, payload } -> balasan { id, ok: true, result } atau { id, ok: false, error }.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const Load = require('../src/load.js');
const Recommend = require('../src/recommend.js');
const Components = require('../src/components.js');
const Lab = require('../src/lab.js');
const Sensitivity = require('../src/sensitivity.js');
const Pipeline = require('./pipeline.js');

const ARCH_DIR = path.join(__dirname, '..', 'architectures');
const readJson = function (name) { try { return JSON.parse(fs.readFileSync(path.join(ARCH_DIR, name), 'utf8')); } catch (e) { return null; } };
const MANIFESTS = ['composer.json', 'package.json', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Gemfile'];
const KIND = { 'composer.json': 'PHP', 'package.json': 'Node', 'go.mod': 'Go', 'pom.xml': 'Java', 'build.gradle': 'Java', 'build.gradle.kts': 'Java', 'requirements.txt': 'Python', 'pyproject.toml': 'Python', Pipfile: 'Python', Gemfile: 'Ruby' };

const EXAMPLES = [
  { id: 'contoh-api-sederhana', name: 'Contoh: API sederhana (1 server + database)', file: 'contoh-api-sederhana.json' },
  { id: 'contoh-toko-online', name: 'Contoh: toko online (laporan berat + pembayaran)', file: 'contoh-toko-online.json' },
  { id: 'contoh-web-hdd', name: 'Contoh: aplikasi web dengan database di disk lambat (data rekaan)', file: 'contoh-web-hdd.current.json', facts: 'contoh-web-hdd.facts.json' }
];

const stripFaultNames = function (list) { return (list || []).map(function (f) { const c = Object.assign({}, f); delete c.name; delete c._nama; return c; }); };

/** Bentuk seragam untuk satu proyek: arsitektur, rekomendasi, gangguan yang diketahui, beban awal, katalog komponen. */
function describe(arch, facts, source) {
  const recs = Recommend.analyze(arch, facts || null);
  const known = arch.observedFaults && arch.observedFaults.length;
  const faults = known ? arch.observedFaults : Recommend.defaultFaults(arch);
  const slim = recs.map(function (r) { return { id: r.id, title: r.title, severity: r.severity, optional: !!r.optional, why: r.why || [], tradeoff: r.tradeoff || '', expected: r.expected || '', patch: r.patch || [] }; });
  return {
    arch: arch, facts: facts ? { stack: facts.stack || null, kind: facts.kind || null } : null, recs: slim,
    recommendedIds: slim.filter(function (r) { return !r.optional && r.patch.length; }).map(function (r) { return r.id; }),
    faults: faults.map(function (f) { return { name: f.name || f._nama || (f.type + ' ' + f.node), spec: stripFaultNames([f])[0] }; }), faultsAssumed: !known,
    seconds: known ? 300 : 120,   // gangguan baru terasa dampaknya setelah beberapa siklus: beri waktu cukup
    load: Load.defaults(arch), catalog: Components.catalog(arch), source: source
  };
}

const OPS = {
  listExamples: function () {
    return EXAMPLES.filter(function (e) { return readJson(e.file); }).map(function (e) { const a = readJson(e.file); return { id: e.id, name: e.name, source: 'contoh', stack: a.stack || [] }; });
  },
  listFolders: function (p) {
    const out = [];
    fs.readdirSync(p.root, { withFileTypes: true }).forEach(function (d) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') return;
      let names = []; try { names = fs.readdirSync(path.join(p.root, d.name)); } catch (e) { return; }
      const kinds = {}; names.forEach(function (n) { if (KIND[n]) kinds[KIND[n]] = 1; if (/\.csproj$/.test(n)) kinds['.NET'] = 1; });
      if (Object.keys(kinds).length) out.push({ id: 'folder:' + d.name, name: d.name, source: 'folder', stack: Object.keys(kinds) });
    });
    return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  },
  example: function (p) {
    const e = EXAMPLES.find(function (x) { return x.id === p.id; }); if (!e) throw new Error('Proyek contoh tidak ada');
    const arch = readJson(e.file); if (!arch) throw new Error('Berkas arsitektur tidak ada');
    const d = describe(arch, e.facts ? readJson(e.facts) : null, 'contoh'); d.id = e.id; d.name = e.name; d.stack = arch.stack || []; return d;
  },
  analyze: function (p) {
    const r = Pipeline.run(p.dir, { prove: false, seconds: 30 }), d = describe(r.arch, r.facts, 'folder');
    d.id = p.id; d.name = p.name; d.stack = [r.facts.stack]; return d;
  },
  // potensi bottleneck: urutan komponen yang jenuh lebih dulu, untuk kondisi sekarang dan eksperimen (tanpa gangguan)
  bottlenecks: function (p) {
    const exp = Components.compile(p.arch, p.actions, p.recs), opt = { load: p.load, budgetMs: 6000, seed: p.seed };
    return { baseline: Sensitivity.analyze(p.arch, opt), experiment: Sensitivity.analyze(exp.arch, opt) };
  },
  simulate: function (p) {
    const compiled = Components.compile(p.arch, p.actions, p.recs);
    const opt = { load: p.load, seconds: p.seconds, faults: p.faults, failure: p.failure || null };   // failure: matikan node pada detik tertentu (diterjemahkan menurut ketahanan arsitektur)
    const out = { applied: compiled.applied, skipped: compiled.skipped, experiment: Object.assign({ arch: compiled.arch }, Lab.simulate(compiled.arch, opt)) };
    if (p.withBaseline) out.baseline = Object.assign({ arch: p.arch }, Lab.simulate(p.arch, opt));
    return out;
  }
};

parentPort.on('message', function (m) {
  try { parentPort.postMessage({ id: m.id, ok: true, result: OPS[m.op](m.payload || {}) }); }
  catch (e) { parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) }); }
});
