// Membaca berkas infrastruktur: docker-compose, Dockerfile, nginx, Kubernetes, Procfile, pm2, gunicorn, php-fpm.
// Hasilnya dipakai untuk mengisi jumlah worker/replika/timeout yang tidak bisa disimpulkan dari kode aplikasi.
const path = require('path');
const S = require('./scan.js');

const IMAGE_KIND = [
  [/postgres|timescale|postgis/i, ['db', 'postgres']], [/mysql|mariadb|percona/i, ['db', 'mysql']], [/mongo/i, ['db', 'mongo']], [/mssql|sqlserver/i, ['db', 'mssql']],
  [/redis|valkey|keydb/i, ['cache', 'redis']], [/memcached/i, ['cache', 'memcached']], [/rabbitmq/i, ['queue', 'rabbit']], [/kafka|redpanda/i, ['queue', 'kafka']], [/nats/i, ['queue', 'nats']],
  [/nginx|traefik|caddy|haproxy|envoy/i, ['proxy', 'proxy']], [/elasticsearch|opensearch/i, ['search', 'elastic']], [/minio/i, ['storage', 'minio']]
];
function kindOfImage(img) { for (const e of IMAGE_KIND) if (e[0].test(img)) return e[1]; return null; }

function parseCompose(root, file) {
  const out = [], lines = S.read(file).split(/\r?\n/); let inServices = false, cur = null;
  lines.forEach(function (ln) {
    if (/^services:\s*$/.test(ln)) { inServices = true; return; }
    if (inServices && /^\S/.test(ln) && !/^services:/.test(ln)) inServices = false;
    if (!inServices) return;
    const m = ln.match(/^  ([A-Za-z0-9_.-]+):\s*$/); if (m) { cur = { name: m[1], image: null, command: null, replicas: null, cpus: null, mem: null, build: false }; out.push(cur); return; }
    if (!cur) return;
    let k;
    if ((k = ln.match(/^\s+image:\s*["']?([^"'\s#]+)/))) cur.image = k[1];
    else if (/^\s+build:/.test(ln)) cur.build = true;
    else if ((k = ln.match(/^\s+command:\s*(.+)$/))) cur.command = k[1].replace(/["'\[\]]/g, '').trim();
    else if ((k = ln.match(/^\s+replicas:\s*(\d+)/))) cur.replicas = Number(k[1]);
    else if ((k = ln.match(/^\s+cpus:\s*["']?([\d.]+)/))) cur.cpus = Number(k[1]);
    else if ((k = ln.match(/^\s+(?:mem_limit|memory):\s*["']?([0-9a-zA-Z.]+)/))) cur.mem = k[1];
  });
  out.forEach(function (c) { const k = c.image ? kindOfImage(c.image) : null; c.role = k ? k[0] : 'app'; c.kind = k ? k[1] : null; });
  return out;
}

function parseNginx(root, file) {
  const t = S.read(file), o = { file: S.rel(root, file) }; let m;
  if ((m = t.match(/proxy_read_timeout\s+(\d+)(s|m)?/))) o.timeoutS = Number(m[1]) * (m[2] === 'm' ? 60 : 1);
  else if ((m = t.match(/fastcgi_read_timeout\s+(\d+)(s|m)?/))) o.timeoutS = Number(m[1]) * (m[2] === 'm' ? 60 : 1);
  if ((m = t.match(/worker_connections\s+(\d+)/))) o.workerConnections = Number(m[1]);
  if (/limit_req_zone|limit_conn_zone/.test(t)) o.rateLimit = true;
  o.upstreams = (t.match(/^\s*upstream\s+\S+/gm) || []).length;
  return o;
}

function commandHints(cmd) {
  const h = {}; if (!cmd) return h; let m;
  if ((m = cmd.match(/gunicorn[^\n]*?(?:-w|--workers)[ =](\d+)/))) h.gunicornWorkers = Number(m[1]);
  if ((m = cmd.match(/(?:--threads)[ =](\d+)/))) h.threads = Number(m[1]);
  if (/gunicorn/.test(cmd)) h.server = 'gunicorn';
  if ((m = cmd.match(/-k[ =]([\w.]+)/))) h.workerClass = m[1];
  if (/uvicorn|hypercorn|daphne/.test(cmd)) { h.server = 'uvicorn'; if ((m = cmd.match(/--workers[ =](\d+)/))) h.gunicornWorkers = Number(m[1]); }
  if ((m = cmd.match(/pm2(?:-runtime)?[^\n]*(?:-i|--instances)[ =](\w+)/))) h.pm2 = m[1] === 'max' ? 'max' : Number(m[1]);
  if (/puma/.test(cmd)) { h.server = 'puma'; if ((m = cmd.match(/-w[ =]?(\d+)/))) h.pumaWorkers = Number(m[1]); if ((m = cmd.match(/-t[ =]?(\d+):(\d+)/))) h.pumaThreads = Number(m[2]); }
  if (/java\s+.*-jar|\bjava\b/.test(cmd)) h.java = true;
  if (/php-fpm|php artisan serve/.test(cmd)) h.php = true;
  if (/celery[^\n]*worker/.test(cmd) && (m = cmd.match(/(?:-c|--concurrency)[ =](\d+)/))) h.celeryConcurrency = Number(m[1]);
  return h;
}

function scanInfra(root) {
  const o = { evidence: [], services: [], proxy: null, hints: {}, replicas: null, cpus: null };
  const merge = function (h) { Object.keys(h).forEach(function (k) { if (o.hints[k] == null) o.hints[k] = h[k]; }); };
  const yml = S.walk(root, ['.yml', '.yaml'], { depth: 4, max: 400 });
  yml.forEach(function (f) {
    const base = path.basename(f);
    if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)) { o.evidence.push(S.rel(root, f)); parseCompose(root, f).forEach(function (s) { o.services.push(s); if (s.command) merge(commandHints(s.command)); if (s.replicas) o.replicas = Math.max(o.replicas || 0, s.replicas); if (s.cpus) o.cpus = s.cpus; if (s.role === 'proxy') o.proxy = o.proxy || { kind: s.kind, file: S.rel(root, f) }; }); }
    else { const t = S.read(f); if (/^kind:\s*(Deployment|StatefulSet|HorizontalPodAutoscaler|Ingress)\b/m.test(t)) {
      o.evidence.push(S.rel(root, f)); let m;
      if ((m = t.match(/^\s*replicas:\s*(\d+)/m))) o.replicas = Math.max(o.replicas || 0, Number(m[1]));
      if ((m = t.match(/^\s*maxReplicas:\s*(\d+)/m))) o.replicas = Math.max(o.replicas || 0, Number(m[1]));
      if ((m = t.match(/^\s*cpu:\s*["']?(\d+)(m)?/m))) o.cpus = m[2] ? Number(m[1]) / 1000 : Number(m[1]);
      if (/kind:\s*Ingress/.test(t)) { o.proxy = o.proxy || { kind: 'ingress', file: S.rel(root, f) }; if ((m = t.match(/proxy-read-timeout:\s*["']?(\d+)/))) o.proxy.timeoutS = Number(m[1]); }
    } }
  });
  S.walk(root, ['.conf'], { depth: 5, max: 200 }).forEach(function (f) {
    const t = S.read(f); if (!/\b(server|upstream|http)\s*\{/.test(t) || !/(proxy_pass|fastcgi_pass|listen\s+\d)/.test(t)) return;
    const ng = parseNginx(root, f); o.evidence.push(ng.file); o.proxy = Object.assign({ kind: 'nginx' }, o.proxy || {}, ng);
  });
  const procfile = path.join(root, 'Procfile'); if (S.exists(procfile)) { o.evidence.push('Procfile'); S.read(procfile).split(/\r?\n/).forEach(function (l) { merge(commandHints(l)); }); }
  S.walk(root, ['Dockerfile', '.dockerfile'], { depth: 4, max: 60 }).forEach(function (f) { o.evidence.push(S.rel(root, f)); S.read(f).split(/\r?\n/).forEach(function (l) { if (/^\s*(CMD|ENTRYPOINT)\b/i.test(l)) merge(commandHints(l)); }); });
  // Dockerfile tanpa ekstensi
  ['Dockerfile'].forEach(function (n) { const f = path.join(root, n); if (S.exists(f) && o.evidence.indexOf(n) < 0) { o.evidence.push(n); S.read(f).split(/\r?\n/).forEach(function (l) { if (/^\s*(CMD|ENTRYPOINT)\b/i.test(l)) merge(commandHints(l)); }); } });
  const pm2 = S.walk(root, ['.config.js', '.config.cjs', '.config.json'], { depth: 2, max: 40 }).filter(function (f) { return /ecosystem/.test(f); })[0];
  if (pm2) { const t = S.read(pm2); o.evidence.push(S.rel(root, pm2)); const m = t.match(/instances\s*:\s*['"]?(\w+)/); if (m) o.hints.pm2 = m[1] === 'max' ? 'max' : Number(m[1]); }
  const gconf = S.walk(root, ['.py'], { depth: 2, max: 300 }).filter(function (f) { return /gunicorn[._-]?conf|gunicorn\.py/.test(f); })[0];
  if (gconf) { const t = S.read(gconf); o.evidence.push(S.rel(root, gconf)); let m; if ((m = t.match(/^\s*workers\s*=\s*(\d+)/m))) o.hints.gunicornWorkers = Number(m[1]); if ((m = t.match(/^\s*threads\s*=\s*(\d+)/m))) o.hints.threads = Number(m[1]); if ((m = t.match(/^\s*worker_class\s*=\s*['"]([\w.]+)/m))) o.hints.workerClass = m[1]; o.hints.server = 'gunicorn'; }
  S.walk(root, ['.conf'], { depth: 5, max: 200 }).forEach(function (f) { const t = S.read(f); const m = t.match(/pm\.max_children\s*=\s*(\d+)/); if (m) { o.hints.phpMaxChildren = Number(m[1]); o.evidence.push(S.rel(root, f)); } });
  return o;
}

module.exports = { scanInfra: scanInfra, kindOfImage: kindOfImage, commandHints: commandHints };
