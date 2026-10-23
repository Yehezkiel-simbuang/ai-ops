// Pemeriksaan layanan di dalam server (bukan hanya resource): database, antrean, web, log, pool, status aplikasi.
// Setiap pemeriksaan = satu perintah BACA yang dijalankan di server lewat SSH, dengan parameter yang divalidasi ketat.
// Perintah dibangun dari templat di sini (bukan teks bebas), kecuali tipe "custom" yang wajib lolos kebijakan baca (src/safety.js).
import * as Safety from './safety.js';

export type Params = Record<string, any>;
export interface TypeDef { label: string; kind: 'match' | 'number' | 'http' | 'fpm' | 'netdata'; ok?: RegExp; build: (p: Params) => string }
export interface PackDef { label: string; hint: string; /** 'aplikasi' = khusus satu aplikasi atau proyek, bukan layanan umum. Bawaan: 'umum'. */ category?: 'umum' | 'aplikasi'; fields: Array<{ k: string; label: string; def: string }>; make: (o: Params, sudo: boolean) => CheckDef[] }
export interface CheckDef { name: string; type: string; params: Params; minor?: number; warn?: number; crit?: number; dir?: 'gt' | 'lt'; delta?: boolean | number; confirm?: number; pack?: string }
export interface CheckRow { id?: number; type: string; params: Params | string; minor?: number | null; warn?: number | null; crit?: number | null; dir?: string; delta?: boolean | number; last_raw?: number | null }
export interface CmdResult { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }
export interface Evaluation { status: 'ok' | 'minor' | 'warn' | 'crit' | 'unknown'; value: number | null; raw: number | null; detail: string }

