#!/usr/bin/env node
// Uji HTTPS jaringan lokal (profil lan-internal): Caddy dengan CA internal di depan aplikasi, lalu agen Go sungguhan
// terhubung lewat HTTPS memakai ca_file. Membuktikan rantai sertifikat, cookie Secure, HSTS, dan penolakan tanpa CA.
// Prasyarat: stack berjalan dengan profil lan-internal dan .env berisi DOMAIN, ALLOWED_HOSTS (memuat DOMAIN), COOKIE_SECURE=true, TRUST_PROXY=true.
//   Contoh .env:  DOMAIN=aiops.lan  HTTPS_PORT=8443  ALLOWED_HOSTS=localhost,127.0.0.1,aiops.lan  PUBLIC_URL=https://aiops.lan  COOKIE_SECURE=true  TRUST_PROXY=true
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';

const DOMAIN = process.argv[2] || 'aiops.lan', PORT = Number(process.argv[3] || 8443), SIM = 'aiops-sim-lan';
const PW = readFileSync(join(import.meta.dirname, '..', 'secrets', 'admin_password.txt'), 'utf8').trim();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  GAGAL ' + m); } };
const dock = (a, input) => spawnSync('docker', a, { encoding: 'utf8', input, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(1000); } return null; };

// klien HTTPS yang me-resolve DOMAIN ke 127.0.0.1 dan mempercayai HANYA root CA yang diberikan (bukan -k)
function req(method, path, ca, body, cookie) {
  return new Promise((resolve) => {
    const r = https.request({ host: '127.0.0.1', port: PORT, servername: DOMAIN, method, path, headers: { host: DOMAIN, 'content-type': 'application/json', 'x-aiops': '1', ...(cookie ? { cookie } : {}) }, ca, rejectUnauthorized: true }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on('error', (e) => resolve({ error: e.code || e.message })); if (body) r.write(JSON.stringify(body)); r.end();
  });
}

try {
  console.log('Sertifikat dan HTTPS');
  const caps = await until(() => { const r = dock(['compose', 'exec', '-T', 'caddy-internal', 'cat', '/data/caddy/pki/authorities/local/root.crt']); return r.status === 0 && r.stdout.includes('BEGIN CERTIFICATE') ? r.stdout : null; }, 30000);
  ok(!!caps, 'root CA internal Caddy tersedia'); if (!caps) throw new Error('profil lan-internal belum berjalan');
  const dir = mkdtempSync(join(tmpdir(), 'lan-')); writeFileSync(join(dir, 'root.crt'), caps);
  const noCa = await req('GET', '/healthz', undefined);
  ok(noCa.error && /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/.test(noCa.error), 'tanpa root CA, klien menolak sertifikat (' + noCa.error + ')');
  const h = await until(async () => { const r = await req('GET', '/healthz', caps); return r.status === 200 ? r : null; }, 30000);
  ok(!!h, 'dengan root CA, HTTPS ke ' + DOMAIN + ':' + PORT + ' tervalidasi penuh (tanpa -k)');
  ok(/max-age=\d+/.test(h.headers['strict-transport-security'] || ''), 'HSTS terpasang'); ok(!h.headers.server, 'header Server disembunyikan');
  const login = await req('POST', '/api/login', caps, { username: 'admin', password: PW });
  const sc = String(login.headers['set-cookie'] || ''); ok(login.status === 200 && /Secure/i.test(sc) && /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc), 'login lewat HTTPS: cookie Secure + HttpOnly + SameSite=Strict');
  const cookie = sc.split(';')[0]; const ov = await req('GET', '/api/overview', caps, undefined, cookie); ok(ov.status === 200, 'API terjangkau lewat proxy HTTPS');
  const bad = await new Promise((resolve) => { const r = https.request({ host: '127.0.0.1', port: PORT, servername: DOMAIN, method: 'GET', path: '/api/overview', headers: { host: 'evil.example', cookie }, ca: caps }, (res) => { let x = ''; res.on('data', (c) => { x += c; }); res.on('end', () => resolve({ status: res.statusCode, body: x })); }); r.on('error', () => resolve({ status: 0, body: '' })); r.end(); });
  ok(!bad.body.includes('"servers"'), 'Host asing tidak pernah sampai ke data aplikasi lewat proxy (HTTP ' + bad.status + ')');

  console.log('Agen lewat HTTPS dengan ca_file');
  for (const old of (JSON.parse((await req('GET', '/api/servers', caps, undefined, cookie)).body) || []).filter((x) => x.name === 'srv-lan-e2e')) await req('DELETE', '/api/servers/' + old.id, caps, undefined, cookie);
  const s = JSON.parse((await req('POST', '/api/servers', caps, { name: 'srv-lan-e2e', host: 'lan.local', username: 'root' }, cookie)).body);
  const g = JSON.parse((await req('POST', `/api/servers/${s.id}/agent`, caps, { exec: false }, cookie)).body); ok(g.config.server_url === 'https://' + DOMAIN, 'panduan memakai PUBLIC_URL https (' + g.config.server_url + ')');
  dock(['rm', '-f', SIM]);
  const caddyIp = dock(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', 'aiops-caddy-internal-1']).stdout.trim().split(' ')[0];
  dock(['run', '-d', '--name', SIM, '--network', 'aiops_default', '--add-host', `${DOMAIN}:${caddyIp}`, 'alpine:3.20', 'sleep', 'infinity']);
  dock(['cp', join(dir, 'root.crt'), `${SIM}:/etc/root.crt`]);
  const inst = dock(['exec', '-i', SIM, 'sh', '-c', 'apk add --no-cache curl >/dev/null 2>&1; A=amd64; cd /tmp && curl -fsSL --cacert /etc/root.crt -O ' + `https://${DOMAIN}/agent/download/aiops-agent-linux-$A` + ' && curl -fsSL --cacert /etc/root.crt -O ' + `https://${DOMAIN}/agent/download/SHA256SUMS` + ' && grep " aiops-agent-linux-$A$" SHA256SUMS | sha256sum -c - && install -m 755 aiops-agent-linux-$A /usr/local/bin/aiops-agent']);
  ok(inst.status === 0, 'biner agen diunduh lewat HTTPS (curl --cacert) dan checksum cocok' + (inst.status ? ': ' + (inst.stderr || inst.stdout).slice(-200) : ''));
  const cfg = { ...g.config, ca_file: '/etc/root.crt', heartbeat_seconds: 15, interval_seconds: 10 };
  dock(['exec', '-i', SIM, 'sh', '-c', 'cat > /etc/aiops-agent.json && chmod 600 /etc/aiops-agent.json'], JSON.stringify(cfg));
  // tanpa ca_file agen HARUS gagal terhubung (tidak boleh menerima CA tak dikenal)
  const noCfg = { ...cfg }; delete noCfg.ca_file; dock(['exec', '-i', SIM, 'sh', '-c', 'cat > /tmp/noca.json'], JSON.stringify(noCfg));
  const probe = dock(['exec', SIM, 'sh', '-c', 'timeout 25 aiops-agent -config /tmp/noca.json 2>&1 | head -5']); ok(/x509|certificate|unknown authority/i.test(probe.stdout), 'tanpa ca_file agen menolak sertifikat CA internal (' + probe.stdout.split('\n').find((l) => /heartbeat/.test(l))?.slice(-90) + ')');
  dock(['exec', '-d', SIM, 'sh', '-c', 'aiops-agent -config /etc/aiops-agent.json > /tmp/agent.log 2>&1']);
  const online = await until(async () => { const a = JSON.parse((await req('GET', `/api/servers/${s.id}/agent`, caps, undefined, cookie)).body); return a.agent && a.agent.online ? a.agent : null; }, 45000);
  ok(!!online, 'dengan ca_file agen online lewat HTTPS (detak jantung diterima)');
  await req('DELETE', '/api/servers/' + s.id, caps, undefined, cookie);
} catch (e) { fail++; console.log('  GAGAL pengecualian: ' + e.message); }
finally { dock(['rm', '-f', SIM]); }
console.log(`\n${pass} lolos, ${fail} gagal`); process.exit(fail ? 1 : 0);
