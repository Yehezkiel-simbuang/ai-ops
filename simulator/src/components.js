// Katalog komponen eksperimen ("blok bangunan") untuk lab arsitektur. Tiap komponen:
//   describe(arch) -> { available, reason?, params: [...] }   apa yang bisa diatur untuk arsitektur ini (opsi dihitung dari arsitekturnya)
//   apply(arch, p) -> arsitektur baru                          salinan; arsitektur asli tidak pernah diubah
// Aturan: id node buatan komponen berawalan "x-" supaya tidak bentrok dengan node asli, dan satu komponen dengan target yang sama hanya sekali (lihat actionKey).
const Patch = require('./patch.js');

const clone = function (o) { return JSON.parse(JSON.stringify(o)); };
const syncWorkloads = function (a) { return a.workloads.filter(function (w) { return !w.async; }); };
const nodeOf = function (a, id) { return a.nodes.find(function (n) { return n.id === id; }); };
const isDbRead = function (a, c) { const n = nodeOf(a, c.node); return !!n && n.type === 'db' && c.read > 0 && !c.write; };
const hasWrite = function (w) { return (w.calls || []).some(function (c) { return c.write; }); };
const holdMs = function (w) { return (w.cpuMs || 0) + (w.calls || []).reduce(function (s, c) { return s + (c.read || c.ms || 0) * (1 - (c.skipProb || 0)); }, 0); };
const label = function (n) { return n.label || n.id; };
const num = function (key, lab, min, max, step, def, unit) { return { key: key, label: lab, type: 'number', min: min, max: max, step: step, default: def, unit: unit || '' }; };
const select = function (key, lab, options, def) { return { key: key, label: lab, type: 'select', options: options, default: def }; };
const bool = function (key, lab, def) { return { key: key, label: lab, type: 'bool', default: def }; };

function poolsOfSync(a) { const ids = {}; syncWorkloads(a).forEach(function (w) { if (w.pool) ids[w.pool] = 1; }); return a.nodes.filter(function (n) { return n.type === 'pool' && ids[n.id]; }); }
function dbsWithReads(a) { const ids = {}; a.workloads.forEach(function (w) { (w.calls || []).forEach(function (c) { if (isDbRead(a, c)) ids[c.node] = 1; }); }); return a.nodes.filter(function (n) { return ids[n.id]; }); }
const opts = function (nodes) { return nodes.map(function (n) { return { value: n.id, label: label(n) }; }); };

// Urutan rantai di depan pool: CDN -> load balancer -> proxy lain. Hanya node bertipe proxy yang diurutkan ulang (posisi node lain tetap).
function normalizeFront(a) {
  const rank = function (n) { return n.id === 'x-cdn' ? 0 : n.id === 'x-filter' ? 1 : n.id === 'x-lb' ? 2 : 3; };
  const slots = [], px = [];
  a.nodes.forEach(function (n, i) { if (n.type === 'proxy') { slots.push(i); px.push(n); } });
  px.map(function (n, i) { return { n: n, i: i }; }).sort(function (x, y) { return rank(x.n) - rank(y.n) || x.i - y.i; }).forEach(function (x, k) { a.nodes[slots[k]] = x.n; });
}

