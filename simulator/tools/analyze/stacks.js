// Detektor tumpukan: mengubah satu folder proyek (unit) menjadi "fakta standar" yang tidak bergantung bahasa.
// Fakta: { stack, name, dir, model, workers, cores, dbs[], caches[], queues[], external[], routes, cron, smells[], assumptions[] }
const path = require('path');
const S = require('./scan.js');

const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'manage.py', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'Gemfile', 'composer.json'];
function hasCsproj(dir) { return S.ls(dir).some(function (n) { return /\.(csproj|sln)$/.test(n); }); }
function hasManifest(dir) { return MANIFESTS.some(function (m) { return S.exists(path.join(dir, m)); }) || hasCsproj(dir); }

// unit = root dan subfolder yang punya manifes (monorepo: backend/ frontend/ services/*)
function findUnits(root) {
  const units = [], seen = {};
  const add = function (d) { if (!seen[d] && hasManifest(d)) { seen[d] = 1; units.push(d); } };
  add(root);
  S.ls(root).forEach(function (n) {
    const d = path.join(root, n); if (S.SKIP.has(n) || n[0] === '.') return;
    let isDir = false; try { isDir = require('fs').statSync(d).isDirectory(); } catch (e) { return; }
    if (!isDir) return;
    add(d);
    if (/^(apps|services|packages|src|server|backend|api)$/i.test(n)) S.ls(d).forEach(function (m) { const dd = path.join(d, m); if (!S.SKIP.has(m) && m[0] !== '.') add(dd); });
  });
  return units;
}

const HTTP_HOST = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;
const IGNORE_HOST = /(w3\.org|example\.(com|org)|schema\.org|localhost|github\.com|githubusercontent|googleapis\.com\/auth|gstatic|npmjs|nuget\.org|apache\.org|microsoft\.com\/|xmlsoap|swagger|json-schema|mozilla|opensource|creativecommons|fonts\.|cdn\.|lvh\.me|hl7\.org|nip\.io|sslip\.io|sentry\.io|tailwindcss|wikipedia|loc\.gov|iana\.org|ietf\.org|ncbi\.|who\.int)/i;
function parentDomain(h) { const p = h.toLowerCase().split('.'); return p.slice(-2).join('.'); }
function collectExternal(root, files, callRe) {
  const out = {};
  files.forEach(function (f) {
    const t = S.read(f); if (!callRe.test(t)) return;
    let m; HTTP_HOST.lastIndex = 0;
    while ((m = HTTP_HOST.exec(t))) { if (IGNORE_HOST.test(m[0])) continue; const d = parentDomain(m[1]); (out[d] = out[d] || []).push(S.rel(root, f)); }
  });
  return Object.keys(out).sort(function (a, b) { return out[b].length - out[a].length; }).slice(0, 3).map(function (h) { return { host: h, files: out[h].slice(0, 3) }; });
}

function pushDb(f, kind, extra) { if (!f.dbs.some(function (d) { return d.kind === kind; })) f.dbs.push(Object.assign({ kind: kind, poolSize: null, evidence: [] }, extra || {})); }
function pushCache(f, kind) { if (f.caches.indexOf(kind) < 0) f.caches.push(kind); }
function pushQueue(f, kind, extra) { if (!f.queues.some(function (q) { return q.kind === kind; })) f.queues.push(Object.assign({ kind: kind, concurrency: null }, extra || {})); }
function newFacts(unit, root, stack, name) { return { stack: stack, name: name, dir: S.rel(root, unit) || '.', model: 'threads', workers: null, cores: null, dbs: [], caches: [], queues: [], external: [], routes: 0, cron: false, smells: [], assumptions: [], evidence: [] }; }
function smell(f, id, text, ev) { f.smells.push({ id: id, text: text, evidence: ev || [] }); }

