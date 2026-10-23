#!/usr/bin/env node
// Uji ujung-ke-ujung UI (React) lewat Chrome (DevTools Protocol, tanpa dependensi): login, navigasi tiap halaman, tambah server lewat formulir,
// insiden dari agen, vault (ungkap dengan konfirmasi password), dan pastikan tidak ada galat konsol atau pelanggaran CSP.
// Pakai: node scripts/e2e-ui.mjs [url] [password] [folder-screenshot]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

const BASE = process.argv[2] || 'http://localhost:4317', PW = process.argv[3] || readFileSync(join(import.meta.dirname, '..', 'secrets', 'admin_password.txt'), 'utf8').trim();
const SHOTS = process.argv[4] || join(tmpdir(), 'aiops-e2e'); mkdirSync(SHOTS, { recursive: true });
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!CHROME) { console.error('Chrome tidak ditemukan'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = mkdtempSync(join(tmpdir(), 'e2e-prof-')), port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1360,1000', 'about:blank'], { stdio: 'ignore' });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  GAGAL ' + m); } };
const J = JSON.stringify;
try {
  let ver; for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(), problems = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(d.params.type)) problems.push('console.' + d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/fonts\.(googleapis|gstatic)/.test(d.params.entry.url || '') && !/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/.test(d.params.entry.text)) problems.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(J({ id: i, method, params })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await sleep(150); } return false; };
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

  // ---------- pembantu interaksi (mirip pengguna: fokus lalu ketik, klik berdasarkan teks)
  const go = async (path) => { await send('Page.navigate', { url: BASE + path }); await sleep(700); };
  const text = () => evalJs('document.body.innerText');
  const has = (s) => `document.body.innerText.indexOf(${J(s)})>=0`;
  const type = async (selector, value) => {
    ok_(await evalJs(`(function(){ var e=document.querySelector(${J(selector)}); if(!e) return false; e.focus(); e.select && e.select(); return true; })()`), 'elemen ada: ' + selector);
    await send('Input.insertText', { text: value });
  };
  const ok_ = (c, m) => { if (!c) { fail++; console.log('  GAGAL ' + m); } };
  const click = (selector, label) => evalJs(`(function(){ var els=[].slice.call(document.querySelectorAll(${J(selector)})); var e=els.find(function(x){return ${label ? `x.textContent.indexOf(${J(label)})>=0` : 'true'};}); if(!e) return false; e.click(); return true; })()`);
  const nav = (href) => evalJs(`document.querySelector('nav.side a[href=${J(href)}]').click()`);
  const apiJs = (m, p, b) => evalJs(`fetch(${J(p)}, { method: ${J(m)}, headers: { 'content-type': 'application/json', 'x-aiops': '1' }, body: ${b ? J(J(b)) : 'undefined'} }).then(r => r.json())`);

  console.log('Login');
  await go('/'); ok(await until(`location.pathname==='/login'`), 'tanpa sesi diarahkan ke /login');
  await type('input[name=username]', 'admin'); await type('input[name=password]', PW);
  await click('button[type=submit]', 'Masuk');
  ok(await until(`location.pathname==='/ringkasan' && !!document.querySelector('main h1')`), 'login berhasil, Ringkasan tampil');
  await shot('01-ringkasan');
  ok((await evalJs(`document.querySelectorAll('nav.side a:not(.ext)').length`)) === 10, 'navigasi samping lengkap (10 menu)');
  ok((await evalJs(`document.querySelectorAll('svg').length`)) > 5, 'ikon (react-icons) dirender sebagai SVG');
  await go('/server'); ok(await until(`location.pathname==='/server' && ${has('Tambah server')}`), 'muat langsung ke rute dalam (/server) tetap tampil setelah reload (sesi bertahan, fallback SPA)');

  console.log('Halaman');
  for (const [path, label] of [['/insiden', 'Insiden'], ['/server', 'Server'], ['/setup', 'Setup server'], ['/monitor', 'Monitor'], ['/token', 'Pemakaian token'], ['/pengaturan', 'Pengaturan']]) {
    await nav(path);
    ok(await until(`location.pathname===${J(path)} && (document.querySelector('main h1')||{}).textContent.indexOf(${J(label)})>=0`), `halaman ${path} tampil`);
    await sleep(400); await shot('02-' + path.slice(1));
  }

  // sisa uji sebelumnya
  { const old = await evalJs("fetch('/api/servers').then(r=>r.json()).then(l=>l.filter(x=>/^srv-(e2e|ui-agen|docs-ui)$/.test(x.name)).map(x=>x.id))"); for (const i of old || []) await apiJs('DELETE', '/api/servers/' + i); }
  console.log('Formulir server');
  await nav('/server'); await until(`!!document.querySelector('input[placeholder="srv-database"]')`);
  await type('input[placeholder="srv-database"]', 'srv-e2e'); await type('input[placeholder="10.0.0.5"]', '10.20.30.40'); await type('input[placeholder="ops"]', 'ops');
  await click('form button[type=submit]', 'Simpan');
  ok(await until(has('srv-e2e')), 'server baru muncul di daftar setelah formulir dikirim');
  await shot('03-server-ditambah');
  await nav('/monitor'); ok(await until(has('Pemeriksaan layanan di dalam server')), 'halaman Monitor menampilkan panel pemeriksaan layanan');
  { const l = await evalJs("fetch('/api/servers').then(r=>r.json()).then(l=>l.filter(x=>x.name==='srv-e2e').map(x=>x.id))"); for (const i of l || []) await apiJs('DELETE', '/api/servers/' + i); }

  console.log('Agen dan insiden');
  // server + agen dibuat lewat API sesi browser, lalu satu kejadian kritis bertanda tangan dikirim seperti agen sungguhan
  const srv = await apiJs('POST', '/api/servers', { name: 'srv-ui-agen', host: '10.77.0.1', username: 'ops', use_sudo: true });
  const cred = await apiJs('POST', '/api/servers/' + srv.id + '/agent', { exec: true });
  ok(!!cred.keyId && /aiops-agent -check/.test(cred.script), 'API membuat kredensial agen dan panduan pemasangan');
  const body = J({ events: [{ id: 'ui' + Date.now(), type: 'open', key: 'svc:nginx', title: 'Layanan nginx tidak aktif', kind: 'service', severity: 'critical', detail: 'status: failed', ts: Math.floor(Date.now() / 1000), diag: [{ name: 'systemctl status', out: 'nginx.service - A high performance web server\n   Active: failed (Result: exit-code)' }] }] });
  const ts = String(Math.floor(Date.now() / 1000)), sig = createHmac('sha256', cred.config.secret).update(ts + '\nPOST\n/agent/v1/events\n' + createHash('sha256').update(body).digest('hex')).digest('hex');
  const post = await fetch(BASE + '/agent/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aiops-key': cred.keyId, 'x-aiops-ts': ts, 'x-aiops-sig': sig }, body });
  ok(post.status === 200, 'kejadian kritis bertanda tangan diterima aplikasi');
  await sleep(1500);
  await nav('/insiden'); ok(await until(`${has('nginx')} && ${has('Terbuka')}`), 'halaman Insiden menampilkan insiden dari agen');
  await shot('04-insiden-daftar');
  await click('main a.item'); ok(await until(`${has('Rekomendasi #')} && document.querySelectorAll('main .card').length>=3`), 'detail insiden menampilkan rekomendasi dengan langkah dan perintahnya');
  ok(await evalJs(`${has('Setujui dan jalankan')} && ${has('mengubah')}`), 'tombol persetujuan dan penanda langkah yang mengubah sistem tampil');
  await shot('05-insiden-detail');
  await go('/agen/' + srv.id); ok(await until(`${has('Agen: srv-ui-agen')} && ${has('detak jantung')}`), 'halaman Agen menampilkan status dan penjelasan data yang dikirim');
  await shot('06-agen');
  await apiJs('DELETE', '/api/servers/' + srv.id);

  console.log('Inventaris, vault, dan pemeliharaan');
  const d1 = await apiJs('POST', '/api/servers', { name: 'srv-docs-ui', host: '10.55.0.9', username: 'ops' });
  await apiJs('PUT', '/api/servers/' + d1.id + '/profile', { purpose: 'Database aplikasi web (uji UI)', environment: 'prod', tags: ['database', 'webapp'], owner: 'Tim NOC', location: 'Rak 2', addresses: [{ label: 'LAN', address: '10.55.0.9' }], services: [{ name: 'MySQL', port: 3306 }], runbook: 'Restart hanya di luar jam kerja.' });
  const made = await apiJs('POST', '/api/servers/' + d1.id + '/credentials', { label: 'MySQL root', kind: 'database', username: 'root', generate: { length: 26 }, rotate_every_days: 90 });
  await apiJs('POST', '/api/servers/' + d1.id + '/maintenance/templates', { ids: ['os-update', 'backup-restore'] });
  ok(!!made.generated && made.generated.length === 26, 'password dibuat otomatis oleh server (26 karakter)');
  await nav('/inventaris'); ok(await until("!!document.querySelector('main input[type=search]')"), 'halaman Inventaris tampil');
  await type('main input[type=search]', 'docs-ui');
  ok(await until(`${has('srv-docs-ui')} && ${has('10.55.0.9')}`), 'pencarian menemukan server (nama dan IP)');
  await type('main input[type=search]', 'root');
  ok(await until(has('srv-docs-ui')), 'pencarian berdasarkan username kredensial ("root") menemukan server');
  await shot('07-inventaris');
  await go('/inventaris/' + d1.id); ok(await until(`${has('Tentang server ini')} && ${has('Database aplikasi web')} && ${has('Tim NOC')}`), 'detail server menampilkan fungsi, pemilik, alamat, layanan');
  await shot('08-dokumentasi');
  await click('.tabs [role=tab]', 'Kredensial');
  ok(await until(`${has('MySQL root')} && ${has('Ungkap')}`), 'tab Kredensial menampilkan metadata tanpa password');
  ok(!(await evalJs(has(made.generated))), 'password TIDAK ada di halaman sebelum diungkap');
  await click('main button', 'Ungkap');
  ok(await until("!!document.querySelector('dialog[open] input[type=password]')"), 'Ungkap meminta konfirmasi password akun');
  await type('dialog[open] input[type=password]', 'SALAH-BANGET'); await click('dialog[open] button[type=submit]');
  await sleep(900); ok(!(await evalJs(has(made.generated))), 'password salah: rahasia tidak ditampilkan');
  await click('main button', 'Ungkap');
  await until("!!document.querySelector('dialog[open] input[type=password]')");
  await type('dialog[open] input[type=password]', PW); await click('dialog[open] button[type=submit]');
  ok(await until("(document.querySelector('dialog[open] pre.out')||{}).textContent===" + J(made.generated)), 'password benar: rahasia yang tepat ditampilkan di dialog');
  await shot('09-ungkap');
  await click('dialog[open] button', 'Tutup');
  ok(await until("!document.querySelector('dialog[open]') && !document.body.innerText.includes(" + J(made.generated) + ")"), 'dialog rahasia tertutup dan teks rahasia dihapus dari halaman');
  await click('.tabs [role=tab]', 'Pemeliharaan');
  ok(await until(`${has('Pembaruan keamanan OS')} && ${has('Uji pemulihan cadangan')}`), 'tab Pemeliharaan menampilkan jadwal dari templat');
  await shot('10-pemeliharaan');
  await nav('/inventaris'); await until("!!document.querySelector('.tabs')");
  await click('.tabs [role=tab]', 'Vault');
  ok(await until(has('srv-docs-ui | MySQL root')), 'tab Vault menampilkan kredensial lintas server');
  await apiJs('DELETE', '/api/servers/' + d1.id);

  console.log('Lab arsitektur');
  await nav('/arsitektur'); ok(await until(`document.querySelectorAll('svg.stage [data-node]').length>=5`, 20000), 'diagram arsitektur tampil dengan node-nodenya');
  ok(await until(has('Hasil dibanding kondisi sekarang')), 'hasil perbandingan tampil (simulasi berjalan di server)');
  ok(await until(`document.querySelectorAll('svg.stage path.edge.live').length>0`, 15000), 'aliran request bergerak pada sambungan');
  ok(await evalJs(`/Eksperimen Anda \\(\\d+\\)/.test(document.body.innerText) && !document.body.innerText.includes('Eksperimen Anda (0)')`), 'eksperimen dimulai dari rekomendasi (bukan kosong)');
  await shot('11-lab-awal');
  await click('.lab-side .tabs [role=tab]', 'Beban'); await click('[role=group] button', '10x');
  ok(await until(`!!document.querySelector('.verdict') && !document.body.innerText.includes('menghitung')`, 20000), 'beban 10x: simulasi dihitung ulang dan kesimpulan tampil');
  await shot('12-lab-beban-10x');
  const before = await evalJs(`document.querySelector('.verdict b').textContent`);
  await click('.lab-side .tabs [role=tab]', 'Komponen'); await click('.card-comp header', 'Cache Redis');
  ok(await until(`!!document.querySelector('.card-comp.on, .card-comp [role=slider], .card-comp input[type=range]')`), 'kartu komponen terbuka dengan parameter yang bisa diatur');
  await click('.card-comp button', 'Pasang');
  ok(await until(`${has('terpasang')} && !document.body.innerText.includes('menghitung')`, 20000), 'komponen Redis terpasang ke eksperimen dan simulasi dihitung ulang');
  ok(await evalJs(`document.querySelectorAll('svg.stage .gnode.new').length>=1 || document.body.innerText.includes('Cache Redis')`), 'komponen baru muncul di eksperimen');
  await shot('13-lab-redis');
  await click('.lab-view button', 'Berdampingan').catch?.(() => 0); await click('[role=group] button', 'Berdampingan');
  ok(await until(`document.querySelectorAll('svg.stage').length===2`), 'tampilan berdampingan: dua diagram (sekarang vs eksperimen)');
  await shot('14-lab-berdampingan');
  void before;
  await click('[role=group] button', 'Eksperimen'); await click('main button', 'Cari leher botol');
  ok(await until("document.querySelectorAll('.rank').length>=1 && document.body.innerText.includes('variasi')", 30000), 'analisis potensi bottleneck: urutan komponen jenuh dengan keyakinan "n dari m variasi"');
  ok(await evalJs("document.body.innerText.includes('Bukan ramalan RPM') && document.body.innerText.includes('bukan hasil ukur')"), 'UI menegaskan bahwa ini bukan ramalan angka dan beban dasar bukan hasil ukur');
  ok(await until("document.querySelectorAll('svg.stage .grank-badge').length>=1"), 'peringkat leher botol ditandai langsung di diagram');
  await shot('15-lab-bottleneck');

  // HA: matikan database di tengah beban, lalu lihat bedanya sebelum dan sesudah Database HA dipasang
  await click('.lab-side .tabs [role=tab]', 'Beban'); await click('label.checkline', 'Skenario kegagalan');
  ok(await until("document.body.innerText.includes('Detik layanan mati total') && !document.body.innerText.includes('menghitung')", 30000), 'skenario kegagalan: tabel menambah baris detik layanan mati total');
  ok(await evalJs("document.querySelector('.verdict b').textContent.length>0 && /Ketahanan|mati/.test(document.querySelector('.verdict').textContent)"), 'kesimpulan menilai ketahanan (bukan hanya kecepatan)');
  await shot('16-lab-database-mati');
  await click('.lab-side .tabs [role=tab]', 'Komponen'); await click('.card-comp header', 'Database HA'); await click('.card-comp button', 'Pasang');
  ok(await until("document.querySelector('.verdict b') && document.querySelector('.verdict b').textContent.includes('Lebih tahan') && !document.body.innerText.includes('menghitung')", 30000), 'Database HA dipasang: layanan lebih tahan saat database mati');
  ok(await evalJs("document.querySelector('.verdict p').textContent.includes('transaksi')"), 'risiko transaksi yang hilang saat failover ditampilkan');
  ok(await until("document.querySelectorAll('svg.stage [data-state]').length>=1", 30000), 'diagram menandai node yang mati/failover');
  await shot('17-lab-ha');

  console.log('Uji beban (k6 sungguhan terhadap aplikasi demo)');
  await nav('/uji-beban'); ok(await until("document.body.innerText.includes('runner online')", 20000), 'halaman Uji beban menampilkan runner online (k6 terhubung)');
  await click('main button', 'Uji baru');
  ok(await until("!!document.querySelector('input[aria-label=Target]')"), 'formulir uji baru terbuka');
  await type('input[placeholder*="Proyek A"]', 'Uji UI demo'); await type('input[aria-label=Target]', 'http://demo-api:8080'); await type('input[aria-label=Path]', '/produk');
  await click('.chips button', 'Cepat'); await click('label.checkline', 'BUKAN server produksi');
  ok(await until("(function(){var b=[].slice.call(document.querySelectorAll('button[type=submit]')).find(function(x){return x.textContent.indexOf('Simpan sebagai draf')>=0;});return !!b && !b.disabled;})()"), 'tombol simpan aktif setelah semua syarat terpenuhi (termasuk konfirmasi bukan produksi)');
  await click('button[type=submit]', 'Simpan sebagai draf');
  ok(await until("location.pathname.startsWith('/uji-beban/') && document.body.innerText.includes('masih draf dan belum berjalan')"), 'uji tersimpan sebagai draf dan belum berjalan');
  await shot('18-uji-beban-draf');
  await click('main button', 'Setujui dan jalankan');
  ok(await until("!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').innerText.includes('BUKAN server produksi') && document.querySelector('dialog[open]').innerText.includes('http://demo-api:8080')"), 'persetujuan meminta konfirmasi rinci (target, tahap, peringatan produksi)');
  await click('dialog[open] button', 'Setujui dan jalankan');
  ok(await until("document.body.innerText.includes('Berjalan') || document.body.innerText.includes('Antre')", 15000), 'status berpindah ke antre/berjalan setelah disetujui');
  ok(await until("document.querySelectorAll('main table tbody tr').length>=3 && document.body.innerText.includes('Selesai')", 120000), 'tiga tahap selesai dan hasil per tahap tampil');
  ok(await evalJs("!!document.querySelector('.verdict b') && document.querySelector('.verdict b').textContent.length>5 && !!document.querySelector('svg[aria-label=\"Waktu respons p95 per tahap\"]')"), 'kesimpulan dan grafik p95 tampil');
  await shot('19-uji-beban-hasil');
  await click('main button[aria-label="Hapus uji"]'); await click('dialog[open] button', 'Hapus');
  ok(await until("location.pathname==='/uji-beban'"), 'uji dihapus dan kembali ke daftar');

  console.log('Keluar');
  await click('nav.side button', 'Keluar'); ok(await until(`location.pathname==='/login'`), 'keluar mengembalikan ke /login');
  await go('/ringkasan'); ok(await until(`location.pathname==='/login'`), 'setelah keluar, rute terlindungi kembali meminta login');

  const real = problems.filter((p) => !/401|favicon|\/reveal/.test(p));   // 401 saat belum masuk dan 403 pada /reveal disengaja (uji password salah)
  ok(real.length === 0, 'tidak ada galat konsol atau pelanggaran CSP' + (real.length ? ': ' + real.slice(0, 3).join(' | ') : ''));
  console.log(`\n${pass} lolos, ${fail} gagal. Screenshot: ${SHOTS}`);
} finally { chrome.kill(); }
process.exit(fail ? 1 : 0);