const COMPONENTS = {
  redis: {
    label: 'Cache Redis', icon: 'cache',
    summary: 'Hasil query baca disimpan di Redis. Yang kena (cache hit) tidak menyentuh database.',
    assumptions: 'Hit ratio ditetapkan di sini, tidak dihitung dari pola data Anda. Tulis tetap ke database. Invalidasi cache dan data kedaluwarsa tidak dimodelkan.',
    describe: function (a) {
      const reads = []; a.workloads.forEach(function (w) { (w.calls || []).forEach(function (c) { if (isDbRead(a, c)) reads.push(c); }); });
      if (!reads.length) return { available: false, reason: 'Tidak ada query baca ke database yang bisa di-cache.', params: [] };
      return { available: true, params: [num('hit', 'Hit ratio', 50, 99, 1, 85, '%'), num('ms', 'Waktu akses cache', 0.2, 5, 0.1, 1, 'ms')] };
    },
    apply: function (a, p) {
      const out = clone(a); let cache = out.nodes.find(function (n) { return n.type === 'cache'; });
      if (!cache) { cache = { id: 'x-redis', type: 'cache', label: 'Redis (cache)' }; const at = out.nodes.findIndex(function (n) { return n.type === 'db'; }); out.nodes.splice(at < 0 ? out.nodes.length : at, 0, cache); }
      const hit = p.hit / 100;
      out.workloads.forEach(function (w) {
        const list = [];
        (w.calls || []).forEach(function (c) {
          if (isDbRead(out, c)) {
            const prev = list[list.length - 1];
            if (prev && prev.node === cache.id) prev.ms = p.ms; else list.push({ node: cache.id, ms: p.ms, tag: 'cache' });
            c.skipProb = 1 - (1 - (c.skipProb || 0)) * (1 - hit);
          }
          list.push(c);
        });
        w.calls = list;
      });
      return out;
    }
  },

  lb: {
    label: 'Load balancer + beberapa server', icon: 'lb',
    summary: 'Beberapa salinan server aplikasi di belakang load balancer: worker dan CPU bertambah, tetapi tiap request tetap memegang koneksi database.',
    assumptions: 'Pembagian beban tidak pernah sempurna (efisiensi). Batas koneksi database tidak ikut naik: bila terlalu rendah, database menjadi leher botol berikutnya.',
    describe: function (a) {
      const pools = poolsOfSync(a); if (!pools.length) return { available: false, reason: 'Tidak ada pool server yang melayani request.', params: [] };
      return { available: true, params: [num('instances', 'Jumlah server', 2, 10, 1, 2), num('efficiency', 'Efisiensi pembagian beban', 70, 100, 1, 92, '%'), num('ms', 'Tambahan latensi load balancer', 0, 5, 0.1, 0.5, 'ms'), num('detectS', 'Deteksi server mati (health check)', 1, 60, 1, 10, ' dtk'), select('pool', 'Server yang digandakan', [{ value: 'all', label: 'Semua pool' }].concat(opts(pools)), 'all')] };
    },
    apply: function (a, p) {
      const out = clone(a), factor = 1 + (p.instances - 1) * (p.efficiency / 100);
      const target = poolsOfSync(out).filter(function (n) { return p.pool === 'all' || n.id === p.pool; });
      target.forEach(function (n) { n.workers = Math.max(1, Math.round((n.workers || 1) * factor)); if (n.cores) n.cores = Math.max(1, Math.round(n.cores * factor)); n.instances = p.instances; n.detectS = p.detectS; });   // instances/detectS dipakai skenario kegagalan: 1 dari N server mati
      const ids = {}; target.forEach(function (n) { ids[n.id] = 1; });
      syncWorkloads(out).forEach(function (w) { if (ids[w.pool]) w.cpuMs = (w.cpuMs || 0) + p.ms; });
      out.nodes.unshift({ id: 'x-lb', type: 'proxy', label: 'Load balancer (' + p.instances + ' server)', instances: p.instances });
      normalizeFront(out);
      return out;
    }
  },

  filter: {
    label: 'Filter / WAF / rate limit', icon: 'filter',
    summary: 'Lapisan di depan yang membuang trafik jahat atau bot dan, bila diatur, membatasi laju request ke server. Mengurangi beban, tetapi menambah latensi.',
    assumptions: 'Persentase trafik yang dibuang adalah asumsi Anda, bukan hasil ukur. Request yang dibuang tidak dihitung sebagai error pengguna. Kapasitas filter itu sendiri tidak dimodelkan (anggap jauh di atas server aplikasi). Rate limit membuang kelebihan di atas batas, bukan menundanya. Tambahan latensi dihitung sebagai waktu tambahan per request.',
    describe: function (a) {
      if (!syncWorkloads(a).length) return { available: false, reason: 'Tidak ada request sinkron.', params: [] };
      return { available: true, params: [num('blockPct', 'Trafik jahat/bot yang dibuang', 0, 60, 1, 15, '%'), num('limitRps', 'Batas laju ke server (0 = tanpa batas)', 0, 5000, 50, 0, '/dtk'), num('ms', 'Tambahan latensi filter', 0, 20, 0.5, 1.5, 'ms')] };
    },
    apply: function (a, p) {
      const out = clone(a);
      syncWorkloads(out).forEach(function (w) { w.shed = Math.min(0.9, p.blockPct / 100); w.cpuMs = (w.cpuMs || 0) + p.ms; });
      out.nodes.unshift({ id: 'x-filter', type: 'proxy', label: 'Filter / WAF', limitRps: p.limitRps > 0 ? p.limitRps : 0 });
      normalizeFront(out);
      return out;
    }
  },

  replica: {
    label: 'Replika baca database', icon: 'replica',
    summary: 'Salinan database khusus baca. Sebagian query baca pindah ke replika; tulis tetap ke database utama.',
    assumptions: 'Mengandaikan aplikasi atau proxy database (mis. ProxySQL, pgpool-II) sudah bisa memisahkan baca dan tulis; bila aplikasi masih memakai satu koneksi, ini butuh perubahan kode atau proxy dulu. Replika punya disk sendiri. Replication lag tidak dimodelkan: replika dianggap selalu mutakhir, padahal data yang baru ditulis bisa belum terbaca.',
    describe: function (a) {
      const dbs = dbsWithReads(a); if (!dbs.length) return { available: false, reason: 'Tidak ada query baca ke database.', params: [] };
      return { available: true, params: [select('db', 'Database', opts(dbs), dbs[0].id), num('share', 'Porsi baca ke replika', 30, 95, 1, 80, '%')] };
    },
    apply: function (a, p) {
      const out = clone(a), primary = nodeOf(out, p.db), rid = 'x-replica-' + primary.id;
      const replica = Object.assign({}, clone(primary), { id: rid, label: label(primary) + ' (replika baca)' });
      const disk = primary.disk ? nodeOf(out, primary.disk) : null;
      if (disk) { replica.disk = 'x-replica-' + disk.id; out.nodes.splice(out.nodes.indexOf(disk) + 1, 0, Object.assign({}, clone(disk), { id: replica.disk, label: label(disk) + ' (replika)' })); }
      out.nodes.splice(out.nodes.indexOf(primary) + 1, 0, replica);
      out.workloads.forEach(function (w) { (w.calls || []).forEach(function (c) { if (c.node === primary.id && isDbRead(out, c)) c.route = [{ node: primary.id, w: 100 - p.share }, { node: rid, w: p.share }]; }); });
      return out;
    }
  },

  hadb: {
    label: 'Database HA (primary + standby + failover)', icon: 'ha',
    summary: 'Standby siap mengambil alih bila primary mati. Dipakai bersama skenario kegagalan: berapa lama layanan terganggu dan berapa data berisiko hilang.',
    assumptions: 'Waktu failover (deteksi + promosi + aplikasi menyambung ulang) adalah angka tipikal; ukur di server uji. Standby tidak melayani baca (itu fungsi replika). Setelah failover cache database dingin sehingga sementara 3x lebih lambat. Replikasi asinkron: transaksi terakhir sebesar lag bisa hilang; sinkron: tidak hilang tetapi setiap commit lebih lambat.',
    describe: function (a) {
      const dbs = a.nodes.filter(function (n) { return n.type === 'db' && !n.standbyOf && !n.id.startsWith('x-replica-') && !n.id.startsWith('x-db-'); });
      if (!dbs.length) return { available: false, reason: 'Tidak ada database.', params: [] };
      return { available: true, params: [select('db', 'Database', opts(dbs), dbs[0].id), num('failoverS', 'Waktu failover', 5, 120, 1, 30, ' dtk'), num('warmS', 'Lama lambat setelah failover (cache dingin)', 0, 180, 5, 30, ' dtk'), bool('sync', 'Replikasi sinkron (tanpa data hilang, commit lebih lambat)', false), num('lagMs', 'Lag replikasi asinkron', 0, 2000, 10, 100, ' ms')] };
    },
    apply: function (a, p) {
      const out = clone(a), db = nodeOf(out, p.db), sid = 'x-standby-' + db.id;
      db.ha = { failoverS: p.failoverS, warmS: p.warmS, sync: !!p.sync, lagMs: p.sync ? 0 : p.lagMs }; db.standby = sid;
      out.nodes.splice(out.nodes.indexOf(db) + 1, 0, { id: sid, type: 'db', label: label(db) + ' (standby)', connections: db.connections, standbyOf: db.id });
      if (p.sync) out.workloads.forEach(function (w) { (w.calls || []).forEach(function (c) { if (c.node === db.id && c.write) c.read = (c.read || 0) + 2; }); });   // commit menunggu standby: +2 ms
      return out;
    }
  },

  dbsplit: {
    label: 'Database terpisah untuk satu fitur', icon: 'dbsplit',
    summary: 'Satu fitur (mis. laporan) dipindah ke database sendiri dengan disk sendiri, jadi tidak lagi berebut koneksi, kunci, dan fsync dengan fitur lain.',
    assumptions: 'Data fitur itu dianggap bisa berdiri sendiri; sinkronisasi atau join lintas database tidak dimodelkan. Menambah satu database yang harus dikelola.',
    describe: function (a) {
      const wl = syncWorkloads(a).filter(function (w) { return (w.calls || []).some(function (c) { const n = nodeOf(a, c.node); return n && n.type === 'db'; }); });
      if (!wl.length) return { available: false, reason: 'Tidak ada request yang memakai database.', params: [] };
      const heavy = wl.slice().sort(function (x, y) { return holdMs(y) - holdMs(x); })[0];
      return { available: true, params: [select('workload', 'Fitur', wl.map(function (w) { return { value: w.id, label: w.label || w.id }; }), heavy.id)] };
    },
    apply: function (a, p) {
      const out = clone(a), w = out.workloads.find(function (x) { return x.id === p.workload; }), moved = {};
      (w.calls || []).forEach(function (c) {
        const src = nodeOf(out, c.node); if (!src || src.type !== 'db') return;
        const id = 'x-db-' + w.id + '-' + src.id;
        if (!moved[src.id]) {
          moved[src.id] = id;
          const disk = src.disk ? nodeOf(out, src.disk) : null, copy = Object.assign({}, clone(src), { id: id, label: label(src) + ' (khusus ' + (w.label || w.id) + ')' });
          delete copy.ha; delete copy.standby;
          if (disk) { copy.disk = 'x-disk-' + w.id + '-' + disk.id; out.nodes.splice(out.nodes.indexOf(disk) + 1, 0, Object.assign({}, clone(disk), { id: copy.disk, label: label(disk) + ' (khusus)' })); }
          out.nodes.splice(out.nodes.indexOf(src) + 1, 0, copy);
        }
        c.node = moved[src.id];
      });
      return out;
    }
  },

  queue: {
    label: 'Antrean + worker latar', icon: 'queue',
    summary: 'Pekerjaan berat dipindah ke antrean yang dikerjakan worker terpisah, jadi pengguna tidak menunggu dan pool web tidak tertahan.',
    assumptions: 'Pekerjaan itu tidak lagi dihitung sebagai request sinkron. Pantau backlog antrean: bila pekerjaan datang lebih cepat dari kapasitas worker, backlog terus tumbuh.',
    describe: function (a) {
      const sync = syncWorkloads(a).filter(function (w) { return w.pool; }); if (!sync.length) return { available: false, reason: 'Tidak ada request sinkron.', params: [] };
      const heavy = sync.slice().sort(function (x, y) { return holdMs(y) - holdMs(x); })[0];
      return { available: true, params: [select('workload', 'Pekerjaan', sync.map(function (w) { return { value: w.id, label: w.label || w.id }; }), heavy.id), num('workers', 'Jumlah worker', 1, 32, 1, 4)] };
    },
    apply: function (a, p) {
      const out = clone(a), w = out.workloads.find(function (x) { return x.id === p.workload; }), id = 'x-queue-' + w.id;
      out.nodes.splice(out.nodes.findIndex(function (n) { return n.id === w.pool; }) + 1, 0, { id: id, type: 'pool', label: 'Worker antrean: ' + (w.label || w.id), workers: p.workers });
      w.async = true; w.mixed = true; w.pool = id;   // mixed: tetap dipicu pengguna, jadi lajunya ikut skala beban
      return out;
    }
  },

  scaleup: {
    label: 'Server lebih besar (CPU/RAM/worker)', icon: 'scale',
    summary: 'Naikkan kapasitas satu server: lebih banyak worker dan core. Opsional naikkan batas koneksi database sebanding.',
    assumptions: 'Naik vertikal ada batasnya dan butuh RAM. Mengabaikan biaya.',
    describe: function (a) {
      const pools = poolsOfSync(a); if (!pools.length) return { available: false, reason: 'Tidak ada pool server.', params: [] };
      return { available: true, params: [select('pool', 'Server', opts(pools), pools[0].id), num('factor', 'Pengali kapasitas', 1.25, 8, 0.25, 2, 'x'), bool('connections', 'Naikkan batas koneksi database sebanding', true)] };
    },
    apply: function (a, p) {
      const out = clone(a), n = nodeOf(out, p.pool);
      n.workers = Math.max(1, Math.round((n.workers || 1) * p.factor)); if (n.cores) n.cores = Math.max(1, Math.round(n.cores * p.factor));
      if (p.connections) {
        const dbs = {}; out.workloads.forEach(function (w) { if (w.pool === n.id) (w.calls || []).forEach(function (c) { const d = nodeOf(out, c.node); if (d && d.type === 'db') dbs[d.id] = d; }); });
        Object.keys(dbs).forEach(function (id) { if (dbs[id].connections) dbs[id].connections = Math.round(dbs[id].connections * p.factor); });
      }
      return out;
    }
  },

  ssd: {
    label: 'Pindah ke SSD NVMe', icon: 'disk',
    summary: 'Disk yang menunggu fsync diganti SSD NVMe: commit selesai dalam ~1 ms dan bandwidth jauh lebih besar.',
    assumptions: 'Angka NVMe tipikal (fsync 1,2 ms, 1500 MB/s), bukan produk tertentu.',
    describe: function (a) {
      const disks = a.nodes.filter(function (n) { return n.type === 'disk' && ((n.fsyncMs || 8) > 1.5 || (n.amp || 1) > 1); });
      if (!disks.length) return { available: false, reason: 'Disk sudah secepat SSD NVMe.', params: [] };
      const slowest = disks.slice().sort(function (x, y) { return (y.fsyncMs || 8) - (x.fsyncMs || 8); })[0];
      return { available: true, params: [select('disk', 'Disk', opts(disks), slowest.id)] };
    },
    apply: function (a, p) {
      const out = clone(a), d = nodeOf(out, p.disk);
      d.fsyncMs = Math.min(d.fsyncMs || 8, 1.2); d.bwMBs = Math.max(d.bwMBs || 100, 1500); d.amp = 1; d.label = 'SSD NVMe (' + label(d) + ')';
      return out;
    }
  },

  cdn: {
    label: 'CDN / cache halaman', icon: 'cdn',
    summary: 'Sebagian lalu lintas baca dilayani di tepi dan tidak pernah sampai ke server Anda.',
    assumptions: 'Hanya untuk konten yang boleh di-cache. Porsi ditetapkan di sini; pembersihan cache tidak dimodelkan.',
    describe: function (a) {
      const reads = syncWorkloads(a).filter(function (w) { return !hasWrite(w); }); if (!reads.length) return { available: false, reason: 'Tidak ada request baca-saja.', params: [] };
      return { available: true, params: [select('workload', 'Lalu lintas', [{ value: '__read', label: 'Semua yang hanya membaca' }].concat(reads.map(function (w) { return { value: w.id, label: w.label || w.id }; })), '__read'), num('share', 'Porsi dilayani CDN', 20, 95, 1, 60, '%')] };
    },
    apply: function (a, p) {
      const out = clone(a);
      syncWorkloads(out).forEach(function (w) { if (!hasWrite(w) && (p.workload === '__read' || w.id === p.workload)) w.cdn = p.share / 100; });
      out.nodes.unshift({ id: 'x-cdn', type: 'proxy', label: 'CDN / cache halaman' });
      normalizeFront(out);
      return out;
    }
  }
};