export const V = {
  unit: /^[A-Za-z0-9@._-]{1,80}$/, port: /^\d{1,5}$/, url: /^https?:\/\/[A-Za-z0-9._~:\/?#@!&=%+,-]{1,300}$/, path: /^\/[A-Za-z0-9._\/@+-]{0,200}$/, db: /^[A-Za-z0-9_]{1,64}$/,
  pat: /^[A-Za-z0-9 ._:\/=-]{1,80}$/, host: /^[A-Za-z0-9.-]{1,200}$/, name: /^[A-Za-z0-9_.-]{1,80}$/, int: /^\d{1,6}$/, prefix: /^(sudo -n |sudo -n -u postgres )?$/
};
function need(p: Params, k: string, re: RegExp, label?: string): string { const raw = String(p[k] == null ? '' : p[k]), v = k === 'prefix' ? raw : raw.trim(); if (!re.test(v)) throw new Error('Parameter "' + (label || k) + '" tidak valid'); return v; }

// kind: exit | match | number | http | fpm | netdata
export const TYPES: Record<string, TypeDef> = {
  systemd: { label: 'Layanan systemd aktif', kind: 'match' as const, ok: /^active$/m, build: function (p: Params) { return 'systemctl is-active ' + need(p, 'unit', V.unit); } },
  port: { label: 'Port TCP lokal terbuka', kind: 'match' as const, ok: /open/, build: function (p: Params) { return "timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/" + need(p, 'port', V.port) + "' && echo open || echo closed"; } },
  http: { label: 'HTTP responsif (kode dan waktu)', kind: 'http', build: function (p: Params) { return "curl -s -o /dev/null -m 10 -w '%{http_code} %{time_total}' " + need(p, 'url', V.url); } },
  mysql_ping: { label: 'MySQL/MariaDB menjawab', kind: 'match' as const, ok: /is alive/, build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'mysqladmin ping 2>&1'; } },
  mysql_conn_pct: { label: 'Koneksi MySQL terpakai (% dari max_connections)', kind: 'number', build: function (p: Params) { const pre = need(p, 'prefix', V.prefix); return 'a=$(' + pre + "mysql -N -e \"SHOW GLOBAL STATUS LIKE 'Threads_connected'\" | awk '{print $2}'); m=$(" + pre + 'mysql -N -e "SELECT @@max_connections"); echo $((100*a/m))'; } },
  mysql_longq: { label: 'Query MySQL berjalan lebih dari N detik', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'mysql -N -e "SELECT COUNT(*) FROM information_schema.processlist WHERE command<>\'Sleep\' AND time>' + need(p, 'sec', V.int, 'detik') + '"'; } },
  mysql_commitwait: { label: 'Thread MySQL tersangkut "waiting for handler commit" (indikasi fsync/disk macet)', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'mysql -N -e "SELECT COUNT(*) FROM information_schema.processlist WHERE state LIKE \'waiting for handler commit%\'"'; } },
  mysql_lockwait: { label: 'Transaksi InnoDB menunggu kunci baris', kind: 'number', build: function (p: Params) { const pre = need(p, 'prefix', V.prefix); return pre + 'mysql -N -e "SELECT COUNT(*) FROM performance_schema.data_lock_waits" 2>/dev/null || ' + pre + 'mysql -N -e "SELECT COUNT(*) FROM information_schema.innodb_lock_waits"'; } },
  mysql_aborted: { label: 'Koneksi MySQL gagal (Aborted_connects, kenaikan sejak cek lalu)', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + "mysql -N -e \"SHOW GLOBAL STATUS LIKE 'Aborted_connects'\" | awk '{print $2}'"; } },
  mysql_sql: { label: 'Query SQL baca-saja (angka pertama)', kind: 'number', build: function (p: Params) {
    const sql = String(p.sql || '').trim(); if (!sql || /["`$\\]/.test(sql) || !Safety.sqlIsRead(sql)) throw new Error('SQL harus baca-saja (SELECT/SHOW) tanpa tanda kutip ganda, backtick, $, atau \\');
    const db = p.db ? need(p, 'db', V.db, 'database') + ' ' : ''; return need(p, 'prefix', V.prefix) + 'mysql -N ' + db + '-e "' + sql + '"'; } },
  pg_conn_pct: { label: 'Koneksi PostgreSQL terpakai (% dari max_connections)', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'psql -tAc "SELECT ROUND(100.0*count(*)/(SELECT setting::int FROM pg_settings WHERE name=\'max_connections\')) FROM pg_stat_activity"'; } },
  pg_longq: { label: 'Query PostgreSQL berjalan lebih dari N detik', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'psql -tAc "SELECT count(*) FROM pg_stat_activity WHERE state<>\'idle\' AND now()-query_start > interval \'' + need(p, 'sec', V.int, 'detik') + ' seconds\'"'; } },
  pg_idle_tx: { label: 'Transaksi PostgreSQL menggantung (idle in transaction)', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'psql -tAc "SELECT count(*) FROM pg_stat_activity WHERE state LIKE \'idle in transaction%\' AND now()-state_change > interval \'60 seconds\'"'; } },
  redis_ping: { label: 'Redis menjawab', kind: 'match' as const, ok: /PONG/, build: function () { return 'redis-cli ping 2>&1'; } },
  redis_mem_mb: { label: 'Memori Redis terpakai (MB)', kind: 'number', build: function () { return "redis-cli info memory | awk -F: '/^used_memory:/{printf \"%d\", $2/1048576}'"; } },
  redis_clients: { label: 'Klien Redis terhubung', kind: 'number', build: function () { return "redis-cli info clients | tr -d '\\r' | awk -F: '/^connected_clients/{print $2+0}'"; } },
  nginx_conf: { label: 'Konfigurasi Nginx valid', kind: 'match' as const, ok: /successful/, build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'nginx -t 2>&1'; } },
  fpm_status: { label: 'PHP-FPM: antrean request menunggu worker', kind: 'fpm', build: function (p: Params) { return 'curl -s -m 8 ' + need(p, 'url', V.url); } },
  log_count: { label: 'Kemunculan teks di log (kenaikan sejak cek lalu)', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + "grep -cF '" + need(p, 'pattern', V.pat, 'teks') + "' " + need(p, 'path', V.path, 'berkas log') + ' || true'; } },
  disk_pct: { label: 'Pemakaian disk pada path (%)', kind: 'number', build: function (p: Params) { return "df -P " + need(p, 'path', V.path) + " | awk 'NR==2{gsub(\"%\",\"\",$5);print $5}'"; } },
  inode_pct: { label: 'Pemakaian inode pada path (%)', kind: 'number', build: function (p: Params) { return "df -Pi " + need(p, 'path', V.path) + " | awk 'NR==2{gsub(\"%\",\"\",$5);print $5}'"; } },
  docker_running: { label: 'Kontainer Docker berjalan', kind: 'match' as const, ok: /^true$/m, build: function (p: Params) { return "docker inspect -f '{{.State.Running}}' " + need(p, 'name', V.name, 'nama kontainer') + ' 2>&1'; } },
  proc_count: { label: 'Jumlah proses dengan pola (mis. queue worker)', kind: 'number', build: function (p: Params) { return "pgrep -fc '" + need(p, 'pattern', V.pat, 'pola proses') + "' || true"; } },
  ntp_sync: { label: 'Jam sistem tersinkron (NTP)', kind: 'match' as const, ok: /yes/, build: function () { return 'timedatectl show -p NTPSynchronized --value 2>&1'; } },
  udp_port: { label: 'Port UDP lokal mendengarkan (mis. DNS 53)', kind: 'number', build: function (p: Params) { return "ss -uln | grep -c ':" + need(p, 'port', V.port) + " ' || true"; } },
  netdata_alarms: { label: 'Alarm Netdata aktif', kind: 'netdata', build: function () { return 'curl -s -m 8 http://127.0.0.1:19999/api/v1/alarms?active'; } },
  pg_ping: { label: 'PostgreSQL menerima koneksi', kind: 'match' as const, ok: /accepting connections/, build: function () { return 'pg_isready 2>&1'; } },
  redis_rdb_health: { label: 'Redis: penyimpanan RDB terakhir berhasil', kind: 'match' as const, ok: /ok/, build: function () { return "redis-cli info persistence | tr -d '\\r' | awk -F: '/^rdb_last_bgsave_status/{print $2}'"; } },
  redis_evicted: { label: 'Redis: kunci terbuang karena memori penuh (kenaikan)', kind: 'number', build: function () { return "redis-cli info stats | tr -d '\\r' | awk -F: '/^evicted_keys/{print $2+0}'"; } },
  apache_conf: { label: 'Konfigurasi Apache valid', kind: 'match' as const, ok: /Syntax OK/, build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'apache2ctl configtest 2>&1 || ' + need(p, 'prefix', V.prefix) + 'httpd -t 2>&1'; } },
  haproxy_conf: { label: 'Konfigurasi HAProxy valid', kind: 'match' as const, ok: /valid/, build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'haproxy -c -f /etc/haproxy/haproxy.cfg 2>&1'; } },
  mongo_ping: { label: 'MongoDB menjawab', kind: 'match' as const, ok: /^1$/m, build: function () { return "mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>&1"; } },
  mongo_conn: { label: 'Koneksi MongoDB aktif', kind: 'number', build: function () { return "mongosh --quiet --eval 'db.serverStatus().connections.current' 2>&1"; } },
  rabbit_ping: { label: 'RabbitMQ menjawab', kind: 'match' as const, ok: /Ping succeeded|pong/i, build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'rabbitmqctl ping 2>&1'; } },
  rabbit_msgs: { label: 'RabbitMQ: total pesan menumpuk di antrean', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + "rabbitmqctl list_queues -q messages 2>&1 | awk '{s+=$1} END{print s+0}'"; } },
  es_status: { label: 'Elasticsearch: status cluster (0 hijau, 1 kuning, 2 merah)', kind: 'number', build: function () { return "curl -s -m 8 http://127.0.0.1:9200/_cluster/health | sed -n 's/.*\"status\":\"\\([a-z]*\\)\".*/\\1/p' | awk '{print ($1==\"green\")?0:($1==\"yellow\")?1:2}'"; } },
  supervisor_down: { label: 'Supervisor: program yang tidak RUNNING', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + "supervisorctl status 2>&1 | grep -vc RUNNING || true"; } },
  mail_queue: { label: 'Antrean surat Postfix', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + "mailq 2>/dev/null | grep -c '^[A-F0-9]' || true"; } },
  docker_bad_count: { label: 'Kontainer Docker tidak sehat', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + 'docker ps --filter health=unhealthy -q 2>&1 | wc -l'; } },
  cert_days: { label: 'Sisa hari sertifikat HTTPS', kind: 'number', build: function (p: Params) { const h = need(p, 'host', V.host, 'nama host'), port = need(p, 'port', V.port); return 'e=$(echo | timeout 8 openssl s_client -connect ' + h + ':' + port + ' -servername ' + h + " 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2); [ -n \"$e\" ] && echo $(( ($(date -d \"$e\" +%s) - $(date +%s)) / 86400 ))"; } },
  systemd_failed: { label: 'Unit systemd berstatus gagal', kind: 'number', build: function () { return "systemctl --failed --no-legend --plain 2>/dev/null | wc -l"; } },
  zombie_procs: { label: 'Proses zombie', kind: 'number', build: function () { return "ps -eo stat | grep -c '^Z' || true"; } },
  reboot_required: { label: 'Server butuh reboot (1 = ya)', kind: 'number', build: function () { return '[ -f /var/run/reboot-required ] && echo 1 || echo 0'; } },
  fd_pct: { label: 'File descriptor terpakai (%)', kind: 'number', build: function () { return "awk '{printf \"%d\", 100*$1/$3}' /proc/sys/fs/file-nr"; } },
  oom_kills: { label: 'Proses dimatikan kernel karena memori habis (kenaikan)', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + "dmesg 2>/dev/null | grep -ci 'out of memory\\|oom-kill' || true"; } },
  tcp_conn: { label: 'Koneksi TCP terjalin', kind: 'number', build: function () { return 'ss -H -tn state established 2>/dev/null | wc -l'; } },
  ssh_failed: { label: 'Login SSH gagal (10 menit terakhir)', kind: 'number', build: function (p: Params) { return need(p, 'prefix', V.prefix) + "journalctl -u ssh -u sshd --since '10 minutes ago' --no-pager 2>/dev/null | grep -c 'Failed password\\|Invalid user' || true"; } },
  custom: { label: 'Perintah baca-saja kustom', kind: 'number', build: function (p: Params) { const c = String(p.command || '').trim(); const r = Safety.classify(c); if (r.cls !== 'read') throw new Error('Perintah kustom harus baca-saja: ' + r.why); return c; } }
};

