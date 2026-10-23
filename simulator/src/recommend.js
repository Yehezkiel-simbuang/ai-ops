// Aturan rekomendasi arsitektur. Membaca model arsitektur (dan opsional fakta dari analyzer)
// lalu menghasilkan saran lengkap dengan bukti, risiko, dan patch yang bisa disimulasikan.
// Dipakai di Node (tools/recommend-cli.js) dan di browser (lab).
const Recommend = (function () {
  const SEV = { tinggi: 0, sedang: 1, rendah: 2 };

  function byId(arch) { const m = {}; arch.nodes.forEach(function (n) { m[n.id] = n; }); return m; }
  function callCost(c) { return (c.read || c.ms || 0) * (1 - (c.skipProb || 0)); }
  function holdMs(w) { return (w.cpuMs || 0) + (w.calls || []).reduce(function (s, c) { return s + callCost(c); }, 0); }
  function median(a) { if (!a.length) return 0; const s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }
  function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + ' d' : Math.round(ms) + ' ms'; }

  function analyze(arch, facts) {
    const N = byId(arch), recs = [], faults = arch.observedFaults || arch.faults || [];
    const stallNodes = {}; faults.forEach(function (f) { if (f.type === 'stall') stallNodes[f.node] = f; });
    const dbs = arch.nodes.filter(function (n) { return n.type === 'db'; });
    const syncWl = arch.workloads.filter(function (w) { return !w.async; });

    // ---- commit database menunggu fsync di disk lambat/bersama (berlaku untuk ZFS, RAID, SAN, disk cloud, dst.; hanya bila lambatnya TERUKUR)
    arch.nodes.filter(function (n) { return n.type === 'disk'; }).forEach(function (d) {
      const attached = dbs.filter(function (x) { return x.disk === d.id; });
      const sync1 = attached.filter(function (x) { return x.flush !== 2; });
      if (d.slog || !sync1.length) return;
      if ((d.assumed || []).indexOf('fsyncMs') >= 0) return;   // kecepatan disk hanya asumsi: jangan menyarankan perangkat keras tanpa ukuran
      if ((d.fsyncMs || 8) < 5 && !stallNodes[d.id]) return;   // SSD cepat tanpa gangguan: perangkat log khusus tidak berguna
      const why = [attached.length + ' database memakai ' + (d.label || d.id) + ' bersama (' + attached.map(function (x) { return x.label || x.id; }).join(', ') + ')',
        'commit sinkron (fsync) mengantre di disk yang sama dengan tulisan latar, tanpa perangkat log yang cepat'];
      if (stallNodes[d.id]) why.push('gangguan tercatat: disk tersendat ' + stallNodes[d.id].len + ' d setiap ' + stallNodes[d.id].every + ' d');
      if (d.evidence) why.push('ukuran: ' + d.evidence);
      recs.push({ id: 'slog', title: 'Percepat commit: pindahkan log transaksi/database ke SSD NVMe, atau tambah perangkat log khusus (mis. SLOG di ZFS)', severity: (d.fsyncMs >= 10 || stallNodes[d.id]) ? 'tinggi' : 'sedang',
        why: why, tradeoff: 'Butuh perangkat keras. Commit tidak lagi menunggu disk yang lambat, tetapi disk utama yang tersendat tetap memengaruhi baca dan tulis latar.',
        expected: 'Commit selesai dalam beberapa milidetik walau disk utama tersendat. Worker tidak lagi tertahan menunggu fsync.',
        patch: [{ op: 'node', id: d.id, set: { slog: true, slogMs: 1.5 } }] });
    });

    // ---- amplifikasi tulis
    arch.nodes.filter(function (n) { return n.type === 'disk' && (n.amp || 1) >= 4; }).forEach(function (d) {
      recs.push({ id: 'recordsize', title: 'Kurangi amplifikasi tulis: samakan ukuran blok/stripe penyimpanan dengan halaman database (mis. recordsize 16K di ZFS, ukuran stripe RAID)', severity: 'sedang',
        why: ['setiap tulis kecil menulis ulang blok besar: amplifikasi ' + d.amp + 'x pada ' + (d.label || d.id)],
        tradeoff: 'Hanya berlaku untuk file baru. File database yang ada harus ditulis ulang (butuh jendela perawatan dan cadangan).',
        expected: 'Beban tulis latar turun, jadi fsync lebih jarang tertahan.', patch: [{ op: 'node', id: d.id, set: { amp: 1.5 } }] });
    });

    // ---- flush_log = 2 (opsional, ada harganya)
    arch.nodes.filter(function (n) { return n.type === 'disk' && !n.slog; }).forEach(function (d) {
      dbs.filter(function (x) { return x.disk === d.id && x.flush !== 2; }).forEach(function (db) {
        if ((d.assumed || []).indexOf('fsyncMs') >= 0) return;
        if (!/MySQL|MariaDB|Percona/i.test(db.label || '')) return;   // flush=2 adalah pengaturan InnoDB: hanya untuk keluarga MySQL, bukan database lain atau yang tak dikenal
        if (d.fsyncMs < 10 && !stallNodes[d.id]) return;
        recs.push({ id: 'flush2-' + db.id, title: 'Kurangi fsync per commit di ' + (db.label || db.id) + ' (innodb_flush_log_at_trx_commit = 2)', severity: 'sedang', optional: true,
          why: ['setiap commit menunggu fsync di ' + (d.label || d.id) + ' (rata-rata ' + d.fsyncMs + ' ms, memburuk saat tersendat)'],
          tradeoff: 'Jika HOST mati mendadak, sekitar 1 detik transaksi terakhir bisa hilang (termasuk pembayaran). Proses MySQL yang crash saja tidak menghilangkan data. Pakai sementara sampai penyimpanan commit dipercepat.',
          expected: 'Commit tidak menunggu disk, jadi stall disk tidak lagi menahan worker.', patch: [{ op: 'node', id: db.id, set: { flush: 2 } }] });
      });
    });

    // ---- pool bersama oleh request ringan dan berat
    arch.nodes.filter(function (n) { return n.type === 'pool'; }).forEach(function (p) {
      const users = syncWl.filter(function (w) { return w.pool === p.id; });
      const groups = {}; users.forEach(function (w) { (groups[w.client] = groups[w.client] || []).push(w); });
      const keys = Object.keys(groups); if (keys.length < 2) return;
      const info = keys.map(function (k) {
        const ws = groups[k];
        return { client: k, ws: ws, maxHold: Math.max.apply(null, ws.map(holdMs)), demand: ws.reduce(function (s, w) { return s + (w.rate || 0) * holdMs(w) / 1000; }, 0), rate: ws.reduce(function (s, w) { return s + (w.rate || 0); }, 0) };
      });
      info.sort(function (a, b) { return b.maxHold - a.maxHold; });
      const heavy = info[0], light = info.slice(1);
      if (heavy.maxHold < 2000 || light.every(function (g) { return g.maxHold > 1000; })) return;
      const cap = p.workers || 20;
      const hw = Math.max(5, Math.min(Math.ceil(heavy.demand * 2), Math.floor(cap * 0.4))), lw = Math.max(5, cap - hw);
      recs.push({ id: 'split-' + p.id, title: 'Pisahkan pool ' + (p.label || p.id) + ': request berat dipisah dari request ringan', severity: heavy.demand >= cap * 0.1 ? 'tinggi' : 'sedang',
        why: [heavy.client + ' punya request yang menahan worker sampai ' + fmtMs(heavy.maxHold) + ' (butuh sekitar ' + heavy.demand.toFixed(1) + ' worker rata-rata)',
          'pool yang sama dipakai ' + light.map(function (g) { return g.client + ' (' + g.rate.toFixed(0) + ' req/dtk, maks ' + fmtMs(g.maxHold) + ')'; }).join(', ') + ', jadi satu halaman berat bisa mengantrekan semuanya'],
        tradeoff: 'Total worker dibagi dua pool, jadi tiap pool lebih kecil. Pastikan RAM cukup untuk jumlah worker total.',
        expected: 'Request ringan tetap punya worker walau request berat menumpuk atau macet.',
        patch: [{ op: 'splitPool', id: p.id, into: [{ id: p.id + '_light', label: (p.label || p.id) + ' (ringan)', workers: lw, workloads: light.reduce(function (a, g) { return a.concat(g.ws.map(function (w) { return w.id; })); }, []) }, { id: p.id + '_heavy', label: (p.label || p.id) + ' (berat)', workers: hw, workloads: heavy.ws.map(function (w) { return w.id; }) }] }] });
    });

    // ---- penulisan baris panas di setiap request
    syncWl.forEach(function (w) {
      (w.calls || []).forEach(function (c) {
        if (!(c.hot && c.write && (c.writeProb == null || c.writeProb >= 1)) || (w.rate || 0) < 10) return;
        const db = N[c.node] || {};
        const why = [w.label + ' menulis ke baris yang sama di setiap request (' + (w.rate || 0) + ' req/dtk, ' + (db.hotKeys || '?') + ' baris)', 'setiap penulisan = satu commit yang menunggu fsync, dan request paralel dengan token yang sama saling mengantre'];
        if (facts && facts.sanctumVersion) why.push('laravel/sanctum ' + facts.sanctumVersion + ' menulis last_used_at di setiap request (kode vendor Guard)');
        recs.push({ id: 'hot-write-' + w.id, title: 'Kurangi penulisan baris panas di ' + w.label + ' (mis. last_used_at hanya diperbarui tiap beberapa menit)', severity: 'tinggi', why: why,
          tradeoff: 'Kolom last_used_at menjadi kurang presisi (selisih hingga beberapa menit). Tidak dipakai untuk logika akses.',
          expected: 'Jumlah commit turun tajam, dan rantai tunggu kunci pada baris yang sama menghilang.',
          patch: [{ op: 'call', workload: w.id, tag: c.tag, node: c.tag ? undefined : c.node, set: { writeProb: 0.02 } }] });
      });
    });

    // ---- panggilan lambat tanpa cache
    syncWl.forEach(function (w) {
      const costs = (w.calls || []).map(callCost);
      (w.calls || []).forEach(function (c) {
        const t = N[c.node]; if (!t || t.type !== 'db' || c.write || c.skipProb) return;   // hanya baca ke database; layanan eksternal (mis. pembayaran) tidak di-cache
        const cost = callCost(c);
        if (cost >= 2000) {
          recs.push({ id: 'loop-' + w.id, title: 'Ubah banyak query berulang di ' + w.label + ' menjadi satu query yang di-cache', severity: (w.rate || 0) >= 0.2 ? 'tinggi' : 'sedang',
            why: [w.label + ' menahan satu worker sekitar ' + fmtMs(holdMs(w)) + ' per request, sebagian besar menunggu ' + (t.label || t.id)], tradeoff: 'Data bisa tertinggal selama masa cache (mis. 60 detik).',
            expected: 'Waktu request turun dari detik ke ratusan milidetik, sehingga worker bebas lebih cepat.',
            patch: [{ op: 'call', workload: w.id, tag: c.tag, node: c.tag ? undefined : c.node, mul: { read: 0.05, ms: 0.05 } }] });
        } else if (cost >= 30 && cost >= 5 * Math.max(1, median(costs)) && (w.rate || 0) >= 2) {
          recs.push({ id: 'cache-' + w.id, title: 'Cache hasil panggilan ke ' + (t.label || t.id) + ' di ' + w.label, severity: 'sedang',
            why: [fmtMs(cost) + ' per request ke ' + (t.label || t.id) + ' pada ' + (w.rate || 0) + ' req/dtk, jauh lebih lambat dari panggilan lain di jalur yang sama'], tradeoff: 'Status bisa tertinggal selama masa cache (mis. 60 detik).',
            expected: 'Sebagian besar request melewati panggilan itu, dan beban ke ' + (t.label || t.id) + ' turun.',
            patch: [{ op: 'call', workload: w.id, tag: c.tag, node: c.tag ? undefined : c.node, set: { skipProb: 0.9 } }] });
        }
      });
    });

    // ---- penulis latar membebani disk bersama
    arch.nodes.filter(function (n) { return n.type === 'disk'; }).forEach(function (d) {
      let kbps = 0; const names = [];
      arch.workloads.filter(function (w) { return w.async; }).forEach(function (w) {
        (w.calls || []).forEach(function (c) { const t = N[c.node]; if (t && t.disk === d.id && c.write) { kbps += (w.rate || 0) * (c.kb || 16) * (d.amp || 1); names.push(w.label); } });
      });
      const util = kbps / ((d.bwMBs || 100) * 1024);
      if (util >= 0.05) recs.push({ id: 'async-' + d.id, title: 'Kurangi frekuensi penulis latar yang membebani ' + (d.label || d.id), severity: util >= 0.15 ? 'tinggi' : 'sedang',
        why: ['penulis latar (' + names.join(', ') + ') memakai sekitar ' + Math.round(util * 100) + '% bandwidth tulis disk'], tradeoff: 'Data latar (mis. accounting) menjadi kurang sering diperbarui.', expected: 'Fsync sinkron tidak lagi berebut dengan tulisan latar.',
        patch: arch.workloads.filter(function (w) { return w.async && names.indexOf(w.label) >= 0; }).map(function (w) { return { op: 'workload', id: w.id, set: { rate: Math.max(0.1, (w.rate || 0) * 0.2) } }; }) });
    });

    // ---- kapasitas koneksi
    dbs.filter(function (db) { return db.onFull !== 'wait'; }).forEach(function (db) {
      const total = arch.nodes.filter(function (n) { return n.type === 'pool'; }).reduce(function (s, p) { return s + (p.workers || 0); }, 0);
      if (total > 0.8 * (db.connections || 151)) recs.push({ id: 'conn-' + db.id, title: 'Naikkan batas koneksi ' + (db.label || db.id), severity: 'sedang',
        why: ['jumlah worker (' + total + ') mendekati batas koneksi (' + db.connections + ')'], tradeoff: 'Tiap koneksi memakai memori di database.', expected: 'Tidak ada penolakan "terlalu banyak koneksi" saat lonjakan.', patch: [{ op: 'node', id: db.id, set: { connections: (db.connections || 151) * 2 } }] });
    });

    // ---- pool koneksi klien terlalu kecil (request menunggu koneksi)
    dbs.forEach(function (db) {
      if (db.onFull !== 'wait' || (db.connections || 0) <= 1) return;
      let need = 0; syncWl.forEach(function (w) { (w.calls || []).forEach(function (c) { if (c.node === db.id) need += (w.rate || 0) * ((c.read || 0) + (c.write ? 6 : 0)) / 1000; }); });
      if (need < 0.7 * db.connections) return;
      const to = Math.min(150, Math.max(db.connections + 5, Math.ceil(need * 2)));
      recs.push({ id: 'connpool-' + db.id, title: 'Naikkan pool koneksi ke ' + (db.label || db.id) + ' dari ' + db.connections + ' menjadi sekitar ' + to, severity: need >= db.connections ? 'tinggi' : 'sedang',
        why: ['beban rata-rata butuh sekitar ' + need.toFixed(1) + ' koneksi bersamaan, pool hanya ' + db.connections, 'request yang kehabisan koneksi mengantre (bukan ditolak), sehingga latensi naik diam-diam'],
        tradeoff: 'Pool terlalu besar membebani database. Pastikan max_connections server (dibagi jumlah instance aplikasi) cukup.', expected: 'Request tidak lagi mengantre menunggu koneksi.', patch: [{ op: 'node', id: db.id, set: { connections: to } }] });
    });

    // ---- CPU habis (jumlah core terbatas)
    arch.nodes.filter(function (n) { return n.type === 'pool' && n.cores > 0; }).forEach(function (p) {
      let cpu = 0; syncWl.forEach(function (w) { if (w.pool === p.id) cpu += (w.rate || 0) * (w.cpuMs || 0) / 1000; });
      if (cpu < 0.7 * p.cores) return;
      const mult = Math.ceil(cpu / (0.5 * p.cores));
      recs.push({ id: 'cpu-' + p.id, title: 'Tambah proses/instance untuk ' + (p.label || p.id) + ' (CPU ' + p.cores + ' core hampir habis)', severity: cpu >= p.cores ? 'tinggi' : 'sedang',
        why: ['kerja CPU rata-rata ' + cpu.toFixed(1) + ' core dari ' + p.cores + ' core yang tersedia', p.cores === 1 ? 'satu proses hanya memakai satu core; core lain menganggur' : 'semua request melambat bersamaan begitu core penuh'],
        tradeoff: 'Memori bertambah per proses; state di memori (sesi, cache lokal) tidak lagi dibagi antarproses.', expected: 'Request tidak saling memperlambat saat beban naik.', patch: [{ op: 'node', id: p.id, set: { cores: p.cores * mult } }] });
    });

    // ---- konsumen antrean kurang
    arch.workloads.filter(function (w) { return w.async && w.pool; }).forEach(function (w) {
      const p = N[w.pool]; if (!p) return;
      const hold = (w.cpuMs || 0) + (w.calls || []).reduce(function (s, c) { return s + (c.read || c.ms || 0) + (c.write ? 6 : 0); }, 0), demand = (w.rate || 0) * hold / 1000;
      if (demand < 0.8 * (p.workers || 1)) return;
      recs.push({ id: 'consumer-' + w.id, title: 'Naikkan concurrency konsumen ' + (p.label || p.id) + ' (backlog akan tumbuh)', severity: 'tinggi',
        why: ['pekerjaan datang ' + (w.rate || 0) + '/dtk dan menahan ' + fmtMs(hold) + ' masing-masing, butuh ' + demand.toFixed(1) + ' pekerja; tersedia ' + p.workers],
        tradeoff: 'Lebih banyak konsumen berarti lebih banyak koneksi dan beban ke database/layanan luar.', expected: 'Antrean habis lebih cepat dari datangnya pekerjaan.', patch: [{ op: 'node', id: p.id, set: { workers: Math.ceil(demand * 1.5) } }] });
    });

    // ---- panggilan layanan luar tanpa timeout
    syncWl.forEach(function (w) {
      (w.calls || []).forEach(function (c) {
        const t = N[c.node]; if (!t || t.type !== 'external' || c.timeoutMs) return;
        recs.push({ id: 'timeout-' + w.id + '-' + c.node, title: 'Beri timeout ketat pada panggilan ke ' + (t.label || t.id) + ' (' + w.label + ')', severity: c.noTimeout ? 'tinggi' : 'sedang',
          why: ['saat ' + (t.label || t.id) + ' melambat, tiap request menahan satu worker selama layanan itu menjawab' + (c.noTimeout ? ' (panggilan tanpa timeout ditemukan di kode)' : ''), 'worker habis lalu semua endpoint ikut macet, bukan hanya yang memakai layanan itu'],
          tradeoff: 'Sebagian transaksi gagal lebih cepat; siapkan retry dan pengecekan status (webhook/polling) agar pembayaran tidak ganda.', expected: 'Layanan luar yang macet hanya merusak endpointnya sendiri, sisanya tetap cepat.',
          patch: [{ op: 'call', workload: w.id, node: c.node, set: { timeoutMs: 3000 } }] });
      });
    });

    // ---- SQLite dengan penulisan banyak
    dbs.filter(function (d) { return /SQLite/.test(d.label || '') && d.connections === 1; }).forEach(function (db) {
      let wr = 0; syncWl.forEach(function (w) { (w.calls || []).forEach(function (c) { if (c.node === db.id && c.write) wr += (w.rate || 0); }); });
      if (wr < 5) return;
      recs.push({ id: 'sqlite-' + db.id, title: 'Pindah dari SQLite ke Postgres/MySQL (atau aktifkan WAL) untuk beban tulis ini', severity: wr >= 20 ? 'tinggi' : 'sedang',
        why: ['SQLite hanya mengizinkan satu penulis; sekitar ' + wr.toFixed(0) + ' tulis/dtk antre satu per satu'], tradeoff: 'Perlu migrasi data dan layanan database terpisah.', expected: 'Penulisan paralel tidak saling menunggu.',
        patch: [{ op: 'node', id: db.id, set: { connections: 50, group: true, label: (db.label || db.id).replace(' (penulis tunggal)', '') } }] });
    });

    // ---- temuan non-simulasi dari fakta kode
    (arch.smells || []).forEach(function (s) {
      recs.push({ id: 'smell-' + s.id + '-' + (s.unit || ''), title: s.text.split(/[:;.]/)[0], severity: s.id === 'event-loop-block' || s.id === 'go-unbounded-pool' ? 'sedang' : 'rendah', why: [s.text].concat((s.evidence || []).slice(0, 3).map(function (e) { return 'bukti: ' + e; })),
        tradeoff: 'Perlu perubahan kode; uji sebelum rilis.', expected: 'Menghilangkan sumber kemacetan yang tidak terlihat di konfigurasi.', patch: [] });
    });
    if (facts) {
      if (facts.configCached === false && facts.kind === 'laravel') recs.push({ id: 'cfg-cache', title: 'Aktifkan cache konfigurasi dan route (php artisan config:cache dan route:cache)', severity: 'rendah', why: ['bootstrap/cache tidak berisi config.php'], tradeoff: 'Uji dulu: config:cache merusak kode yang memanggil env() di luar folder config.', expected: 'Boot request lebih cepat dan hemat CPU.', patch: [] });
      if (facts.appDebug) recs.push({ id: 'debug', title: 'Pastikan APP_DEBUG=false dan LOG_LEVEL tidak debug di produksi', severity: 'rendah', why: ['.env menunjukkan APP_DEBUG=true (periksa apakah ini berkas produksi)'], tradeoff: 'Tidak ada.', expected: 'Lebih sedikit tulis log dan tidak membocorkan detail error.', patch: [] });
      if (facts.drivers && facts.drivers.dbHost === 'jarak-jauh') recs.push({ id: 'db-remote', title: 'Database di server terpisah: pertimbangkan pooler koneksi (mis. ProxySQL) dan pantau latensi jaringan', severity: 'rendah', why: ['DB_HOST bukan lokal, jadi tiap request membuka koneksi baru lewat jaringan'], tradeoff: 'Komponen tambahan yang harus dipelihara.', expected: 'Pembukaan koneksi lebih murah dan terkendali.', patch: [] });
    }

    recs.sort(function (a, b) { return SEV[a.severity] - SEV[b.severity]; });
    return recs;
  }

  function recommended(arch, recs) {
    const ops = []; recs.forEach(function (r) { if (!r.optional) r.patch.forEach(function (o) { ops.push(o); }); });
    const PatchMod = (typeof Patch !== 'undefined') ? Patch : require('./patch.js');
    const a = PatchMod.apply(arch, ops); a.name = arch.name.replace('(saat ini)', '').trim() + ' (rekomendasi)'; return a;
  }

  // uji ketahanan untuk arsitektur tanpa data gangguan nyata: disk melambat sesaat dan layanan luar melambat (bukan kejadian yang tercatat)
  function defaultFaults(arch) {
    const out = [];
    arch.nodes.forEach(function (n) {
      if (n.type === 'disk') out.push({ node: n.id, type: 'stall', every: 150, len: 40, _nama: 'Uji ketahanan: disk tersendat sesaat' });
      if (n.type === 'external') out.push({ node: n.id, type: 'slow', every: 120, len: 40, mult: 30, _nama: 'Uji ketahanan: ' + n.label + ' melambat 30x' });
    });
    return out;
  }

  return { analyze: analyze, recommended: recommended, holdMs: holdMs, defaultFaults: defaultFaults };
})();
if (typeof module !== 'undefined') { module.exports = Recommend; }
