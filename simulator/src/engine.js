// Mesin simulasi generik. Membaca arsitektur (JSON) dan mensimulasikan aliran request.
//
// Tipe node : client, proxy, pool, cache, db, disk, external
// Workload  : {id,label,client,pool,rate,cpuMs,calls:[...],async?}
// Panggilan : {node, ms | read, write, writeProb, hot, kb, skipProb, tag, route:[{node,w}]}   route = pilih node tujuan acak berbobot (baca ke primary atau replika)
// Kegagalan (faults): stall (disk berhenti), slow (x mult), down (node mati: koneksi ditolak; cache mati = miss), capacity (1 dari N server mati: keep, blackhole, detectS). Dengan 'at' + 'len' = kejadian satu kali, tanpa 'at' = berulang tiap 'every'.
// Node proxy: boleh lebih dari satu; urutan di arsitektur = urutan rantai di depan pool (CDN -> load balancer -> reverse proxy). Workload: cdn = porsi yang dilayani CDN.
//
// Aturan:
//  - request sinkron memegang satu worker pool sampai selesai (seperti PHP-FPM)
//  - panggilan ke db butuh koneksi (dipegang sampai request selesai) dan, bila menulis,
//    commit yang menunggu fsync di disk milik db itu (kecuali flush = 2)
//  - disk dipakai bersama semua db yang menempel padanya; beban tulis latar memperlambat fsync
//  - gangguan (faults): 'stall' menghentikan disk, 'slow' mengalikan waktu layan node
//  - pool.cores: CPU dibagi rata (processor sharing) bila request yang sedang memakai CPU melebihi jumlah core
//  - db.onFull = 'wait': pool koneksi klien (Hikari, SQLAlchemy, dst.) membuat request menunggu, bukan ditolak; db.waitTimeoutS
//  - workload async dengan 'pool': konsumen antrean (Celery, Sidekiq, Bull) dengan concurrency terbatas dan backlog
//  - panggilan: timeoutMs membatasi lama menunggu layanan eksternal/db
const Sim = (function () {
  const DT = 0.02;

  function edges(arch) {
    const set = {}, out = [];
    const proxies = arch.nodes.filter(function (n) { return n.type === 'proxy'; });
    const byId = {}; arch.nodes.forEach(function (n) { byId[n.id] = n; });
    function add(a, b) { if (!a || !b || a === b) return; const k = a + '>' + b; if (!set[k]) { set[k] = 1; out.push([a, b]); } }
    function addDisk(id) { const n = byId[id]; if (n && n.type === 'db' && n.disk) add(id, n.disk); }
    function link(from, c) { (c.route && c.route.length ? c.route.map(function (x) { return x.node; }) : [c.node]).forEach(function (id) { add(from, id); addDisk(id); }); }
    arch.workloads.forEach(function (w) {
      if (w.async && !w.pool) { (w.calls || []).forEach(function (c) { link(w.client, c); }); return; }
      if (w.async && w.pool) { add(w.client, w.pool); (w.calls || []).forEach(function (c) { link(w.pool, c); }); return; }
      if (proxies.length) { add(w.client, proxies[0].id); for (let i = 1; i < proxies.length; i++) add(proxies[i - 1].id, proxies[i].id); add(proxies[proxies.length - 1].id, w.pool); } else add(w.client, w.pool);
      (w.calls || []).forEach(function (c) { link(w.pool, c); });
    });
    arch.nodes.forEach(function (n) { if (n.standby) add(n.id, n.standby); });   // database -> standby (replikasi)
    return out;
  }

  function create(arch, opt) {
    opt = opt || {};
    const N = {};
    arch.nodes.forEach(function (n) { N[n.id] = Object.assign({}, n); });
    const origKeys = {}; arch.nodes.forEach(function (n) { origKeys[n.id] = Object.keys(n); });
    const faults = JSON.parse(JSON.stringify(opt.faults || arch.faults || []));
    const rates = {}; const WL = {};
    arch.workloads.forEach(function (w) { WL[w.id] = w; rates[w.id] = (opt.rates && opt.rates[w.id] != null) ? opt.rates[w.id] : w.rate; });
    const proxies = arch.nodes.filter(function (n) { return n.type === 'proxy'; });
    const proxy = proxies[0], lastProxy = proxies[proxies.length - 1];
    const steps = {};
    arch.workloads.forEach(function (w) {
      const s = [];
      if (!w.async || w.pool) s.push({ k: 'cpu', ms: w.cpuMs || 0 });
      (w.calls || []).forEach(function (c) { s.push(Object.assign({ k: 'call' }, c)); });
      steps[w.id] = s;
    });
    const S = { t: 0, id: 0, buckets: {}, series: { p95: [], ok: [], e504: [] }, lastSec: 0, async: [], hooks: opt.hooks || {} };
    Object.keys(N).forEach(function (id) {
      const n = N[id];
      if (n.type === 'pool') { n.q = []; n.h = 0; n.run = []; }
      if (n.type === 'db') { const k = Math.max(1, n.hotKeys || 1); n.conn = 0; n.lockHolder = new Array(k).fill(null); n.lockWait = new Array(k).fill(null); }
      if (n.type === 'disk') { n.q = []; n.busy = false; n.batch = []; n.rem = 0; }
    });

    function emit(a, b, wid) { if (S.hooks.move && a && b) S.hooks.move(a, b, wid); }
    function timeout() { let m = 0; proxies.forEach(function (p) { const s = N[p.id].timeoutS; if (s && (!m || s < m)) m = s; }); return m || 60; }

    // ---- gangguan
    function active(f) {
      if (f.at != null) return S.t >= f.at && S.t < f.at + (f.len == null ? 1e9 : f.len);   // kejadian satu kali: mulai di detik 'at' selama 'len'
      if (!f.every || f.every <= 0) return false;
      const len = Math.min(f.len, f.every - 5); if (len <= 0) return false;
      return (S.t % f.every) >= (f.every - len);
    }
    function slow(id) { for (let i = 0; i < faults.length; i++) { const f = faults[i]; if (f.node === id && f.type === 'slow' && active(f)) return f.mult || 10; } return 1; }
    function isDown(id) { for (let i = 0; i < faults.length; i++) { const f = faults[i]; if (f.node === id && f.type === 'down' && active(f)) return true; } return false; }
    // capacity: satu dari N server mati di belakang load balancer: kapasitas turun (keep) dan sebagian request masuk ke server mati sampai health check mendeteksinya (detectS)
    function capFault(id) { for (let i = 0; i < faults.length; i++) { const f = faults[i]; if (f.node === id && f.type === 'capacity' && active(f)) return f; } return null; }
    function workersOf(p) { const cf = capFault(p.id); return Math.max(1, Math.round((p.workers || 1) * (cf ? cf.keep : 1))); }
    function blackholed(p) { const cf = capFault(p.id); return !!(cf && cf.blackhole && S.t < cf.at + (cf.detectS || 0) && Math.random() < cf.blackhole); }
    function stalled(id) { for (let i = 0; i < faults.length; i++) { const f = faults[i]; if (f.node === id && f.type === 'stall' && active(f)) return true; } return false; }

    // ---- statistik
    function bucket(sec) { let b = S.buckets[sec]; if (!b) b = S.buckets[sec] = { ok: 0, e504: 0, eConn: 0, lats: [], time: {}, n: 0, w: {}, disk: {} }; return b; }
    function wb(b, id) { return b.w[id] || (b.w[id] = { ok: 0, e504: 0, eConn: 0, lats: [] }); }
    function dsk(b, id) { return b.disk[id] || (b.disk[id] = { busy: 0, stall: 0, kb: 0 }); }
    function record(r, kind) {
      const b = bucket(Math.floor(S.t)), w = wb(b, r.w.id);
      if (kind === 'ok') { b.ok++; w.ok++; if (b.lats.length < 3000) b.lats.push(S.t - r.t0); if (w.lats.length < 1500) w.lats.push(S.t - r.t0); }
      else if (kind === '504') { b.e504++; w.e504++; } else { b.eConn++; w.eConn++; }
      for (const k in r.time) b.time[k] = (b.time[k] || 0) + r.time[k];
      b.n++;
    }
    function pct(arr, p) { if (!arr.length) return 0; const a = arr.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
    function agg(sec) {
      const cur = Math.floor(S.t);
      const o = { ok: 0, e504: 0, eConn: 0, lats: [], time: {}, n: 0, w: {}, disk: {} };
      for (let s = cur - sec + 1; s <= cur; s++) {
        const b = S.buckets[s]; if (!b) continue;
        o.ok += b.ok; o.e504 += b.e504; o.eConn += b.eConn; o.n += b.n;
        for (let i = 0; i < b.lats.length; i++) o.lats.push(b.lats[i]);
        for (const k in b.time) o.time[k] = (o.time[k] || 0) + b.time[k];
        for (const id in b.w) { const x = o.w[id] || (o.w[id] = { ok: 0, e504: 0, eConn: 0, lats: [] }), y = b.w[id]; x.ok += y.ok; x.e504 += y.e504; x.eConn += y.eConn; for (let i = 0; i < y.lats.length; i++) x.lats.push(y.lats[i]); }
        for (const id in b.disk) { const x = o.disk[id] || (o.disk[id] = { busy: 0, stall: 0, kb: 0 }), y = b.disk[id]; x.busy += y.busy; x.stall += y.stall; x.kb += y.kb; }
      }
      return o;
    }

    // ---- disk
    function addWrite(d, kb) { dsk(bucket(Math.floor(S.t)), d.id).kb += kb * (d.amp || 1); }
    function bgUtil(d) {
      let kb = 0; const cur = Math.floor(S.t), win = Math.min(5, Math.max(1, S.t));
      for (let s = cur - 4; s <= cur; s++) { const b = S.buckets[s]; if (b && b.disk[d.id]) kb += b.disk[d.id].kb; }
      return Math.min(0.92, (kb / win) / ((d.bwMBs || 100) * 1024));
    }
    function svc(d) {
      if (d.slog) return d.slogMs || 1.5;
      return (d.fsyncMs || 8) * (1 / (1 - bgUtil(d))) * slow(d.id);
    }
    function diskStep(d) {
      const b = dsk(bucket(Math.floor(S.t)), d.id), st = !d.slog && stalled(d.id);
      function startBatch() {
        while (d.q.length && d.q[0].r.dead) d.q.shift();
        if (!d.q.length) return false;
        const db = d.q[0].db;
        if (db.group !== false) { const take = [], rest = []; d.q.forEach(function (e) { (e.db === db ? take : rest).push(e); }); d.q = rest; d.batch = take; }
        else d.batch = [d.q.shift()];
        d.rem = svc(d) * (0.8 + 0.4 * Math.random()); d.busy = true; return true;
      }
      if (st) {
        if (!d.busy) startBatch();
        b.stall += DT; if (d.busy || d.q.length) b.busy += DT;
        return;
      }
      let tb = DT * 1000, used = 0;
      while (tb > 1e-9) {
        if (!d.busy && !startBatch()) break;
        const use = Math.min(tb, d.rem); d.rem -= use; tb -= use; used += use;
        if (d.rem <= 1e-9) { const bt = d.batch; d.batch = []; d.busy = false; bt.forEach(function (e) { if (!e.r.dead) afterCommit(e.r); }); }
      }
      b.busy += used / 1000;
    }

    // ---- request
    function mk(w) { return { id: ++S.id, w: w, t0: S.t, st: 'queue', key: 'queue', ts: S.t, time: {}, si: -1, rem: 0, b: 0, dead: false, hasLock: null, conns: [], after: null, pending: null, pool: w.pool ? N[w.pool] : null }; }
    function accWait(r) { r.time[r.key] = (r.time[r.key] || 0) + (S.t - r.ts); r.ts = S.t; }
    function startTimed(r, key, ms) { r.st = 'timed'; r.key = key; r.rem = Math.max(0, ms) * (0.8 + 0.4 * Math.random()); }
    function onTimedDone(r) { const f = r.after; r.after = null; if (f) f(); else nextStep(r); }
    function run(r) {
      while (!r.dead && r.st === 'timed') {
        if (r.rem > 1e-9) {
          const sc = (r.key === 'cpu' && r.pool && r.pool.cpuScale) ? r.pool.cpuScale : 1;
          const prog = Math.min(r.b * sc, r.rem); r.rem -= prog; const wall = prog / sc; r.b -= wall; r.time[r.key] = (r.time[r.key] || 0) + wall / 1000;
          if (r.rem > 1e-9) return;
        }
        onTimedDone(r);
      }
    }
    function nextStep(r) {
      while (!r.dead) {
        r.si++;
        const s = steps[r.w.id][r.si];
        if (!s) { finish(r, 'ok'); return; }
        if (s.k === 'cpu') { startTimed(r, 'cpu', s.ms); return; }
        if (s.skipProb && !r.cacheDown && Math.random() < s.skipProb) continue;
        const n = N[pickNode(s)]; if (!n) continue;
        if (isDown(n.id)) { if (n.type === 'cache') { r.cacheDown = true; continue; } finish(r, 'conn'); return; }   // cache mati: anggap miss, baca ke database; yang lain: koneksi ditolak
        emit(r.w.pool || r.w.client, n.id, r.w.id);
        if (n.type === 'db') {
          if (!r.w.async && r.conns.indexOf(n.id) < 0) {
            if (n.conn >= (n.connections || 151)) {
              if (n.onFull === 'wait') { r.st = 'connwait'; r.key = 'connwait:' + n.id; r.ts = S.t; r.pending = { n: n, s: s }; (n.connQ || (n.connQ = [])).push(r); return; }
              finish(r, 'conn'); return;
            }
            n.conn++; r.conns.push(n.id);
          }
          beginDb(r, n, s);
          return;
        }
        startTimed(r, 'call:' + n.id, cap((s.ms || 0) * slow(n.id), s));
        return;
      }
    }
    function pickNode(s) {
      if (!s.route || !s.route.length) return s.node;
      let tot = 0; s.route.forEach(function (x) { tot += x.w; });
      let u = Math.random() * tot; for (let i = 0; i < s.route.length; i++) { u -= s.route[i].w; if (u <= 0) return s.route[i].node; }
      return s.route[s.route.length - 1].node;
    }
    function cap(ms, s) { return s.timeoutMs ? Math.min(ms, s.timeoutMs) : ms; }
    function beginDb(r, n, s) { startTimed(r, 'call:' + n.id, cap((s.read || 0) * slow(n.id), s)); r.after = function () { dbWrite(r, n, s); }; }
    function admitConn(n) {
      while (n.connQ && n.connQ.length && n.conn < (n.connections || 151)) {
        const x = n.connQ.shift(); if (x.dead) continue;
        accWait(x); n.conn++; x.conns.push(n.id); const p = x.pending; x.pending = null; beginDb(x, n, p.s);
      }
    }
    function dbWrite(r, n, s) {
      const wp = s.write ? (s.writeProb == null ? 1 : s.writeProb) : 0;
      if (!(wp > 0 && Math.random() < wp)) { nextStep(r); return; }
      const kb = s.kb || 16;
      if (s.hot && n.hotKeys) {
        const k = (Math.random() * n.hotKeys) | 0;
        if (n.lockHolder[k] === null) { n.lockHolder[k] = r; r.hasLock = { db: n, k: k }; commit(r, n, kb); }
        else { r.st = 'lock'; r.key = 'lock:' + n.id; r.ts = S.t; r.pending = { n: n, kb: kb, k: k }; (n.lockWait[k] || (n.lockWait[k] = [])).push(r); }
        return;
      }
      commit(r, n, kb);
    }
    function commit(r, n, kb) {
      const d = N[n.disk];
      if (d) addWrite(d, kb);
      if (!d || n.flush === 2) { releaseLock(r); nextStep(r); return; }
      r.st = 'commit'; r.key = 'commit:' + d.id; r.ts = S.t;
      emit(n.id, d.id, r.w.id);
      d.q.push({ r: r, db: n });
    }
    function afterCommit(r) { accWait(r); releaseLock(r); nextStep(r); }
    function releaseLock(r) {
      const h = r.hasLock; if (!h) return;
      r.hasLock = null; h.db.lockHolder[h.k] = null;
      const w = h.db.lockWait[h.k];
      while (w && w.length) {
        const x = w.shift(); if (x.dead) continue;
        accWait(x); h.db.lockHolder[h.k] = x; x.hasLock = { db: h.db, k: h.k };
        commit(x, h.db, x.pending.kb); break;
      }
    }
    function finish(r, kind) {
      if (r.dead) return;
      if (r.st === 'queue' || r.st === 'lock' || r.st === 'commit' || r.st === 'connwait') accWait(r);
      r.dead = true;
      if (r.pool) { const i = r.pool.run.indexOf(r); if (i >= 0) r.pool.run.splice(i, 1); }
      else { const i = S.async.indexOf(r); if (i >= 0) S.async.splice(i, 1); }
      if (r.st === 'commit') { const d = N[r.key.slice(7)]; if (d) { const j = d.q.findIndex(function (e) { return e.r === r; }); if (j >= 0) d.q.splice(j, 1); } }
      if (r.st === 'lock' && r.pending) { const w = r.pending.n.lockWait[r.pending.k]; if (w) { const j = w.indexOf(r); if (j >= 0) w.splice(j, 1); } }
      if (r.st === 'connwait' && r.pending) { const q = r.pending.n.connQ; if (q) { const j = q.indexOf(r); if (j >= 0) q.splice(j, 1); } }
      releaseLock(r);
      r.conns.forEach(function (id) { N[id].conn--; admitConn(N[id]); });
      record(r, kind);
    }
    function poisson(l) { if (l <= 0) return 0; const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L && k < 2000); return k - 1; }
    function tryStart(p) {
      while (p.q.length - p.h > 0 && p.run.length < workersOf(p)) {
        const r = p.q[p.h++]; if (r.dead) continue;
        accWait(r); r.b = 0; p.run.push(r);
        if (!r.w.async) emit(lastProxy && lastProxy.id, p.id, r.w.id);
        nextStep(r);
      }
      if (p.h > 2000) { p.q = p.q.slice(p.h); p.h = 0; }
    }

    function step() {
      const T = timeout();
      faults.forEach(function (f) {
        if (f.type !== 'capacity') return;
        const on = active(f);
        if (on && !f._on) { f._on = true; const p = N[f.node]; if (p && p.run) p.run.slice().forEach(function (r) { if (Math.random() < (f.blackhole || 0)) finish(r, 'conn'); }); }   // request yang sedang berjalan di server yang mati ikut gagal
        else if (!on) f._on = false;
      });
      Object.keys(N).forEach(function (id) {
        const p = N[id]; if (p.type !== 'pool' || !isDown(id)) return;   // pool mati total: semua yang berjalan dan mengantre gagal
        p.run.slice().forEach(function (r) { finish(r, 'conn'); });
        while (p.h < p.q.length) { const r = p.q[p.h++]; if (!r.dead) finish(r, 'conn'); }
      });
      arch.workloads.forEach(function (w) {
        const n = poisson((rates[w.id] || 0) * DT);
        for (let i = 0; i < n; i++) {
          const r = mk(w);
          if (w.async && !w.pool) { r.st = 'timed'; r.b = 0; S.async.push(r); nextStep(r); }
          else {
            emit(w.client, w.async ? w.pool : (proxy ? proxy.id : w.pool), w.id);
            if (isDown(r.pool.id) || blackholed(r.pool)) { finish(r, 'conn'); continue; }
            r.pool.q.push(r);
          }
        }
      });
      Object.keys(N).forEach(function (id) {
        const p = N[id]; if (p.type !== 'pool') return;
        let nc = 0; p.run.forEach(function (r) { if (r.st === 'timed' && r.key === 'cpu') nc++; });
        p.cpuN = nc; p.cpuScale = (p.cores > 0 && nc > p.cores) ? p.cores / nc : 1;
        p.run.slice().forEach(function (r) {
          if (r.dead) return;
          if (!r.w.async && S.t - r.t0 > T) { finish(r, '504'); return; }
          if (r.st === 'connwait' && S.t - r.ts > ((r.pending && r.pending.n.waitTimeoutS) || 30)) { finish(r, 'conn'); return; }
          r.b = DT * 1000; run(r);
        });
        while (p.h < p.q.length) {
          const r = p.q[p.h];
          if (r.dead) { p.h++; continue; }
          if (!r.w.async && S.t - r.t0 > T) { p.h++; finish(r, '504'); } else break;
        }
      });
      S.async.slice().forEach(function (r) { if (!r.dead) { r.b = DT * 1000; run(r); } });
      Object.keys(N).forEach(function (id) { if (N[id].type === 'disk') diskStep(N[id]); });
      Object.keys(N).forEach(function (id) { if (N[id].type === 'pool') tryStart(N[id]); });
      S.t += DT;
      const cur = Math.floor(S.t);
      while (S.lastSec < cur) {
        const b = bucket(S.lastSec);
        S.series.p95.push(b.lats.length ? pct(b.lats, 0.95) : null); S.series.ok.push(b.ok); S.series.e504.push(b.e504);
        for (const k in S.series) if (S.series[k].length > 180) S.series[k].shift();
        delete S.buckets[S.lastSec - 20]; S.lastSec++;
      }
    }

    // ---- potret keadaan (untuk gambar dan diagnosis)
    function catOf(key) {
      if (key === 'cpu') return 'cpu';
      if (key.indexOf('lock:') === 0) return 'lock';
      if (key.indexOf('commit:') === 0) return 'commit';
      if (key.indexOf('connwait:') === 0) return 'connwait';
      if (key.indexOf('call:') === 0) { const n = N[key.slice(5)]; return n ? (n.type === 'db' ? 'db' : n.type === 'external' ? 'ext' : 'cache') : 'cpu'; }
      return 'cpu';
    }
    function snapshot() {
      const o = { pools: {}, dbs: {}, disks: {}, nodes: {} };
      const a10 = agg(10), win = Math.max(1, Math.min(10, S.t));
      Object.keys(N).forEach(function (id) {
        const n = N[id];
        if (n.type === 'pool') {
          const by = { cpu: 0, db: 0, ext: 0, cache: 0, lock: 0, commit: 0, connwait: 0 }, keys = {}, byW = {};
          n.run.forEach(function (r) { by[catOf(r.key)]++; keys[r.key] = (keys[r.key] || 0) + 1; byW[r.w.id] = (byW[r.w.id] || 0) + 1; });
          o.pools[id] = { busy: n.run.length, cap: n.workers || 1, q: n.q.length - n.h, by: by, keys: keys, byW: byW, cpuN: n.cpuN || 0, cores: n.cores || 0 };
        } else if (n.type === 'db') {
          let lockN = 0; n.lockWait.forEach(function (w) { if (w) lockN += w.length; });
          const d = N[n.disk]; let cq = 0; if (d) d.q.forEach(function (e) { if (e.db === n) cq++; });
          o.dbs[id] = { conn: n.conn, connections: n.connections || 151, lockN: lockN, commitN: cq, connWait: (n.connQ || []).length };
        } else if (n.type === 'disk') {
          const u = a10.disk[id] ? Math.min(1, a10.disk[id].busy / win) : 0;
          o.disks[id] = { q: n.q.length, busy: n.busy, stalled: !n.slog && stalled(id), util: u, bg: bgUtil(n), svc: svc(n) };
        }
      });
      let stuck = 0; const stuckByW = {};
      Object.keys(N).forEach(function (id) {
        const n = N[id]; if (n.type !== 'pool') return;
        n.run.forEach(function (r) { if (S.t - r.t0 > 2) { stuck++; stuckByW[r.w.id] = (stuckByW[r.w.id] || 0) + 1; } });
        for (let i = n.h; i < n.q.length; i++) { const r = n.q[i]; if (r.dead) continue; if (S.t - r.t0 > 2) { stuck++; stuckByW[r.w.id] = (stuckByW[r.w.id] || 0) + 1; } else break; }
      });
      o.stuck = stuck; o.stuckByW = stuckByW;
      o.rate = { ok: a10.ok / win, e504: a10.e504 / win, eConn: a10.eConn / win, p95: pct(a10.lats, 0.95) };
      o.agg = a10; o.win = win;
      return o;
    }
    function label(id) { return N[id] ? (N[id].label || id) : id; }
    function limited(sn, worst, res) {
      const ids = Object.keys(sn.pools); if (ids.length < 2) return res;
      const healthy = ids.filter(function (id) { return id !== worst; }).every(function (id) { const q = sn.pools[id]; return q.busy < q.cap && q.q === 0; });
      const sync = arch.workloads.filter(function (w) { return !w.async; });
      const tot = sync.reduce(function (a, w) { return a + (rates[w.id] || 0); }, 0) || 1;
      const mine = sync.filter(function (w) { return w.pool === worst; });
      const share = mine.reduce(function (a, w) { return a + (rates[w.id] || 0); }, 0) / tot;
      if (!healthy || share >= 0.25) return res;
      res.lv = 1; res.title = res.title.replace('Bottleneck:', 'Bottleneck terbatas:');
      res.text = 'Hanya memengaruhi: ' + mine.map(function (w) { return w.label; }).join(', ') + '. Pool lain sehat, jadi pengguna lain tidak terdampak. ' + res.text;
      return res;
    }
    function diagnose() {
      const sn = snapshot();
      if (sn.agg.eConn > 0) { const db = Object.keys(sn.dbs).sort(function (a, b) { return sn.dbs[b].conn - sn.dbs[a].conn; })[0]; return { node: db, lv: 2, title: 'Bottleneck: koneksi ' + label(db) + ' habis', text: 'Jumlah koneksi melewati batas, jadi request baru ditolak. Naikkan batas koneksi atau kurangi jumlah worker.' }; }
      let worst = null, ws = 0;
      Object.keys(sn.pools).forEach(function (id) { const p = sn.pools[id]; const sat = p.busy >= p.cap || p.q > 0; if (sat) { const sc = p.q + p.busy; if (sc >= ws) { ws = sc; worst = id; } } });
      if (worst) {
        const p = sn.pools[worst], busy = Math.max(1, p.busy);
        const poolUsers = arch.workloads.filter(function (w) { return w.pool === worst; });
        if (poolUsers.length && poolUsers.every(function (w) { return w.async; })) {
          return { node: worst, lv: 2, title: 'Bottleneck: antrean menumpuk di ' + label(worst), text: 'Pekerjaan datang lebih cepat daripada diproses (' + p.q + ' menunggu). Tambah concurrency konsumen atau percepat pekerjaannya; backlog yang terus tumbuh akhirnya menunda semua pekerjaan latar.' };
        }
        const users = arch.workloads.filter(function (w) { return !w.async && w.pool === worst; });
        const tot = users.reduce(function (s, w) { return s + (rates[w.id] || 0); }, 0) || 1;
        for (const wid in p.byW) {
          const share = p.byW[wid] / busy, arr = (rates[wid] || 0) / tot;
          if (share >= 0.5 && arr < 0.25 && users.length > 1) return limited(sn, worst, { node: worst, lv: 2, title: 'Bottleneck: "' + (WL[wid].label || wid) + '" menghabiskan ' + label(worst), text: 'Request yang jarang tapi lama memegang separuh lebih worker, jadi request lain mengantre. Pisahkan pool untuk jenis request ini.' });
        }
        let top = null, tc = 0;
        for (const k in p.keys) if (p.keys[k] > tc) { tc = p.keys[k]; top = k; }
        if (top && tc / busy > 0.3 && top !== 'cpu') {
          const cat = catOf(top);
          if (cat === 'commit') return limited(sn, worst, { node: top.slice(7), lv: 2, title: 'Bottleneck: ' + label(top.slice(7)) + ' (fsync) menahan commit', text: 'Worker tertahan menunggu commit selesai, dan commit menunggu fsync. Menambah worker tidak membantu. Percepat penyimpanan (SSD/NVMe atau perangkat log khusus), atau kurangi fsync per commit (dengan risiko).' });
          if (cat === 'lock') return limited(sn, worst, { node: top.slice(5), lv: 2, title: 'Bottleneck: kunci baris di ' + label(top.slice(5)), text: 'Banyak worker menunggu baris yang sama. Kurangi penulisan ke baris panas itu, atau pastikan commit tidak lambat.' });
          if (cat === 'connwait') return limited(sn, worst, { node: top.slice(9), lv: 2, title: 'Bottleneck: pool koneksi ' + label(top.slice(9)) + ' (worker menunggu koneksi)', text: 'Pool koneksi database terlalu kecil dibanding jumlah worker, jadi worker mengantre menunggu koneksi. Naikkan ukuran pool koneksi (pastikan batas koneksi server cukup) atau percepat query.' });
          const nid = top.slice(5);
          return limited(sn, worst, { node: nid, lv: 2, title: 'Bottleneck: worker tertahan menunggu ' + label(nid), text: 'Mayoritas worker sedang menunggu ' + label(nid) + '. Percepat bagian itu (cache, indeks, timeout) sebelum menambah worker.' });
        }
        if (p.cores && p.cpuN > p.cores && (p.keys.cpu || 0) / busy > 0.5) return limited(sn, worst, { node: worst, lv: 2, title: 'Bottleneck: CPU ' + label(worst) + ' habis', text: 'Request yang sedang memakai CPU bersamaan (' + p.cpuN + ') melebihi jumlah core (' + p.cores + '), jadi semuanya melambat. Tambah proses atau instance, atau kurangi kerja CPU per request.' });
        return limited(sn, worst, { node: worst, lv: 2, title: 'Bottleneck: worker ' + label(worst) + ' habis', text: 'Semua worker terpakai dan request mengantre. Percepat request, atau tambah worker bila RAM cukup.' });
      }
      for (const id in sn.disks) { const d = sn.disks[id]; if (d.stalled && d.q > 0) return { node: id, lv: 1, title: label(id) + ' sedang tersendat', text: 'Commit mulai menumpuk. Selama tersendat tidak ada fsync yang selesai, dan worker yang menunggunya ikut diam.' }; }
      for (const id in sn.disks) { const d = sn.disks[id]; if (d.util > 0.85 || d.bg > 0.7) return { node: id, lv: 1, title: label(id) + ' mendekati jenuh', text: 'Antrean tulis hampir selalu terisi atau beban tulis latar tinggi. Sedikit tambahan beban akan membuat commit menumpuk.' }; }
      return { node: null, lv: 0, title: 'Sehat', text: 'Worker, koneksi, dan disk punya ruang. Coba skenario gangguan atau naikkan trafik.' };
    }

    function toArch() {
      const a = { schema: arch.schema, name: arch.name, stack: arch.stack, nodes: [], workloads: [], faults: JSON.parse(JSON.stringify(faults)) };
      arch.nodes.forEach(function (n) { const c = {}; origKeys[n.id].forEach(function (k) { c[k] = N[n.id][k]; }); a.nodes.push(c); });
      arch.workloads.forEach(function (w) { const c = JSON.parse(JSON.stringify(w)); c.rate = rates[w.id]; a.workloads.push(c); });
      return a;
    }

    return { S: S, N: N, rates: rates, faults: faults, arch: arch, WL: WL, step: step, snapshot: snapshot, diagnose: diagnose, agg: agg, pct: pct, toArch: toArch, catOf: catOf, edges: function () { return edges(arch); } };
  }

  return { create: create, edges: edges, DT: DT };
})();
if (typeof module !== 'undefined') module.exports = Sim;
