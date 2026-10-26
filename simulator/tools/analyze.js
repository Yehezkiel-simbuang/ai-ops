#!/usr/bin/env node
// Analyzer workspace: membaca sebuah proyek lalu menghasilkan model arsitektur (JSON) untuk lab.
//
//   node tools/analyze.js <folder-proyek> [--observed berkas.json] [--out arsitektur.json] [--facts fakta.json]
//
// Prinsip:
//  - hanya membaca; tidak pernah menulis ke proyek yang dianalisis
//  - .env dibaca hanya untuk kunci non-rahasia dalam daftar putih, nilainya tidak dicetak
//    (host hanya diklasifikasikan lokal/jarak jauh)
//  - setiap temuan menyertakan file bukti; angka yang tidak bisa diturunkan dari kode ditandai asumsi
//  - nilai hasil ukur produksi ditimpa dari berkas --observed
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['vendor', 'node_modules', '.git', 'storage', 'bootstrap', 'public', 'dist', 'build', '.idea', '.vscode', 'backup']);
const ENV_WHITELIST = ['APP_ENV', 'APP_DEBUG', 'DB_CONNECTION', 'DB_HOST', 'CACHE_DRIVER', 'CACHE_STORE', 'SESSION_DRIVER', 'QUEUE_CONNECTION', 'REDIS_HOST', 'REDIS_CLIENT', 'LOG_LEVEL', 'BCRYPT_ROUNDS'];

