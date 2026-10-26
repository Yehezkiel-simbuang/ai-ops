// Membangun arsitektur simulasi dari fakta standar semua tumpukan.
// Semua laju (rate) dan biaya CPU adalah ASUMSI dan ditandai; ukuran pool/worker diambil dari kode/infra bila ada.
const path = require('path');

const COLORS = ['#2f6fd6', '#d9691a', '#118a8a', '#8a4fd0', '#c2410c', '#0f766e', '#a21caf', '#4d7c0f'];
const DB_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL/MariaDB', mongo: 'MongoDB', sqlite: 'SQLite', mssql: 'SQL Server', oracle: 'Oracle', sql: 'Database SQL' };
const DB_CONN_DEFAULT = { postgres: 100, mysql: 151, mongo: 1000, sqlite: 1, mssql: 200, oracle: 100, sql: 100 };
const slug = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); };
function hostLabel(h) { return /xendit/.test(h) ? 'Xendit (pembayaran)' : /midtrans/.test(h) ? 'Midtrans (pembayaran)' : /stripe/.test(h) ? 'Stripe (pembayaran)' : h.split('.')[0].replace(/^./, function (c) { return c.toUpperCase(); }) + ' API'; }

// apakah unit ini backend yang melayani request (bukan frontend, bukan hanya worker)
function isServer(f) { return !f.frontend && f.routes >= 0 && !(f.stack === 'python' && /worker/.test(f.name)); }

function poolFor(f, id, label, infra) {
  const n = { id: id, type: 'pool', label: label, assumed: [] };
  let workers = f.workers;
  if (f.model === 'event-loop') { n.workers = workers || 1000; n.cores = f.cores || (f.stack === 'node' || f.stack === 'python' ? 1 : (infra.cpus ? Math.ceil(infra.cpus) : 0)); if (!f.workers) n.assumed.push('workers'); if (!f.cores && (f.stack === 'node' || f.stack === 'python')) n.assumed.push('cores'); }
  else { n.workers = workers || (f.stack === 'python' ? 4 : f.stack === 'ruby' ? 5 : 20); if (!workers) n.assumed.push('workers'); n.cores = f.cores && f.stack !== 'python' ? f.cores * (f.stack === 'ruby' ? 1 : 1) : 0; if (f.stack === 'python' && f.cores) n.cores = f.cores; }
  if (infra.replicas && infra.replicas > 1) { n.workers *= infra.replicas; if (n.cores) n.cores *= infra.replicas; n.replicas = infra.replicas; }
  return n;
}