const DB_WORDS = [[/\b(pg|psycopg2?|asyncpg|pgx|lib\/pq|npgsql|postgres(ql)?)\b/i, 'postgres'], [/\b(mysql2?|mysqlclient|pymysql|go-sql-driver\/mysql|mysql-connector|mariadb)\b/i, 'mysql'],
  [/\b(mongoose|mongodb|pymongo|motor|mongo-driver|mongoid)\b/i, 'mongo'], [/\b(better-sqlite3|sqlite3|aiosqlite|sqlite)\b/i, 'sqlite'], [/\b(mssql|tedious|pyodbc|sqlserver|SqlClient)\b/i, 'mssql'], [/\boracle\b/i, 'oracle']];
const CACHE_WORDS = [[/\b(ioredis|redis|go-redis|redis-py|aioredis|StackExchange\.Redis|lettuce|jedis|spring-boot-starter-data-redis)\b/i, 'redis'], [/\b(memcached|pymemcache)\b/i, 'memcached']];
const QUEUE_WORDS = [[/\b(bullmq|bull)\b/i, 'bull'], [/\bcelery\b/i, 'celery'], [/\bsidekiq\b/i, 'sidekiq'], [/\b(amqplib|pika|rabbitmq|spring-boot-starter-amqp)\b/i, 'rabbit'], [/\b(kafkajs|confluent-kafka|kafka-python|spring-kafka|sarama|segmentio\/kafka)\b/i, 'kafka'],
  [/\b(hangfire|MassTransit)\b/i, 'dotnet-jobs'], [/\b(bee-queue|agenda|rq)\b/i, 'jobs'], [/\bresque|delayed_job\b/i, 'jobs']];
function scanWords(f, text) {
  DB_WORDS.forEach(function (e) { if (e[0].test(text)) pushDb(f, e[1]); });
  CACHE_WORDS.forEach(function (e) { if (e[0].test(text)) pushCache(f, e[1]); });
  QUEUE_WORDS.forEach(function (e) { if (e[0].test(text)) pushQueue(f, e[1]); });
}
function dbFromUrls(f, env) {
  Object.keys(env.urls).forEach(function (k) {
    const sc = env.urls[k].scheme;
    if (/^postgres/.test(sc)) pushDb(f, 'postgres'); else if (/^mysql|mariadb/.test(sc)) pushDb(f, 'mysql'); else if (/^mongodb/.test(sc)) pushDb(f, 'mongo'); else if (/^redis/.test(sc)) pushCache(f, 'redis');
    else if (/^amqp/.test(sc)) pushQueue(f, 'rabbit'); else if (/^sqlite|^file/.test(sc)) pushDb(f, 'sqlite');
    if (env.urls[k].where === 'jarak-jauh' && /^(postgres|mysql|mongodb|mariadb)/.test(sc)) { const d = f.dbs.find(function (x) { return x.kind.indexOf(sc.replace('mariadb', 'mysql').replace('postgresql', 'postgres')) === 0; }); if (d) d.remote = true; }
  });
  const dc = env.values.DB_CONNECTION; if (dc) pushDb(f, dc === 'pgsql' ? 'postgres' : dc);
}
function setPool(f, n, ev) { if (n && f.dbs.length) { f.dbs.forEach(function (d) { if (d.poolSize == null) { d.poolSize = n; d.evidence.push(ev); } }); } }