// Kunci unik satu aksi: komponen yang sama dengan target yang sama menggantikan, bukan menumpuk.
const TARGET = { replica: 'db', hadb: 'db', dbsplit: 'workload', queue: 'workload', scaleup: 'pool', ssd: 'disk' };
function actionKey(component, params) { return TARGET[component] ? component + ':' + params[TARGET[component]] : component; }

function normalizeParams(def, raw) {
  const out = {}; raw = raw || {};
  def.params.forEach(function (d) {
    let v = raw[d.key];
    if (d.type === 'number') { v = Number(v); if (!isFinite(v)) v = d.default; v = Math.min(d.max, Math.max(d.min, v)); }
    else if (d.type === 'select') { if (!d.options.some(function (o) { return o.value === v; })) v = d.default; }
    else v = v == null ? d.default : !!v;
    out[d.key] = v;
  });
  return out;
}

/** Katalog untuk satu arsitektur (dikirim ke UI). */
function catalog(arch) {
  return Object.keys(COMPONENTS).map(function (id) {
    const c = COMPONENTS[id], d = c.describe(arch);
    return { id: id, label: c.label, icon: c.icon, summary: c.summary, assumptions: c.assumptions, available: d.available, reason: d.reason || null, params: d.params };
  });
}

/** Terapkan daftar aksi ke arsitektur dasar: {kind:'rec', id} (patch dari rekomendasi) atau {kind:'component', component, params}. */
function compile(base, actions, recs) {
  let a = clone(base); const applied = [], skipped = [];
  (actions || []).filter(function (x) { return x.kind === 'rec'; }).forEach(function (x) {
    const r = (recs || []).find(function (y) { return y.id === x.id; });
    if (!r) { skipped.push({ action: x, reason: 'Rekomendasi tidak ditemukan.' }); return; }
    a = Patch.apply(a, r.patch); applied.push({ kind: 'rec', id: r.id, title: r.title });
  });
  const seen = {};
  (actions || []).filter(function (x) { return x.kind === 'component'; }).forEach(function (x) {
    const c = COMPONENTS[x.component]; if (!c) { skipped.push({ action: x, reason: 'Komponen tidak dikenal.' }); return; }
    const d = c.describe(a);
    if (!d.available) { skipped.push({ action: x, reason: d.reason }); return; }
    const params = normalizeParams(d, x.params), key = actionKey(x.component, params);
    if (seen[key]) { skipped.push({ action: x, reason: 'Sudah ada komponen yang sama dengan target yang sama.' }); return; }
    seen[key] = 1; a = c.apply(a, params); applied.push({ kind: 'component', component: x.component, params: params, key: key });
  });
  return { arch: a, applied: applied, skipped: skipped };
}

module.exports = { catalog: catalog, compile: compile, actionKey: actionKey, COMPONENTS: COMPONENTS };