// ---------- paket siap pakai (dibuat sekali klik, semua dapat diubah setelahnya)
export const PACKS: Record<string, PackDef> = {
  mysql: { label: 'MySQL / MariaDB', hint: 'Termasuk deteksi commit tersangkut dan kunci baris', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'mysql' }],
    make: function (o: Params, sudo: boolean): CheckDef[] { const pre = sudo ? 'sudo -n ' : ''; return [
      { name: 'MySQL: layanan aktif', type: 'systemd', params: { unit: o.unit || 'mysql' }, confirm: 1 }, { name: 'MySQL: menjawab ping', type: 'mysql_ping', params: { prefix: pre }, confirm: 2 },
      { name: 'MySQL: koneksi terpakai %', type: 'mysql_conn_pct', params: { prefix: pre }, warn: 70, crit: 90 }, { name: 'MySQL: query lambat (>10 dtk)', type: 'mysql_longq', params: { prefix: pre, sec: 10 }, warn: 3, crit: 10 },
      { name: 'MySQL: thread menunggu commit (fsync)', type: 'mysql_commitwait', params: { prefix: pre }, warn: 5, crit: 20 }, { name: 'MySQL: transaksi menunggu kunci baris', type: 'mysql_lockwait', params: { prefix: pre }, warn: 3, crit: 10 },
      { name: 'MySQL: koneksi gagal baru', type: 'mysql_aborted', params: { prefix: pre }, warn: 20, crit: 200, delta: 1 }]; } },
  postgres: { label: 'PostgreSQL', hint: '', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'postgresql' }],
    make: function (o: Params, sudo: boolean): CheckDef[] { const pre = sudo ? 'sudo -n -u postgres ' : ''; return [{ name: 'PostgreSQL: layanan aktif', type: 'systemd', params: { unit: o.unit || 'postgresql' }, confirm: 1 }, { name: 'PostgreSQL: menerima koneksi', type: 'pg_ping', params: {}, confirm: 2 }, { name: 'PostgreSQL: koneksi terpakai %', type: 'pg_conn_pct', params: { prefix: pre }, warn: 70, crit: 90 },
      { name: 'PostgreSQL: query lambat (>10 dtk)', type: 'pg_longq', params: { prefix: pre, sec: 10 }, warn: 3, crit: 10 }, { name: 'PostgreSQL: transaksi menggantung', type: 'pg_idle_tx', params: { prefix: pre }, warn: 3, crit: 10 }]; } },
  redis: { label: 'Redis', hint: '', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'redis-server' }],
    make: function (o: Params): CheckDef[] { return [{ name: 'Redis: layanan aktif', type: 'systemd', params: { unit: o.unit || 'redis-server' }, confirm: 1 }, { name: 'Redis: menjawab ping', type: 'redis_ping', params: {} }, { name: 'Redis: memori terpakai (MB)', type: 'redis_mem_mb', params: {}, warn: 1024, crit: 2048 }, { name: 'Redis: klien terhubung', type: 'redis_clients', params: {}, warn: 500, crit: 2000 }, { name: 'Redis: penyimpanan RDB terakhir berhasil', type: 'redis_rdb_health', params: {}, confirm: 2 }, { name: 'Redis: kunci terbuang (memori penuh)', type: 'redis_evicted', params: {}, warn: 1, crit: 1000, delta: 1 }]; } },
  nginx: { label: 'Nginx', hint: '', fields: [{ k: 'url', label: 'URL cek lokal', def: 'http://127.0.0.1/' }, { k: 'log', label: 'Berkas log galat', def: '/var/log/nginx/error.log' }],
    make: function (o: Params, sudo: boolean): CheckDef[] { return [{ name: 'Nginx: layanan aktif', type: 'systemd', params: { unit: 'nginx' }, confirm: 1 }, { name: 'Nginx: konfigurasi valid', type: 'nginx_conf', params: { prefix: sudo ? 'sudo -n ' : '' }, confirm: 1 }, { name: 'Nginx: HTTP responsif (ms)', type: 'http', params: { url: o.url || 'http://127.0.0.1/' }, warn: 1500, crit: 5000 }, { name: 'Nginx: galat baru di log', type: 'log_count', params: { prefix: sudo ? 'sudo -n ' : '', pattern: 'error', path: o.log || '/var/log/nginx/error.log' }, warn: 10, crit: 100, delta: 1 }]; } },
  phpfpm: { label: 'PHP-FPM', hint: 'Antrean worker dari halaman status, dan log "reached pm.max_children"', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'php8.2-fpm' }, { k: 'url', label: 'URL halaman status (format JSON)', def: 'http://127.0.0.1/fpm-status?json' }, { k: 'log', label: 'Berkas log FPM', def: '/var/log/php8.2-fpm.log' }],
    make: function (o: Params, sudo: boolean): CheckDef[] { return [{ name: 'PHP-FPM: layanan aktif', type: 'systemd', params: { unit: o.unit || 'php8.2-fpm' }, confirm: 1 }, { name: 'PHP-FPM: request menunggu worker', type: 'fpm_status', params: { url: o.url || 'http://127.0.0.1/fpm-status?json' }, warn: 1, crit: 10 },
      { name: 'PHP-FPM: pm.max_children tercapai (baru)', type: 'log_count', params: { prefix: sudo ? 'sudo -n ' : '', pattern: 'reached pm.max_children', path: o.log || '/var/log/php8.2-fpm.log' }, warn: 1, crit: 10, delta: 1 }]; } },
  laravel: { label: 'Aplikasi Laravel', hint: 'Khusus aplikasi: worker queue dan kesehatan HTTP. Tidak dideteksi otomatis (PHP-FPM dan Nginx belum tentu Laravel); pasang sendiri bila dipakai', category: 'aplikasi', fields: [{ k: 'url', label: 'URL cek aplikasi', def: 'http://127.0.0.1/' }],
    make: function (o: Params): CheckDef[] { return [{ name: 'Aplikasi: HTTP responsif (ms)', type: 'http', params: { url: o.url || 'http://127.0.0.1/' }, warn: 2000, crit: 8000 }, { name: 'Aplikasi: queue worker berjalan', type: 'proc_count', params: { pattern: 'artisan queue:work' }, warn: 1, crit: 0, dir: 'lt', confirm: 2 }]; } },
  docker: { label: 'Docker', hint: '', fields: [{ k: 'name', label: 'Nama kontainer (opsional)', def: '' }],
    make: function (o: Params, sudo: boolean): CheckDef[] { const out: CheckDef[] = [{ name: 'Docker: layanan aktif', type: 'systemd', params: { unit: 'docker' }, confirm: 1 }]; out.push({ name: 'Docker: kontainer tidak sehat', type: 'docker_bad_count', params: { prefix: sudo ? 'sudo -n ' : '' }, warn: 1, crit: 3 }); if (o.name) out.push({ name: 'Kontainer ' + o.name + ' berjalan', type: 'docker_running', params: { name: o.name }, confirm: 2 }); return out; } },
  apache: { label: 'Apache', hint: '', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'apache2' }, { k: 'url', label: 'URL cek lokal', def: 'http://127.0.0.1/' }, { k: 'log', label: 'Berkas log galat', def: '/var/log/apache2/error.log' }],
    make: function (o: Params, sudo: boolean): CheckDef[] { const pre = sudo ? 'sudo -n ' : ''; return [{ name: 'Apache: layanan aktif', type: 'systemd', params: { unit: o.unit || 'apache2' }, confirm: 1 }, { name: 'Apache: konfigurasi valid', type: 'apache_conf', params: { prefix: pre }, confirm: 1 }, { name: 'Apache: HTTP responsif (ms)', type: 'http', params: { url: o.url || 'http://127.0.0.1/' }, warn: 1500, crit: 5000 }, { name: 'Apache: galat baru di log', type: 'log_count', params: { prefix: pre, pattern: 'error', path: o.log || '/var/log/apache2/error.log' }, warn: 10, crit: 100, delta: 1 }]; } },
  caddy: { label: 'Caddy', hint: '', fields: [{ k: 'url', label: 'URL cek lokal', def: 'http://127.0.0.1/' }],
    make: function (o: Params): CheckDef[] { return [{ name: 'Caddy: layanan aktif', type: 'systemd', params: { unit: 'caddy' }, confirm: 1 }, { name: 'Caddy: HTTP responsif (ms)', type: 'http', params: { url: o.url || 'http://127.0.0.1/' }, warn: 1500, crit: 5000 }]; } },
  haproxy: { label: 'HAProxy', hint: 'Memeriksa layanan dan validitas konfigurasi', fields: [],
    make: function (_o: Params, sudo: boolean): CheckDef[] { return [{ name: 'HAProxy: layanan aktif', type: 'systemd', params: { unit: 'haproxy' }, confirm: 1 }, { name: 'HAProxy: konfigurasi valid', type: 'haproxy_conf', params: { prefix: sudo ? 'sudo -n ' : '' }, confirm: 1 }]; } },
  mongodb: { label: 'MongoDB', hint: 'Butuh mongosh; bila memakai autentikasi, buat pengguna baca-saja untuk monitoring', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'mongod' }],
    make: function (o: Params): CheckDef[] { return [{ name: 'MongoDB: layanan aktif', type: 'systemd', params: { unit: o.unit || 'mongod' }, confirm: 1 }, { name: 'MongoDB: menjawab ping', type: 'mongo_ping', params: {}, confirm: 2 }, { name: 'MongoDB: koneksi aktif', type: 'mongo_conn', params: {}, warn: 500, crit: 1500 }]; } },
  rabbitmq: { label: 'RabbitMQ', hint: 'rabbitmqctl biasanya butuh sudo; centang sudo di pengaturan server', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'rabbitmq-server' }],
    make: function (o: Params, sudo: boolean): CheckDef[] { const pre = sudo ? 'sudo -n ' : ''; return [{ name: 'RabbitMQ: layanan aktif', type: 'systemd', params: { unit: o.unit || 'rabbitmq-server' }, confirm: 1 }, { name: 'RabbitMQ: menjawab ping', type: 'rabbit_ping', params: { prefix: pre }, confirm: 2 }, { name: 'RabbitMQ: pesan menumpuk', type: 'rabbit_msgs', params: { prefix: pre }, warn: 1000, crit: 10000 }]; } },
  elasticsearch: { label: 'Elasticsearch', hint: 'Status cluster dibaca dari 127.0.0.1:9200', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'elasticsearch' }],
    make: function (o: Params): CheckDef[] { return [{ name: 'Elasticsearch: layanan aktif', type: 'systemd', params: { unit: o.unit || 'elasticsearch' }, confirm: 1 }, { name: 'Elasticsearch: status cluster', type: 'es_status', params: {}, warn: 1, crit: 2 }]; } },
  memcached: { label: 'Memcached', hint: '', fields: [],
    make: function (): CheckDef[] { return [{ name: 'Memcached: layanan aktif', type: 'systemd', params: { unit: 'memcached' }, confirm: 1 }, { name: 'Memcached: port 11211 terbuka', type: 'port', params: { port: 11211 }, confirm: 2 }]; } },
  supervisor: { label: 'Supervisor', hint: 'Program yang tidak berstatus RUNNING dianggap masalah', fields: [{ k: 'unit', label: 'Nama unit systemd', def: 'supervisor' }],
    make: function (o: Params, sudo: boolean): CheckDef[] { return [{ name: 'Supervisor: layanan aktif', type: 'systemd', params: { unit: o.unit || 'supervisor' }, confirm: 1 }, { name: 'Supervisor: program tidak berjalan', type: 'supervisor_down', params: { prefix: sudo ? 'sudo -n ' : '' }, warn: 1, crit: 3 }]; } },
  fail2ban: { label: 'Fail2ban', hint: '', fields: [],
    make: function (): CheckDef[] { return [{ name: 'Fail2ban: layanan aktif', type: 'systemd', params: { unit: 'fail2ban' }, confirm: 1 }]; } },
  postfix: { label: 'Postfix (surat keluar)', hint: '', fields: [],
    make: function (_o: Params, sudo: boolean): CheckDef[] { return [{ name: 'Postfix: layanan aktif', type: 'systemd', params: { unit: 'postfix' }, confirm: 1 }, { name: 'Postfix: antrean surat', type: 'mail_queue', params: { prefix: sudo ? 'sudo -n ' : '' }, warn: 50, crit: 200 }]; } },
  tls: { label: 'Sertifikat HTTPS', hint: 'Peringatan sebelum sertifikat kedaluwarsa. Isi nama domain persis seperti yang dipakai pengunjung', fields: [{ k: 'host', label: 'Nama domain', def: 'localhost' }, { k: 'port', label: 'Port', def: '443' }],
    make: function (o: Params): CheckDef[] { return [{ name: 'Sertifikat HTTPS: sisa hari (' + (o.host || 'localhost') + ')', type: 'cert_days', params: { host: o.host || 'localhost', port: o.port || '443' }, warn: 14, crit: 3, dir: 'lt', confirm: 1 }]; } },
  host: { label: 'Dasar server', hint: 'Inode, sinkron waktu, unit gagal, zombie, file descriptor, koneksi TCP, reboot, OOM, dan login SSH gagal', fields: [],
    make: function (_o: Params, sudo: boolean): CheckDef[] { const pre = sudo ? 'sudo -n ' : ''; return [
      { name: 'Inode root terpakai %', type: 'inode_pct', params: { path: '/' }, warn: 80, crit: 95 }, { name: 'Jam tersinkron (NTP)', type: 'ntp_sync', params: {}, confirm: 3 },
      { name: 'Unit systemd gagal', type: 'systemd_failed', params: {}, warn: 1, crit: 5 }, { name: 'Proses zombie', type: 'zombie_procs', params: {}, warn: 5, crit: 50 },
      { name: 'File descriptor terpakai %', type: 'fd_pct', params: {}, warn: 70, crit: 90 }, { name: 'Koneksi TCP terjalin', type: 'tcp_conn', params: {}, warn: 2000, crit: 5000 },
      { name: 'Server butuh reboot', type: 'reboot_required', params: {}, warn: 1, confirm: 3 }, { name: 'Proses dimatikan kernel (OOM)', type: 'oom_kills', params: { prefix: pre }, warn: 1, crit: 3, delta: 1 },
      { name: 'Login SSH gagal (10 menit)', type: 'ssh_failed', params: { prefix: pre }, warn: 20, crit: 100 }]; } },
  netdata: { label: 'Netdata (alat pihak ketiga)', hint: 'Mengambil alarm Netdata yang aktif lewat SSH (tanpa membuka port)', fields: [],
    make: function (): CheckDef[] { return [{ name: 'Netdata: layanan aktif', type: 'systemd', params: { unit: 'netdata' }, confirm: 1 }, { name: 'Netdata: alarm aktif', type: 'netdata_alarms', params: {}, confirm: 1 }]; } }
};