function read(p) { try { const s = fs.statSync(p); if (s.size > 600000) return ''; return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function walk(dir, exts, out, depth) {
  out = out || []; depth = depth || 0;
  if (depth > 8) return out;
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  list.forEach(function (d) {
    if (d.isDirectory()) { if (!SKIP.has(d.name)) walk(path.join(dir, d.name), exts, out, depth + 1); }
    else if (exts.some(function (x) { return d.name.endsWith(x); })) out.push(path.join(dir, d.name));
  });
  return out;
}
function rel(root, p) { return path.relative(root, p).split(path.sep).join('/'); }

function parseEnv(root) {
  const file = ['.env', '.env.example'].map(function (f) { return path.join(root, f); }).find(exists);
  const out = { file: file ? path.basename(file) : null, values: {} };
  if (!file) return out;
  read(file).split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || ENV_WHITELIST.indexOf(m[1]) < 0) return;
    let v = m[2].replace(/^["']|["']$/g, '');
    if (m[1] === 'DB_HOST' || m[1] === 'REDIS_HOST') v = (v === '127.0.0.1' || v === 'localhost' || v === '::1' || v.indexOf('/') === 0) ? 'lokal' : 'jarak-jauh';
    out.values[m[1]] = v;
  });
  return out;
}

function detectStack(root) {
  const s = { name: 'tidak dikenal', kind: 'unknown', packages: [] };
  const composer = read(path.join(root, 'composer.json'));
  if (composer) {
    try {
      const j = JSON.parse(composer), req = Object.assign({}, j.require, j['require-dev']);
      if (req['laravel/framework']) { s.kind = 'laravel'; s.name = 'Laravel ' + String(req['laravel/framework']).replace(/[^0-9.x]/g, ''); }
      s.php = req.php; s.packages = Object.keys(req);
    } catch (e) { /* abaikan */ }
  }
  const pkg = read(path.join(root, 'package.json'));
  if (s.kind === 'unknown' && pkg) {
    try { const j = JSON.parse(pkg), d = Object.assign({}, j.dependencies, j.devDependencies);
      ['express', 'fastify', '@nestjs/core', 'next', 'koa'].forEach(function (k) { if (d[k] && s.kind === 'unknown') { s.kind = 'node'; s.name = 'Node.js (' + k + ')'; } });
      s.packages = Object.keys(d); } catch (e) { /* abaikan */ }
  }
  if (s.kind === 'unknown' && (exists(path.join(root, 'manage.py')) || exists(path.join(root, 'requirements.txt')))) { s.kind = 'python'; s.name = 'Python'; }
  if (s.kind === 'unknown' && (exists(path.join(root, 'pom.xml')) || exists(path.join(root, 'build.gradle')))) { s.kind = 'java'; s.name = 'Java'; }
  if (s.kind === 'unknown' && exists(path.join(root, 'go.mod'))) { s.kind = 'go'; s.name = 'Go'; }
  return s;
}

// ---------------- analisis Laravel
function analyzeLaravel(root, stack, env) {
  const f = { evidence: {} };
  const ev = function (k, v) { (f.evidence[k] = f.evidence[k] || []).push(v); };
  const lock = read(path.join(root, 'composer.lock'));
  const m = lock.match(/"name": "laravel\/sanctum",\s*"version": "v?([0-9.]+)"/);
  f.sanctum = stack.packages.indexOf('laravel/sanctum') >= 0; f.sanctumVersion = m ? m[1] : null;
  f.redisClient = env.values.REDIS_CLIENT || null;
  f.drivers = { db: env.values.DB_CONNECTION || 'mysql', dbHost: env.values.DB_HOST || null, cache: env.values.CACHE_DRIVER || env.values.CACHE_STORE || 'file', session: env.values.SESSION_DRIVER || 'file', queue: env.values.QUEUE_CONNECTION || 'sync', redisHost: env.values.REDIS_HOST || null };
  f.appDebug = env.values.APP_DEBUG === 'true'; f.appEnv = env.values.APP_ENV || null;
  f.configCached = exists(path.join(root, 'bootstrap', 'cache', 'config.php'));
  f.routesCached = exists(path.join(root, 'bootstrap', 'cache', 'routes-v7.php'));

  const routeFiles = walk(path.join(root, 'routes'), ['.php']).concat(walk(path.join(root, 'app'), ['Route.php']));
  f.routes = { api: 0, web: 0, sanctumGuarded: false };
  routeFiles.forEach(function (p) {
    const txt = read(p), n = (txt.match(/Route::(get|post|put|patch|delete|any|match|resource|apiResource)\(/g) || []).length;
    if (/routes[\\/]api\.php$/.test(p)) { f.routes.api += n; if (/auth:sanctum/.test(txt)) { f.routes.sanctumGuarded = true; ev('sanctum_routes', rel(root, p)); } } else f.routes.web += n;
  });

  const phpFiles = walk(path.join(root, 'app'), ['.php']);
  f.jobs = []; f.queues = {}; f.external = {}; f.heavyLoops = []; f.lockForUpdate = 0; f.apiControllers = [];
  const hostRe = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
  phpFiles.forEach(function (p) {
    const txt = read(p), r = rel(root, p);
    if (/app\/Jobs\//.test(r)) f.jobs.push(path.basename(p, '.php'));
    let q; const qre = /onQueue\(['"]([a-z_]+)['"]\)/g;
    while ((q = qre.exec(txt))) f.queues[q[1]] = (f.queues[q[1]] || 0) + 1;
    f.lockForUpdate += (txt.match(/lockForUpdate\(/g) || []).length;
    const isApiCtl = /Controllers\/.*\/Api\//.test(r) || /Api\.php$/.test(r);
    if (isApiCtl) f.apiControllers.push(r);
    let h; hostRe.lastIndex = 0;
    while ((h = hostRe.exec(txt))) {
      const host = h[1].toLowerCase().split('.').slice(-2).join('.');
      if (/(w3\.org|example\.com|schema\.org|localhost|github\.com|googleapis|gstatic|laravel\.com|php\.net|apache\.org)/.test(host)) continue;
      if (!/Http::|curl_init|Guzzle|->post\(|->get\(/.test(txt)) continue;
      (f.external[host] = f.external[host] || []).push(r);
    }
    if (/Controllers\//.test(r) && /chunkById|->chunk\(|foreach\s*\(\s*\$[a-z]+Ids/.test(txt) && /DB::|->get\(|::where\(/.test(txt)) f.heavyLoops.push(r);
  });
  f.snmp = phpFiles.some(function (p) { return /snmp2_(walk|get)/.test(read(p)); });

  const kernel = read(path.join(root, 'app', 'Console', 'Kernel.php'));
  f.schedule = { total: (kernel.match(/\$schedule->command\(/g) || []).length, everyMinute: (kernel.match(/everyMinute|everyTwoMinutes|everyFiveMinutes/g) || []).length };
  const queueCfg = read(path.join(root, 'config', 'queue.php')); const ra = queueCfg.match(/'retry_after'\s*=>\s*(\d+)/);
  f.retryAfter = ra ? Number(ra[1]) : null;
  return f;
}

// ---------------- membangun arsitektur dari fakta
const COLORS = ['#2f6fd6', '#d9691a', '#118a8a', '#8a4fd0', '#c2410c', '#0f766e', '#a21caf', '#4d7c0f'];
function hostLabel(host) {
  if (/xendit/.test(host)) return 'Xendit (pembayaran)';
  return host.replace(/^(www|api)\./, '').split('.')[0].replace(/^./, function (c) { return c.toUpperCase(); }) + ' API';
}

function buildLaravel(root, stack, env, f) {
  const nodes = [], workloads = [];
  const hasRedis = f.drivers.cache === 'redis' || f.drivers.session === 'redis' || f.drivers.queue === 'redis';
  const dbRemote = f.drivers.dbHost === 'jarak-jauh';
  nodes.push({ id: 'mobile', type: 'client', label: 'Aplikasi mobile', icon: 'phone' });
  nodes.push({ id: 'admin', type: 'client', label: 'Panel admin', icon: 'monitor' });
  nodes.push({ id: 'nginx', type: 'proxy', label: 'Nginx', timeoutS: 60 });
  nodes.push({ id: 'fpm', type: 'pool', label: 'PHP-FPM', workers: 20, assumed: ['workers'] });
  if (hasRedis) nodes.push({ id: 'redis', type: 'cache', label: 'Redis (' + [f.drivers.cache, f.drivers.session, f.drivers.queue].filter(function (x) { return x === 'redis'; }).length + ' fungsi)' });
  nodes.push({ id: 'mysql', type: 'db', label: 'Database ' + f.drivers.db + (dbRemote ? ' (jarak jauh)' : ''), connections: 151, flush: 1, group: true, hotKeys: 300, disk: 'storage', assumed: ['connections', 'flush', 'hotKeys'] });
  nodes.push({ id: 'storage', type: 'disk', label: 'Penyimpanan', fsyncMs: 8, bwMBs: 100, amp: 1, slog: false, assumed: ['fsyncMs', 'bwMBs', 'amp'] });
  Object.keys(f.external).forEach(function (h) { if (!f.external[h].some(function (p) { return /\/Api\/|Api\.php/.test(p); })) return; nodes.push({ id: 'ext_' + h.replace(/[^a-z0-9]/g, '_'), type: 'external', label: hostLabel(h), host: h }); });

  const redisCall = hasRedis ? [{ node: 'redis', ms: 1 }] : [];
  let ci = 0;
  const color = function () { return COLORS[(ci++) % COLORS.length]; };
  if (f.routes.api > 0) {
    workloads.push({ id: 'mobile_api', label: 'API mobile', client: 'mobile', pool: 'fpm', rate: 30, rateAssumed: true, cpuAssumed: true, cpuMs: 40, color: color(),
      calls: redisCall.concat([f.sanctum && f.routes.sanctumGuarded
        ? { node: 'mysql', read: 4, write: true, hot: true, kb: 4, tag: 'sanctum_last_used' }
        : { node: 'mysql', read: 4 }]),
      evidence: f.sanctum ? ['laravel/sanctum' + (f.sanctumVersion ? ' ' + f.sanctumVersion : '') + ' menulis last_used_at di setiap request API (vendor/laravel/sanctum Guard)'].concat(f.evidence.sanctum_routes || []) : ['routes/api.php'] });
    workloads.push({ id: 'mobile_login', label: 'Login mobile (bcrypt + tulis)', client: 'mobile', pool: 'fpm', rate: 2, rateAssumed: true, cpuAssumed: true, cpuMs: 120, color: color(),
      calls: [{ node: 'mysql', read: 4, write: true, kb: 4 }, { node: 'mysql', write: true, kb: 4 }], evidence: ['routes/api.php: POST login'] });
  }
  Object.keys(f.external).forEach(function (h) {
    const files = f.external[h].filter(function (p) { return /\/Api\/|Api\.php/.test(p); });
    if (!files.length) return;
    const id = 'ext_' + h.replace(/[^a-z0-9]/g, '_');
    workloads.push({ id: 'mobile_ext_' + id.slice(4, 16), label: 'Pembayaran lewat ' + hostLabel(h), client: 'mobile', pool: 'fpm', rate: 0.5, rateAssumed: true, cpuAssumed: true, cpuMs: 80, color: color(),
      calls: [{ node: 'mysql', read: 5 }, { node: id, ms: 900 }, { node: 'mysql', write: true, kb: 8 }], evidence: files });
  });
  if (f.routes.web > 0) workloads.push({ id: 'admin_web', label: 'Panel admin (halaman biasa)', client: 'admin', pool: 'fpm', rate: 1, rateAssumed: true, cpuAssumed: true, cpuMs: 80, color: color(),
    calls: redisCall.concat([{ node: 'mysql', read: 20 }]), evidence: ['routes/web.php (' + f.routes.web + ' rute)'] });
  if (f.heavyLoops.length) workloads.push({ id: 'admin_report', label: 'Laporan admin berat (loop query)', client: 'admin', pool: 'fpm', rate: 0.3, rateAssumed: true, cpuAssumed: true, cpuMs: 200, color: color(),
    calls: [{ node: 'mysql', read: 30 }, { node: 'mysql', read: 800, tag: 'report_loop' }], evidence: f.heavyLoops });
  if (f.drivers.queue !== 'sync') {
    nodes.push({ id: 'workers', type: 'client', label: 'Queue worker', icon: 'gear' });
    workloads.push({ id: 'queue_jobs', label: 'Antrean (' + Object.keys(f.queues).length + ' queue, ' + f.jobs.length + ' job)', client: 'workers', async: true, rate: 2, rateAssumed: true, cpuAssumed: true, color: color(), calls: [{ node: 'mysql', write: true, kb: 16 }], evidence: ['app/Jobs (' + f.jobs.length + ' job)', 'queue: ' + Object.keys(f.queues).join(', ')] });
  }
  return { schema: 1, name: path.basename(root) + ' (saat ini)', stack: [stack.name, stack.php ? 'PHP ' + stack.php : null, f.drivers.db].filter(Boolean), nodes: nodes, workloads: workloads, faults: [] };
}

function buildGeneric(root, stack, env) {
  const dbType = env.values.DB_CONNECTION || 'sql';
  return { schema: 1, name: path.basename(root) + ' (saat ini)', stack: [stack.name], faults: [],
    nodes: [{ id: 'user', type: 'client', label: 'Pengguna', icon: 'monitor' }, { id: 'lb', type: 'proxy', label: 'Gateway', timeoutS: 30 }, { id: 'app', type: 'pool', label: 'Aplikasi (' + stack.name + ')', workers: 16, assumed: ['workers'] },
      { id: 'db', type: 'db', label: 'Database ' + dbType, connections: 100, flush: 1, group: true, disk: 'storage', assumed: ['connections'] }, { id: 'storage', type: 'disk', label: 'Penyimpanan', fsyncMs: 8, bwMBs: 100, amp: 1, assumed: ['fsyncMs'] }],
    workloads: [{ id: 'web', label: 'Request web', client: 'user', pool: 'app', rate: 30, rateAssumed: true, cpuAssumed: true, cpuMs: 30, color: COLORS[0], calls: [{ node: 'db', read: 5, write: true }], evidence: ['tumpukan ' + stack.name + ' terdeteksi; detail belum dianalisis'] }] };
}

function mergeObserved(arch, observed) {
  if (!observed) return arch;
  Object.keys(observed.nodes || {}).forEach(function (id) {
    const n = arch.nodes.find(function (x) { return x.id === id; }); if (!n) return;
    Object.keys(observed.nodes[id]).forEach(function (k) {
      if (k === '_evidence') { n.evidence = observed.nodes[id][k]; return; }
      n[k] = observed.nodes[id][k];
      if (n.assumed) n.assumed = n.assumed.filter(function (a) { return a !== k; });
    });
  });
  Object.keys(observed.rates || {}).forEach(function (id) { const w = arch.workloads.find(function (x) { return x.id === id; }); if (w) w.rate = observed.rates[id]; });
  arch.observedFaults = (observed.faults || []).map(function (f) { const c = Object.assign({}, f); c.name = c._nama; delete c._nama; return c; });
  arch.observedSource = observed.source;
  return arch;
}

function analyze(root, observed) {
  const env = parseEnv(root), stack = detectStack(root);
  let facts = { stack: stack.name, kind: stack.kind, envFile: env.file }, arch;
  if (stack.kind === 'laravel') { const f = analyzeLaravel(root, stack, env); facts = Object.assign(facts, f); arch = buildLaravel(root, stack, env, f); }
  else { const g = require('./analyze/index.js').analyzeGeneric(root); arch = g.arch; facts = Object.assign(facts, g.facts); }
  mergeObserved(arch, observed);
  arch.meta = { analyzedAt: new Date().toISOString().slice(0, 10), root: path.basename(root), kind: stack.kind };
  return { arch: arch, facts: facts };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = function (k) { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const root = a[0] && a[0].indexOf('--') !== 0 ? path.resolve(a[0]) : null;
  if (!root || !exists(root)) { console.error('Pakai: node tools/analyze.js <folder-proyek> [--observed berkas.json] [--out arsitektur.json] [--facts fakta.json]'); process.exit(1); }
  const obsFile = opt('--observed'); const observed = obsFile ? JSON.parse(read(path.resolve(obsFile))) : null;
  const res = analyze(root, observed);
  const out = opt('--out'), fx = opt('--facts');
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(res.arch, null, 2)); else console.log(JSON.stringify(res.arch, null, 2));
  if (fx) fs.writeFileSync(path.resolve(fx), JSON.stringify(res.facts, null, 2));
  console.error('Tumpukan: ' + res.facts.stack + ' | node: ' + res.arch.nodes.length + ' | workload: ' + res.arch.workloads.length + (out ? ' | ditulis ke ' + out : ''));
}
module.exports = { analyze: analyze };