function build(root, facts, infra, env) {
  const nodes = [], workloads = [], notes = [];
  let ci = 0; const color = function () { return COLORS[(ci++) % COLORS.length]; };
  const backs = facts.filter(function (f) { return !f.frontend; }), fronts = facts.filter(function (f) { return f.frontend; });
  nodes.push({ id: 'users', type: 'client', label: fronts.length ? 'Browser / aplikasi' : 'Pengguna', icon: fronts.length ? 'monitor' : 'phone' });
  const proxy = { id: 'gateway', type: 'proxy', label: infra.proxy ? (infra.proxy.kind === 'nginx' ? 'Nginx' : infra.proxy.kind === 'ingress' ? 'Ingress' : 'Reverse proxy') : 'Gateway', timeoutS: (infra.proxy && infra.proxy.timeoutS) || 60 };
  if (!(infra.proxy && infra.proxy.timeoutS)) proxy.assumed = ['timeoutS'];
  nodes.push(proxy);

  if (!backs.length) { // hanya frontend / situs statis
    nodes.push({ id: 'static', type: 'pool', label: 'Server file statis' + (fronts[0] ? ' (' + fronts[0].name + ')' : ''), workers: 1000, cores: 0, assumed: ['workers'] });
    workloads.push({ id: 'pages', label: 'Muat halaman & aset', client: 'users', pool: 'static', rate: 40, rateAssumed: true, cpuAssumed: true, cpuMs: 1, color: color(), calls: [], evidence: ['hanya frontend terdeteksi (tidak ada backend)'] });
    return { schema: 1, name: path.basename(root) + ' (saat ini)', stack: fronts.map(function (f) { return f.name; }), nodes: nodes, workloads: workloads, faults: [], smells: [], notes: ['Proyek ini frontend saja; beban ada di CDN/server statis dan API pihak ketiga.'] };
  }

  // satu pool per backend (gabung bila ada banyak: tiap layanan dapat pool sendiri)
  const dbSeen = {}, cacheSeen = {}, extSeen = {}, queueSeen = {};
  backs.forEach(function (f, i) {
    const pid = backs.length > 1 ? 'app_' + slug(f.dir === '.' ? 'root' : f.dir) : 'app';
    const label = (backs.length > 1 ? f.dir + ': ' : '') + f.name + (f.workers ? ' [' + f.workers + ' pekerja]' : '');
    const pool = poolFor(f, pid, label, infra); pool.evidence = f.evidence.concat(f.assumptions); nodes.push(pool);
    f.poolId = pid;
    f.dbs.forEach(function (d) {
      const id = 'db_' + d.kind; if (dbSeen[id]) { dbSeen[id].poolSizes.push(d.poolSize); return; }
      const sqlite = d.kind === 'sqlite', conns = sqlite ? 1 : (d.poolSize || DB_CONN_DEFAULT[d.kind] || 100);
      const n = { id: id, type: 'db', label: 'Database ' + (DB_LABEL[d.kind] || d.kind) + (d.remote ? ' (jarak jauh)' : ''), connections: conns, flush: 1, group: !sqlite, hotKeys: 300, disk: 'storage', assumed: ['flush', 'hotKeys'].concat(d.poolSize || sqlite ? [] : ['connections']) };
      if (d.poolSize || sqlite) { n.onFull = 'wait'; n.waitTimeoutS = 30; }
      if (sqlite) { n.label += ' (penulis tunggal)'; n.evidence = ['SQLite: satu penulis pada satu waktu']; }
      else if (d.evidence.length) n.evidence = ['pool koneksi ' + d.poolSize + ' (' + d.evidence[0] + ')'];
      n.poolSizes = [d.poolSize]; dbSeen[id] = n; nodes.push(n);
    });
    f.caches.forEach(function (c) { if (!cacheSeen[c]) { cacheSeen[c] = 1; nodes.push({ id: 'cache_' + c, type: 'cache', label: c === 'redis' ? 'Redis' : 'Memcached' }); } });
    f.external.forEach(function (e) { const id = 'ext_' + slug(e.host); if (!extSeen[id]) { extSeen[id] = 1; nodes.push({ id: id, type: 'external', label: hostLabel(e.host), host: e.host }); } });
  });
  Object.keys(dbSeen).forEach(function (k) { delete dbSeen[k].poolSizes; });
  if (nodes.some(function (n) { return n.type === 'db'; })) nodes.push({ id: 'storage', type: 'disk', label: 'Penyimpanan', fsyncMs: 8, bwMBs: 100, amp: 1, slog: false, assumed: ['fsyncMs', 'bwMBs', 'amp'] });

  // beban sinkron per backend
  backs.forEach(function (f) {
    const pid = f.poolId, suffix = backs.length > 1 ? '_' + pid.slice(4) : '', prefix = backs.length > 1 ? f.dir + ': ' : '';
    const dbId = f.dbs.length ? 'db_' + (f.dbs.find(function (d) { return d.kind !== 'sqlite'; }) || f.dbs[0]).kind : null;
    const cacheId = f.caches.length ? 'cache_' + f.caches[0] : null;
    const cacheCall = cacheId ? [{ node: cacheId, ms: 1 }] : [];
    const ev = ['rute terdeteksi: ' + f.routes].concat(f.evidence);
    if (dbId) {
      workloads.push({ id: 'read' + suffix, label: prefix + 'Baca data (GET)', client: 'users', pool: pid, rate: 30, rateAssumed: true, cpuAssumed: true, cpuMs: f.model === 'event-loop' ? 8 : 25, color: color(), calls: cacheCall.concat([{ node: dbId, read: 4 }]), evidence: ev });
      workloads.push({ id: 'write' + suffix, label: prefix + 'Tulis data (POST/PUT)', client: 'users', pool: pid, rate: 6, rateAssumed: true, cpuAssumed: true, cpuMs: f.model === 'event-loop' ? 12 : 40, color: color(), calls: [{ node: dbId, read: 4 }, { node: dbId, write: true, kb: 8 }], evidence: ev });
    } else workloads.push({ id: 'req' + suffix, label: prefix + 'Request API', client: 'users', pool: pid, rate: 30, rateAssumed: true, cpuAssumed: true, cpuMs: 20, color: color(), calls: cacheCall, evidence: ev.concat(['tidak ada database terdeteksi']) });
    f.external.forEach(function (e) {
      const c = { node: 'ext_' + slug(e.host), ms: 900 }; if (f.noTimeout) c.noTimeout = true;
      workloads.push({ id: 'ext_' + slug(e.host) + suffix, label: prefix + 'Panggil ' + hostLabel(e.host), client: 'users', pool: pid, rate: 1, rateAssumed: true, cpuAssumed: true, cpuMs: 30, color: color(),
        calls: (dbId ? [{ node: dbId, read: 3 }] : []).concat([c]).concat(dbId ? [{ node: dbId, write: true, kb: 4 }] : []), evidence: e.files.concat(f.noTimeout ? ['panggilan HTTP tanpa timeout terdeteksi'] : []) });
    });
    f.queues.forEach(function (q) {
      if (queueSeen[q.kind]) return; queueSeen[q.kind] = 1;
      const wid = 'worker_' + slug(q.kind);
      nodes.push({ id: wid, type: 'pool', label: 'Konsumen antrean (' + q.kind + ')', workers: q.concurrency || 4, cores: 0, assumed: q.concurrency ? [] : ['workers'] });
      nodes.push({ id: 'producer_' + slug(q.kind), type: 'client', label: 'Produsen pekerjaan', icon: 'gear' });
      workloads.push({ id: 'jobs_' + slug(q.kind), label: 'Pekerjaan latar (' + q.kind + ')', client: 'producer_' + slug(q.kind), pool: wid, async: true, rate: 3, rateAssumed: true, cpuAssumed: true, color: color(),
        calls: (f.external[0] ? [{ node: 'ext_' + slug(f.external[0].host), ms: 600 }] : []).concat(dbId ? [{ node: dbId, read: 4 }, { node: dbId, write: true, kb: 8 }] : []), evidence: ['antrean ' + q.kind + (q.concurrency ? ' concurrency=' + q.concurrency : ' (concurrency diasumsikan)')] });
    });
  });
  const stackNames = backs.map(function (f) { return f.name; }).concat(fronts.map(function (f) { return f.name; }));
  const arch = { schema: 1, name: path.basename(root) + ' (saat ini)', stack: stackNames.slice(0, 5), nodes: nodes, workloads: workloads, faults: [], notes: notes };
  const smells = []; backs.forEach(function (f) { f.smells.forEach(function (s) { smells.push(Object.assign({ unit: f.dir, poolId: f.poolId }, s)); }); });
  arch.smells = smells;
  return arch;
}

module.exports = { build: build };