// ---------------- Node.js
function nodeUnit(unit, root, infra) {
  const j = S.readJson(path.join(unit, 'package.json')) || {}, d = Object.assign({}, j.dependencies, j.devDependencies), names = Object.keys(d).join(' ');
  const server = ['express', 'fastify', '@nestjs/core', 'koa', 'hono', '@hapi/hapi', 'restify', 'next', 'nuxt', 'sails', 'adonis', '@adonisjs/core', 'socket.io', 'ws'].filter(function (k) { return d[k]; });
  const front = ['react', 'vue', 'svelte', 'vite', '@angular/core', 'solid-js', 'preact'].filter(function (k) { return d[k]; });
  if (!server.length) { if (front.length) { const f0 = newFacts(unit, root, 'frontend', 'Frontend (' + front[0] + ')'); f0.frontend = true; return f0; } return null; }
  const f = newFacts(unit, root, 'node', 'Node.js (' + server[0] + ')'); f.model = 'event-loop';
  scanWords(f, names); if (d.prisma || d['@prisma/client']) { const sc = S.read(path.join(unit, 'prisma', 'schema.prisma')); const m = sc.match(/provider\s*=\s*"(\w+)"/); if (m) pushDb(f, m[1] === 'postgresql' ? 'postgres' : m[1]); else pushDb(f, 'sql'); f.orm = 'prisma'; }
  if (d.typeorm || d.sequelize || d.knex || d['drizzle-orm']) f.orm = f.orm || (d.typeorm ? 'typeorm' : d.sequelize ? 'sequelize' : d.knex ? 'knex' : 'drizzle');
  const files = S.walk(unit, ['.js', '.ts', '.mjs', '.cjs', '.tsx'], { max: 1500, depth: 7 });
  dbFromUrls(f, S.parseEnv(unit));
  f.routes = S.count(files, /\b(app|router|fastify|server)\.(get|post|put|patch|delete|all)\s*\(|@(Get|Post|Put|Patch|Delete)\s*\(/g);
  f.external = collectExternal(root, files, /\b(fetch|axios|got|undici|request|HttpService|http\.request)\b/);
  f.cron = !!(d['node-cron'] || d.cron || d['@nestjs/schedule'] || d.agenda || S.any(files, /setInterval\s*\(/));
  const pool = S.grep(root, files, /(max|connectionLimit|connection_limit)\s*[:=]\s*(\d+)/, 6).filter(function (g) { return /pool|pg|mysql|sequelize|knex|connection/i.test(g.text) || true; });
  const pm = pool.map(function (g) { return { n: Number((g.text.match(/(?:max|connectionLimit|connection_limit)\s*[:=]\s*(\d+)/) || [])[1]), g: g }; }).filter(function (x) { return x.n > 0 && x.n < 1000; })[0];
  if (pm) setPool(f, pm.n, pm.g.file + ':' + pm.g.line);
  else if (f.dbs.length) { setPool(f, f.orm === 'prisma' ? 9 : 10, 'default driver'); f.assumptions.push('Pool koneksi database memakai default driver (sekitar 10)'); }
  if (/connection_limit=(\d+)/.test(S.read(path.join(unit, '.env')) + S.read(path.join(unit, '.env.example')))) setPool(f, Number(RegExp.$1), '.env connection_limit');
  const syncHits = S.grep(root, files.filter(function (p) { return !/(script|seed|migrat|config|test|spec)/i.test(p); }), /(readFileSync|writeFileSync|pbkdf2Sync|bcrypt\.hashSync|bcrypt\.compareSync|execSync|scryptSync)\(/, 4);
  if (syncHits.length) smell(f, 'event-loop-block', 'Pemanggilan sinkron (' + syncHits.length + '+ lokasi) memblok event loop; semua request ikut tertahan selama panggilan itu.', syncHits.map(function (h) { return h.file + ':' + h.line; }));
  const noTo = S.grep(root, files, /\b(fetch|axios\.(get|post|put|delete))\s*\(/, 40).filter(function (h) { return !/timeout|signal|AbortSignal/.test(h.text); });
  if (noTo.length && f.external.length) f.noTimeout = true;
  if (infra.hints.pm2 != null) { f.workers = infra.hints.pm2 === 'max' ? null : infra.hints.pm2; f.cores = f.workers; f.evidence.push('pm2 instances=' + infra.hints.pm2); }
  else f.assumptions.push('Node berjalan 1 proses (satu core untuk JavaScript); isi pm2/cluster bila dipakai');
  return f;
}

// ---------------- Python
function pythonUnit(unit, root, infra) {
  const text = ['requirements.txt', 'pyproject.toml', 'Pipfile'].map(function (n) { return S.read(path.join(unit, n)); }).join('\n').toLowerCase();
  const reqDir = S.walk(unit, ['.txt'], { depth: 2, max: 20 }).filter(function (p) { return /requirements/.test(p); }).map(S.read).join('\n').toLowerCase();
  const all = text + '\n' + reqDir, isDj = S.exists(path.join(unit, 'manage.py')) || /\bdjango\b/.test(all);
  const fw = isDj ? 'django' : /\bfastapi\b/.test(all) ? 'fastapi' : /\bflask\b/.test(all) ? 'flask' : /\b(aiohttp|sanic|starlette|tornado|quart)\b/.test(all) ? 'async' : null;
  if (!fw && !/celery/.test(all)) return null;
  const f = newFacts(unit, root, 'python', 'Python (' + (fw || 'worker') + ')');
  const asyncFw = fw === 'fastapi' || fw === 'async';
  f.model = asyncFw ? 'event-loop' : 'processes';
  scanWords(f, all); if (/\bsqlalchemy\b/.test(all)) f.orm = 'sqlalchemy'; if (isDj) f.orm = 'django-orm';
  const files = S.walk(unit, ['.py'], { max: 1500, depth: 7 });
  dbFromUrls(f, S.parseEnv(unit));
  f.routes = S.count(files, /@(app|router|bp|blueprint|api)\.(get|post|put|patch|delete|route)\s*\(|\bpath\s*\(\s*['"]|\bre_path\s*\(|\burl\s*\(\s*r?['"]/g);
  f.external = collectExternal(root, files, /\b(requests|httpx|aiohttp|urllib3?)\b/);
  f.cron = /celery[-_]beat|apscheduler|schedule\b/.test(all) || S.any(files, /beat_schedule|crontab\(/);
  const h = infra.hints;
  if (h.gunicornWorkers) { f.workers = h.gunicornWorkers * (h.threads || 1); f.cores = h.gunicornWorkers; f.evidence.push('gunicorn workers=' + h.gunicornWorkers + (h.threads ? ' threads=' + h.threads : '')); }
  else f.assumptions.push('Jumlah worker WSGI/ASGI tidak ditemukan; diasumsikan ' + (asyncFw ? '1 proses async' : '4 worker sync'));
  if (h.celeryConcurrency) { const q = f.queues.find(function (x) { return x.kind === 'celery'; }); if (q) q.concurrency = h.celeryConcurrency; }
  const pm = S.grep(root, files, /(pool_size|max_overflow|CONN_MAX_AGE)\s*[=:]\s*(\d+)/, 4);
  pm.forEach(function (g) { const m = g.text.match(/pool_size\s*[=:]\s*(\d+)/); if (m) setPool(f, Number(m[1]), g.file + ':' + g.line); });
  if (isDj && !S.any(files, /CONN_MAX_AGE\s*[=:]\s*(?!0\b)\d+/)) smell(f, 'django-conn-age', 'Django membuka koneksi database baru di setiap request (CONN_MAX_AGE belum diatur); tiap request membayar handshake dan beban koneksi.', []);
  if (asyncFw) { const blk = S.grep(root, files, /\btime\.sleep\(|\brequests\.(get|post|put)\(/, 3); if (blk.length) smell(f, 'event-loop-block', 'Panggilan sinkron (time.sleep/requests) di aplikasi async memblok event loop.', blk.map(function (x) { return x.file + ':' + x.line; })); }
  const noTo = S.grep(root, files, /\brequests\.(get|post|put|delete|patch)\(/, 40).filter(function (x) { return !/timeout/.test(x.text); });
  if (noTo.length && f.external.length) f.noTimeout = true;
  return f;
}

// ---------------- Java / Kotlin
function javaUnit(unit, root, infra) {
  const build = S.read(path.join(unit, 'pom.xml')) + S.read(path.join(unit, 'build.gradle')) + S.read(path.join(unit, 'build.gradle.kts'));
  const spring = /spring-boot/.test(build), quarkus = /quarkus/.test(build), micronaut = /micronaut/.test(build);
  const f = newFacts(unit, root, 'java', spring ? 'Java (Spring Boot)' : quarkus ? 'Java (Quarkus)' : micronaut ? 'Java (Micronaut)' : 'Java');
  scanWords(f, build); if (/spring-boot-starter-data-jpa|hibernate/.test(build)) f.orm = 'jpa';
  const props = S.walk(unit, ['.properties', '.yml', '.yaml'], { depth: 6, max: 40 }).filter(function (p) { return /application|bootstrap/.test(path.basename(p)); });
  const ptext = props.map(S.read).join('\n');
  scanWords(f, ptext); f.model = 'threads';
  let m;
  if ((m = ptext.match(/maximum-pool-size[=:]\s*(\d+)/))) setPool(f, Number(m[1]), 'application: maximum-pool-size'); else if (f.dbs.length) { setPool(f, 10, 'default HikariCP (10)'); f.assumptions.push('Pool koneksi memakai default HikariCP = 10'); }
  if ((m = ptext.match(/threads\.max[=:]\s*(\d+)/))) { f.workers = Number(m[1]); f.evidence.push('server.tomcat.threads.max=' + m[1]); } else { f.workers = 200; f.assumptions.push('Thread Tomcat default = 200'); }
  const files = S.walk(unit, ['.java', '.kt'], { max: 1500, depth: 10 });
  f.routes = S.count(files, /@(Get|Post|Put|Patch|Delete|Request)Mapping|@(GET|POST|PUT|DELETE|Path)\b/g);
  f.external = collectExternal(root, files, /RestTemplate|WebClient|HttpClient|RestClient|OkHttp|Feign|URL\(/);
  f.cron = S.any(files, /@Scheduled|@EnableScheduling|Quartz/);
  if (f.external.length && S.any(files, /new RestTemplate\(\)/) && !S.any(files, /setConnectTimeout|setReadTimeout|readTimeout|responseTimeout/)) f.noTimeout = true;
  if (S.any(files, /spring\.jpa\.open-in-view|OpenEntityManagerInView/) === false && spring && f.orm === 'jpa' && !/open-in-view\s*[=:]\s*false/.test(ptext)) smell(f, 'open-in-view', 'Spring open-in-view aktif (default): koneksi database ditahan sepanjang request, termasuk saat memanggil layanan luar.', []);
  return f;
}

// ---------------- Go
function goUnit(unit, root, infra) {
  const mod = S.read(path.join(unit, 'go.mod')), f = newFacts(unit, root, 'go', 'Go' + (/gin-gonic/.test(mod) ? ' (gin)' : /labstack\/echo/.test(mod) ? ' (echo)' : /gofiber/.test(mod) ? ' (fiber)' : /go-chi/.test(mod) ? ' (chi)' : ''));
  f.model = 'event-loop'; scanWords(f, mod); if (/gorm/.test(mod)) f.orm = 'gorm';
  const files = S.walk(unit, ['.go'], { max: 1500, depth: 9 });
  dbFromUrls(f, S.parseEnv(unit));
  f.routes = S.count(files, /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Delete|HandleFunc|Handle)\s*\(\s*"/g);
  f.external = collectExternal(root, files, /http\.(Get|Post|NewRequest|Client)|resty|http\.DefaultClient/);
  f.cron = S.any(files, /robfig\/cron|time\.NewTicker/);
  const mo = S.grep(root, files, /SetMaxOpenConns\((\d+)\)/, 1)[0];
  if (mo) setPool(f, Number(mo.text.match(/\((\d+)\)/)[1]), mo.file + ':' + mo.line);
  else if (f.dbs.length && S.any(files, /sql\.Open|gorm\.Open|pgxpool/)) smell(f, 'go-unbounded-pool', 'database/sql tanpa SetMaxOpenConns: jumlah koneksi tak terbatas, mudah menghabiskan max_connections saat beban naik.', []);
  const dc = S.grep(root, files, /http\.(Get|Post)\(|http\.Client\{\s*\}/, 6);
  if (dc.length && f.external.length) { f.noTimeout = true; smell(f, 'go-http-no-timeout', 'http.Get/http.Client{} memakai klien tanpa timeout; layanan luar yang macet menahan goroutine selamanya.', dc.map(function (x) { return x.file + ':' + x.line; })); }
  f.assumptions.push('Jumlah core CPU tidak dibaca dari kode (GOMAXPROCS); isi saat mengubah arsitektur');
  return f;
}

// ---------------- Ruby
function rubyUnit(unit, root, infra) {
  const g = S.read(path.join(unit, 'Gemfile')), f = newFacts(unit, root, 'ruby', /\brails\b/.test(g) ? 'Ruby on Rails' : 'Ruby (' + (/sinatra/.test(g) ? 'Sinatra' : 'rack') + ')');
  f.model = 'processes'; scanWords(f, g);
  if (/\bpg\b/.test(g)) pushDb(f, 'postgres'); if (/\bmysql2\b/.test(g)) pushDb(f, 'mysql');
  const db = S.read(path.join(unit, 'config', 'database.yml')), puma = S.read(path.join(unit, 'config', 'puma.rb')); let m;
  const pool = (m = db.match(/pool:\s*(?:<%=.*?\|\|\s*)?(\d+)/)) ? Number(m[1]) : (f.dbs.length ? 5 : null);
  if (pool) setPool(f, pool, 'config/database.yml pool');
  const threads = (m = puma.match(/threads\s+\d+\s*,\s*(\d+)/)) ? Number(m[1]) : (m = puma.match(/RAILS_MAX_THREADS.*?(\d+)/)) ? Number(m[1]) : (infra.hints.pumaThreads || 5);
  const wk = (m = puma.match(/workers\s+(?:ENV\.fetch\([^,]+,\s*)?(\d+)/)) ? Number(m[1]) : (infra.hints.pumaWorkers || 1);
  f.workers = wk * threads; f.cores = wk; f.evidence.push('puma workers=' + wk + ' threads=' + threads);
  if (pool && pool < threads) smell(f, 'puma-pool-mismatch', 'Thread Puma (' + threads + ') lebih banyak dari pool ActiveRecord (' + pool + '): thread mengantre menunggu koneksi.', ['config/database.yml']);
  const files = S.walk(unit, ['.rb'], { max: 1500, depth: 8 });
  f.routes = S.count(files, /^\s*(get|post|put|patch|delete|resources|resource)\s+['":]/gm);
  f.external = collectExternal(root, files, /Net::HTTP|Faraday|HTTParty|RestClient|Typhoeus/);
  f.cron = /whenever|sidekiq-cron|clockwork|rufus/.test(g);
  if (f.external.length && S.any(files, /Net::HTTP\.(get|post|start)|HTTParty\.(get|post)/) && !S.any(files, /read_timeout|open_timeout|timeout:/)) f.noTimeout = true;
  return f;
}

// ---------------- .NET
function dotnetUnit(unit, root, infra) {
  const proj = S.ls(unit).filter(function (n) { return /\.csproj$/.test(n); }).map(function (n) { return S.read(path.join(unit, n)); }).join('\n');
  const f = newFacts(unit, root, 'dotnet', ASP(proj) ? 'ASP.NET Core' : '.NET'); f.model = 'event-loop';
  scanWords(f, proj); if (/EntityFramework/.test(proj)) f.orm = 'efcore';
  if (/Npgsql/.test(proj)) pushDb(f, 'postgres'); if (/MySql|Pomelo/.test(proj)) pushDb(f, 'mysql'); if (/SqlClient|SqlServer/.test(proj)) pushDb(f, 'mssql'); if (/Sqlite/.test(proj)) pushDb(f, 'sqlite');
  const files = S.walk(unit, ['.cs'], { max: 1500, depth: 9 }), cfg = S.walk(unit, ['.json'], { depth: 1, max: 10 }).filter(function (p) { return /appsettings/.test(p); }).map(S.read).join('\n');
  if (!f.dbs.length) { if (/Host=|Server=.*postgres/i.test(cfg)) pushDb(f, 'postgres'); else if (/Server=|Data Source=/i.test(cfg)) pushDb(f, 'mssql'); }
  const mp = cfg.match(/Max Pool Size\s*=\s*(\d+)/i); setPool(f, mp ? Number(mp[1]) : (f.dbs.length ? 100 : null), mp ? 'appsettings: Max Pool Size' : 'default ADO.NET (100)');
  f.routes = S.count(files, /\[Http(Get|Post|Put|Patch|Delete)\b|\.Map(Get|Post|Put|Delete)\s*\(/g);
  f.external = collectExternal(root, files, /HttpClient|RestSharp|Refit/);
  f.cron = /Hangfire|Quartz/.test(proj) || S.any(files, /BackgroundService|IHostedService/);
  if (S.any(files, /new HttpClient\s*\(/)) smell(f, 'httpclient-factory', 'new HttpClient() per pemakaian dapat menghabiskan socket (TIME_WAIT); pakai IHttpClientFactory.', []);
  if (f.external.length && !S.any(files, /Timeout\s*=|AddHttpClient|Polly/)) f.noTimeout = true;
  f.workers = 1000; f.assumptions.push('ASP.NET memakai thread pool; jumlah core CPU belum diketahui');
  return f;
}
function ASP(p) { return /Microsoft\.NET\.Sdk\.Web|AspNetCore/.test(p); }

// ---------------- PHP non-Laravel
function phpUnit(unit, root, infra) {
  const j = S.readJson(path.join(unit, 'composer.json')) || {}, req = Object.assign({}, j.require, j['require-dev']);
  if (req['laravel/framework']) return null; // jalur khusus Laravel
  const fw = req['symfony/framework-bundle'] ? 'Symfony' : req['slim/slim'] ? 'Slim' : req['codeigniter4/framework'] ? 'CodeIgniter' : req['yiisoft/yii2'] ? 'Yii' : req['cakephp/cakephp'] ? 'CakePHP' : 'PHP';
  const f = newFacts(unit, root, 'php', fw); f.model = 'processes'; scanWords(f, Object.keys(req).join(' '));
  if (/doctrine|illuminate\/database|cakephp|yii/.test(Object.keys(req).join(' '))) f.orm = 'orm';
  if (!f.dbs.length) pushDb(f, 'mysql');
  const files = S.walk(unit, ['.php'], { max: 1500, depth: 8 });
  f.routes = S.count(files, /->(get|post|put|patch|delete)\s*\(\s*['"]\/|#\[Route\(|@Route\(/g);
  f.external = collectExternal(root, files, /curl_init|Guzzle|HttpClient|file_get_contents\(\s*['"]https?/);
  f.workers = infra.hints.phpMaxChildren || 20; if (!infra.hints.phpMaxChildren) f.assumptions.push('pm.max_children tidak ditemukan; diasumsikan 20');
  if (f.external.length && S.any(files, /curl_init/) && !S.any(files, /CURLOPT_TIMEOUT|'timeout'\s*=>/)) f.noTimeout = true;
  return f;
}

function detect(unit, root, infra) {
  const d = unit;
  if (S.exists(path.join(d, 'artisan')) && S.exists(path.join(d, 'composer.json'))) return { laravel: true, unit: d };
  const order = [];
  if (S.exists(path.join(d, 'package.json'))) order.push(nodeUnit);
  if (S.exists(path.join(d, 'requirements.txt')) || S.exists(path.join(d, 'pyproject.toml')) || S.exists(path.join(d, 'manage.py')) || S.exists(path.join(d, 'Pipfile'))) order.push(pythonUnit);
  if (S.exists(path.join(d, 'pom.xml')) || S.exists(path.join(d, 'build.gradle')) || S.exists(path.join(d, 'build.gradle.kts'))) order.push(javaUnit);
  if (S.exists(path.join(d, 'go.mod'))) order.push(goUnit);
  if (S.exists(path.join(d, 'Gemfile'))) order.push(rubyUnit);
  if (hasCsproj(d)) order.push(dotnetUnit);
  if (S.exists(path.join(d, 'composer.json'))) order.push(phpUnit);
  for (const fn of order) { const f = fn(d, root, infra); if (f) return { facts: f }; }
  return null;
}

module.exports = { findUnits: findUnits, detect: detect };