export function buildCommand(check: { type: string; params: Params | string }): string { const t = TYPES[check.type]; if (!t) throw new Error('Tipe pemeriksaan tidak dikenal: ' + check.type); return t.build(typeof check.params === 'string' ? JSON.parse(check.params || '{}') : (check.params || {})); }

const num = function (s: string): number | null { const m = String(s).match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const firstLine = function (s: unknown): string { return String(s || '').trim().split('\n').filter(Boolean)[0] || ''; };

// hasil perintah -> { status: ok|warn|crit|unknown, value, raw, detail }
export function evaluate(check: CheckRow, res: CmdResult): Evaluation {
  const t = TYPES[check.type], out = String(res.stdout || '').trim(), err = firstLine(res.stderr);
  const cmp = function (v: number): 'ok' | 'minor' | 'warn' | 'crit' {
    const dir = check.dir || 'gt', hit = function (th: number | null | undefined) { return th != null && (dir === 'lt' ? v <= th : v >= th); };
    return hit(check.crit) ? 'crit' : hit(check.warn) ? 'warn' : hit(check.minor) ? 'minor' : 'ok';   // warn = batas MAJOR, crit = CRITICAL
  };
  if (res.timedOut) return { status: 'unknown', value: null, raw: null, detail: 'perintah melewati batas waktu' };
  if (t.kind === 'match') { const okk = t.ok!.test(out); return { status: okk ? 'ok' : 'crit', value: okk ? 1 : 0, raw: null, detail: okk ? '' : (firstLine(out) || err || 'tidak sesuai harapan').slice(0, 200) }; }
  if (t.kind === 'http') {
    const m = out.match(/^(\d{3})\s+([\d.]+)/); if (!m) return { status: 'crit', value: null, raw: null, detail: 'tidak ada jawaban HTTP' + (err ? ': ' + err : '') };
    const code = Number(m[1]), ms = Math.round(parseFloat(m[2]) * 1000), p = typeof check.params === 'string' ? JSON.parse(check.params || '{}') : check.params || {}, lo = Number(p.minCode || 200), hi = Number(p.maxCode || 399);
    if (code < lo || code > hi) return { status: 'crit', value: ms, raw: null, detail: 'HTTP ' + code + ' (' + ms + ' ms)' };
    const s = cmp(ms); return { status: s, value: ms, raw: null, detail: s === 'ok' ? '' : 'HTTP ' + code + ' lambat: ' + ms + ' ms' };
  }
  if (t.kind === 'fpm') {
    let j: any; try { j = JSON.parse(out); } catch (e) { return { status: 'crit', value: null, raw: null, detail: 'halaman status PHP-FPM tidak terbaca (periksa URL)' }; }
    const q = Number(j['listen queue'] || 0), s = cmp(q); return { status: s, value: q, raw: null, detail: 'aktif ' + j['active processes'] + '/' + j['total processes'] + ', antrean ' + q + ', max children tercapai ' + (j['max children reached'] || 0) + 'x' };
  }
  if (t.kind === 'netdata') {
    let j: any; try { j = JSON.parse(out); } catch (e) { return { status: 'unknown', value: null, raw: null, detail: 'API Netdata tidak terbaca (apakah Netdata terpasang di 127.0.0.1:19999?)' }; }
    const al = Object.keys(j.alarms || {}).map(function (k: string) { return { n: k, s: (j.alarms[k].status || '').toUpperCase(), i: j.alarms[k].chart || '' }; }), crit = al.filter(function (a: any) { return a.s === 'CRITICAL'; }), warn = al.filter(function (a: any) { return a.s === 'WARNING'; });
    const names = function (a: any[]) { return a.slice(0, 3).map(function (x: any) { return x.n; }).join(', '); };
    return { status: crit.length ? 'crit' : warn.length ? 'warn' : 'ok', value: crit.length * 100 + warn.length, raw: null, detail: crit.length ? 'CRITICAL: ' + names(crit) : warn.length ? 'WARNING: ' + names(warn) : '' };
  }
  // number: perintah yang gagal (exit bukan 0) bukan pengukuran. Angka di pesan galatnya (mis. 1045, 5432) tidak boleh dibaca sebagai nilai.
  if (res.exitCode !== 0) return { status: 'unknown', value: null, raw: null, detail: (err || firstLine(out) || `perintah gagal (exit ${res.exitCode})`).slice(0, 200) };
  let v = num(out);
  if (v == null) return { status: 'unknown', value: null, raw: null, detail: (err || firstLine(out) || 'tidak ada angka pada keluaran').slice(0, 200) };
  const raw = v; if (check.delta) { v = check.last_raw == null ? 0 : (raw >= check.last_raw ? raw - check.last_raw : raw); }
  const s = cmp(v); return { status: s, value: v, raw: raw, detail: s === 'ok' ? '' : 'nilai ' + v + (check.dir === 'lt' ? ' (batas bawah ' : ' (batas ') + (s === 'crit' ? check.crit : s === 'warn' ? check.warn : check.minor) + ')' };
}

// satu skrip untuk semua pemeriksaan satu server: satu koneksi SSH, tiap perintah dibatasi waktu 15 detik
export function batchScript(checks: Array<{ id: number; type: string; params: Params | string }>): string {
  return checks.map(function (c: any) {
    let cmd: string; try { cmd = buildCommand(c); } catch (e: any) { return 'echo "@@BEGIN ' + c.id + '"; echo "perintah tidak valid: ' + String(e.message).replace(/["$`\\]/g, '') + '"; echo "@@EXIT ' + c.id + ' 2"'; }
    return 'o=$(timeout 15 sh -c \'' + cmd.replace(/'/g, "'\\''") + '\' 2>&1); r=$?; echo "@@BEGIN ' + c.id + '"; printf \'%s\\n\' "$o" | head -c 4000; echo "@@EXIT ' + c.id + ' $r"';
  }).join('; ');
}
export function parseBatch(out: string): Record<string, CmdResult> {
  const res: Record<string, CmdResult> = {}; let cur: string | null = null, buf: string[] = [];
  String(out).split('\n').forEach(function (l: string) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^@@BEGIN (\d+)$/))) { cur = m[1]!; buf = []; }
    else if ((m = l.match(/^@@EXIT (\d+) (\d+)$/))) { if (cur === m[1]) res[cur] = { exitCode: Number(m[2]), stdout: buf.join('\n'), stderr: '', timedOut: Number(m[2]) === 124 }; cur = null; }
    else if (cur) buf.push(l);
  });
  return res;
}

// deteksi layanan: perintah baca + saran paket
export const DISCOVER = "systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print \"unit=\"$1}'; ss -ltnH 2>/dev/null | awk '{print \"listen=\"$4}'; command -v docker >/dev/null 2>&1 && echo cmd=docker; ls /var/log/ 2>/dev/null | grep -E '^php[0-9.]+-fpm.log$' | sed 's/^/fpmlog=/'";
export function suggest(out: string): Record<string, Params> {
  const units: string[] = [], found: Record<string, Params> = {}, fpmLogs: string[] = [], ports = new Set<number>();
  String(out).split('\n').forEach(function (l: string) { let m: RegExpMatchArray | null; if ((m = l.match(/^unit=(.+)$/))) units.push(m[1]!.replace(/\.service$/, '')); else if ((m = l.match(/^fpmlog=(.+)$/))) fpmLogs.push(m[1]!); else if ((m = l.match(/^listen=.*:(\d+)$/))) ports.add(Number(m[1])); });
  const pick = function (re: RegExp) { return units.find(function (u) { return re.test(u); }); };
  let u: string | undefined;
  if ((u = pick(/^(mysql|mysqld|mariadb)$/))) found.mysql = { unit: u }; if ((u = pick(/^postgresql(@.*)?$/))) found.postgres = { unit: u }; if ((u = pick(/^redis(-server)?$/))) found.redis = { unit: u };
  if (pick(/^nginx$/)) found.nginx = {}; if ((u = pick(/^php[0-9.]*-fpm$/))) found.phpfpm = { unit: u, log: '/var/log/' + (fpmLogs[0] || u + '.log') };
  if (pick(/^(apache2|httpd)$/)) found.apache = { unit: pick(/^(apache2|httpd)$/) }; if (pick(/^caddy$/)) found.caddy = {}; if (pick(/^haproxy$/)) found.haproxy = {}; if (pick(/^mongod$/)) found.mongodb = { unit: 'mongod' }; if (pick(/^rabbitmq-server$/)) found.rabbitmq = { unit: 'rabbitmq-server' };
  if (pick(/^elasticsearch$/)) found.elasticsearch = { unit: 'elasticsearch' }; if (pick(/^memcached$/)) found.memcached = {}; if (pick(/^supervisor(d)?$/)) found.supervisor = { unit: pick(/^supervisor(d)?$/) }; if (pick(/^fail2ban$/)) found.fail2ban = {}; if (pick(/^postfix(@.*)?$/)) found.postfix = {};
  if (ports.has(443)) found.tls = {};
  if (pick(/^docker$/)) found.docker = {}; if (pick(/^netdata$/)) found.netdata = {}; found.host = {};
  return found;
}

/** Urutan ambang yang tidak masuk akal; null bila benar. Batas harus makin parah: minor, lalu warn (= major), lalu crit (= critical). */
export function orderProblem(dir: string, warn: number | null, crit: number | null, minor: number | null = null): string | null {
  const steps: Array<[string, number | null]> = [['minor', minor], ['major', warn], ['critical', crit]], set = steps.filter((x) => x[1] != null) as Array<[string, number]>;
  for (let i = 1; i < set.length; i++) {
    const [pn, pv] = set[i - 1]!, [cn, cv] = set[i]!;
    if (dir === 'lt' ? cv > pv : cv < pv) return dir === 'lt' ? `Batas ${cn} harus sama atau lebih rendah dari batas ${pn} (bahaya bila nilai turun)` : `Batas ${cn} harus sama atau lebih tinggi dari batas ${pn}`;
  }
  return null;
}

// parameter yang diisi pengguna per tipe (untuk formulir)
const TYPE_FIELDS: Record<string, string[]> = { systemd: ['unit'], port: ['port'], http: ['url'], mysql_ping: ['prefix'], mysql_conn_pct: ['prefix'], mysql_longq: ['prefix', 'sec'], mysql_commitwait: ['prefix'], mysql_lockwait: ['prefix'], mysql_aborted: ['prefix'], mysql_sql: ['prefix', 'db', 'sql'],
  pg_conn_pct: ['prefix'], pg_longq: ['prefix', 'sec'], pg_idle_tx: ['prefix'], redis_ping: [], redis_mem_mb: [], redis_clients: [], nginx_conf: ['prefix'], fpm_status: ['url'], log_count: ['prefix', 'pattern', 'path'], disk_pct: ['path'], inode_pct: ['path'],
  docker_running: ['name'], pg_ping: [], redis_rdb_health: [], redis_evicted: [], apache_conf: ['prefix'], haproxy_conf: ['prefix'], mongo_ping: [], mongo_conn: [], rabbit_ping: ['prefix'], rabbit_msgs: ['prefix'], es_status: [], supervisor_down: ['prefix'], mail_queue: ['prefix'], docker_bad_count: ['prefix'], cert_days: ['host', 'port'], systemd_failed: [], zombie_procs: [], reboot_required: [], fd_pct: [], oom_kills: ['prefix'], tcp_conn: [], ssh_failed: ['prefix'], proc_count: ['pattern'], ntp_sync: [], udp_port: ['port'], netdata_alarms: [], custom: ['command'] };
export function meta() {
  return { types: Object.keys(TYPES).map(function (k) { return { id: k, label: TYPES[k]!.label, fields: TYPE_FIELDS[k] || [] }; }), packs: Object.keys(PACKS).map(function (k) { return { id: k, label: PACKS[k]!.label, hint: PACKS[k]!.hint, fields: PACKS[k]!.fields }; }) };
}

