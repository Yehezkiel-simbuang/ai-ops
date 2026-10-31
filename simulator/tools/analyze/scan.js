// Pemindai berkas untuk analyzer. Hanya membaca. Dipakai oleh semua detektor stack.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', 'vendor', '.git', 'storage', 'bootstrap', 'dist', 'build', 'target', 'bin', 'obj', '__pycache__', '.venv', 'venv', 'env',
  '.next', '.nuxt', '.output', 'out', 'coverage', '.idea', '.vscode', 'public', 'static', 'assets', 'backup', 'tmp', 'logs', '.gradle', '.mvn', 'Pods', '__MACOSX',
  'graphify-out', '.agents', '.claude', '.opencode', '.github', 'docs', 'migrations', 'Migrations', 'test', 'tests', '__tests__', 'spec', 'e2e', 'fixtures']);
const MAX_FILE = 400000;

// lstat: symlink bukan berkas biasa dan tidak diikuti (repo berbahaya bisa menautkan ke rahasia di luar proyek)
function read(p) { try { const s = fs.lstatSync(p); if (!s.isFile() || s.size > MAX_FILE) return ''; return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function readJson(p) { try { return JSON.parse(read(p)); } catch (e) { return null; } }
function rel(root, p) { return path.relative(root, p).split(path.sep).join('/'); }

// daftar berkas dengan ekstensi tertentu; berhenti di batas agar repo raksasa tidak membuat alat lambat
function walk(dir, exts, opt) {
  opt = opt || {}; const max = opt.max || 3000, depthMax = opt.depth == null ? 9 : opt.depth, keepTests = !!opt.keepTests, out = [];
  (function go(d, depth) {
    if (out.length >= max || depth > depthMax) return;
    let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      if (out.length >= max) return;
      if (e.isSymbolicLink()) continue;   // tidak mengikuti symlink
      if (e.isDirectory()) { if (!SKIP.has(e.name) || (keepTests && /^(test|tests|spec)$/.test(e.name) && false)) go(path.join(d, e.name), depth + 1); }
      else if (exts.some(function (x) { return e.name.endsWith(x); }) && !/\.min\.(js|css)$/.test(e.name)) out.push(path.join(d, e.name));
    }
  })(dir, 0);
  return out;
}

// cari pola di berkas; hasilnya menyertakan nomor baris sebagai bukti
function grep(root, files, re, limit) {
  const out = []; limit = limit || 20;
  for (const f of files) {
    if (out.length >= limit) break;
    const lines = read(f).split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      if (re.test(lines[i])) out.push({ file: rel(root, f), line: i + 1, text: lines[i].trim().slice(0, 140) });
    }
  }
  return out;
}
function count(files, re) { let n = 0; for (const f of files) { const m = read(f).match(re); if (m) n += m.length; } return n; }
function any(files, re) { for (const f of files) if (re.test(read(f))) return true; return false; }

// berkas dalam folder tertentu, tanpa rekursi
function ls(dir) { try { return fs.readdirSync(dir); } catch (e) { return []; } }

// .env aman: hanya kunci daftar putih; host hanya diklasifikasikan lokal/jarak jauh; URL hanya skema-nya
const ENV_KEYS = ['APP_ENV', 'APP_DEBUG', 'NODE_ENV', 'DB_CONNECTION', 'DB_HOST', 'CACHE_DRIVER', 'CACHE_STORE', 'SESSION_DRIVER', 'QUEUE_CONNECTION', 'REDIS_HOST', 'REDIS_CLIENT',
  'LOG_LEVEL', 'BCRYPT_ROUNDS', 'DATABASE_URL', 'REDIS_URL', 'MONGO_URL', 'MONGODB_URI', 'AMQP_URL', 'RABBITMQ_URL', 'CELERY_BROKER_URL', 'BROKER_URL', 'KAFKA_BROKERS', 'WEB_CONCURRENCY', 'WORKERS', 'PORT'];
function hostClass(v) { return (v === '127.0.0.1' || v === 'localhost' || v === '::1' || v.indexOf('/') === 0 || v === 'db' || v === 'redis') ? 'lokal' : 'jarak-jauh'; }
function parseEnv(dir) {
  const file = ['.env', '.env.example', '.env.development', '.env.production'].map(function (f) { return path.join(dir, f); }).find(exists);
  const out = { file: file ? path.basename(file) : null, values: {}, urls: {} };
  if (!file) return out;
  read(file).split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (!m || ENV_KEYS.indexOf(m[1]) < 0) return;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (/_URL$|_URI$|BROKERS$/.test(m[1])) { const u = v.match(/^([a-z0-9+.-]+):\/\/(?:[^@/]*@)?([^/:?]+)?/i); if (u) out.urls[m[1]] = { scheme: u[1].toLowerCase(), where: u[2] ? hostClass(u[2]) : null }; return; }
    out.values[m[1]] = (m[1] === 'DB_HOST' || m[1] === 'REDIS_HOST') ? hostClass(v) : v;
  });
  return out;
}

module.exports = { read: read, exists: exists, readJson: readJson, rel: rel, walk: walk, grep: grep, count: count, any: any, ls: ls, parseEnv: parseEnv, SKIP: SKIP };
