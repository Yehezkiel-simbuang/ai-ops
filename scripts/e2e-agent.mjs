#!/usr/bin/env node
// Uji ujung-ke-ujung NYATA: agen Go sungguhan di kontainer "server" (alpine) melapor ke aplikasi Docker.
// Alur: pasang agen dari panduan aplikasi -> kondisi kritis (disk hampir penuh) -> insiden + rekomendasi -> persetujuan ->
// perintah dijalankan AGEN di server (bukan SSH) -> kondisi pulih -> agen melapor pulih.
// Prasyarat: stack berjalan (docker compose up -d) dan ALLOWED_HOSTS memuat "app" (ALLOWED_HOSTS=localhost,127.0.0.1,app di .env).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4317', PW = readFileSync(join(import.meta.dirname, '..', 'secrets', 'admin_password.txt'), 'utf8').trim();
const NET = 'aiops_default', SIM = 'aiops-sim', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  GAGAL ' + m); } };
const dock = (args, input) => spawnSync('docker', args, { encoding: 'utf8', input, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const sim = (script) => dock(['exec', '-i', SIM, 'sh', '-c', script]);
let cookie = '';
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-aiops': '1', cookie }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch { /* bukan JSON */ } return { status: r.status, json: j };
}
const until = async (fn, ms = 60000, step = 1000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const appLog = () => dock(['compose', 'logs', 'app', '--no-log-prefix', '--since', '30m']).stdout || '';

try {
  console.log('Persiapan');
  dock(['rm', '-f', SIM]);
  const run = dock(['run', '-d', '--name', SIM, '--network', NET, '--tmpfs', '/mnt/small:size=10m', 'alpine:3.20', 'sleep', 'infinity']); ok(run.status === 0, 'kontainer "server" simulasi berjalan');
  sim('apk add --no-cache curl procps findutils coreutils >/dev/null 2>&1');
  ok((await api('POST', '/api/login', { username: 'admin', password: PW })).status === 200, 'login ke aplikasi');
  for (const old of ((await api('GET', '/api/servers')).json || []).filter((x) => x.name === 'srv-sim-e2e')) await api('DELETE', `/api/servers/${old.id}`);   // sisa uji sebelumnya
  // server tanpa kunci SSH: satu-satunya jalur eksekusi adalah agen
  const s = (await api('POST', '/api/servers', { name: 'srv-sim-e2e', host: 'sim.local', username: 'root', exec_via: 'auto' })).json; ok(!!s.id, 'server dibuat tanpa kunci SSH');
  const g = (await api('POST', `/api/servers/${s.id}/agent`, { exec: true })).json; ok(g.keyId && g.script, 'kredensial agen dan panduan pemasangan dibuat');

  console.log('Pasang agen dari panduan');
  // bagian 1 dan 2 panduan (unduh + verifikasi checksum + konfigurasi); bagian systemd dilewati (alpine tanpa systemd). URL publik panduan -> alamat internal "app".
  const parts = g.script.split('# 3) Layanan systemd')[0].replaceAll(/https?:\/\/localhost:\d+/g, 'http://app:4317');
  const inst = sim(parts); ok(inst.status === 0, 'panduan (unduh, cek SHA256, pasang, konfigurasi) berjalan tanpa galat' + (inst.status ? ': ' + (inst.stderr || inst.stdout).slice(-300) : ''));
  ok(sim('test -x /usr/local/bin/aiops-agent && aiops-agent -version').stdout.includes('aiops-agent'), 'biner agen terpasang');
  // sesuaikan untuk uji: HTTP internal, interval pendek, pantau disk kecil
  const cfg = JSON.parse(g.configText); Object.assign(cfg, { server_url: 'http://app:4317', insecure_http: true, interval_seconds: 5, heartbeat_seconds: 15, thresholds: { load_per_core_crit: 0, mem_avail_pct_crit: 0, disk_pct_crit: 85, io_psi_crit: 0, disk_path: '/mnt/small' }, services: [] });
  sim(`cat > /etc/aiops-agent.json <<'J'\n${JSON.stringify(cfg, null, 2)}\nJ\nchmod 600 /etc/aiops-agent.json`);
  // journalctl palsu: --vacuum-size menghapus berkas besar (menirip perbaikan nyata yang mengubah kondisi)
  sim(`cat > /usr/local/bin/journalctl <<'J'\n#!/bin/sh\ncase "$*" in *--vacuum-size*) rm -f /mnt/small/big; echo "Vacuuming done, freed 9.0M";; *--disk-usage*) echo "Archived and active journals take up 9.0M in the file system.";; *) echo "-- tidak ada journal --";; esac\nJ\nchmod +x /usr/local/bin/journalctl`);
  const chk = sim('aiops-agent -check -config /etc/aiops-agent.json'); ok(/disk:\/mnt\/small\s+normal/.test(chk.stdout), '"aiops-agent -check" melaporkan disk normal sebelum insiden');
  sim('nohup aiops-agent -config /etc/aiops-agent.json > /tmp/agent.log 2>&1 &');
  ok(await until(async () => (await api('GET', `/api/servers/${s.id}/agent`)).json.agent?.online, 40000), 'agen online (detak jantung diterima aplikasi)');
  const pollsBefore = (appLog().match(/commands\/poll/g) || []).length;
  await sleep(12000);
  const idle = await api('GET', '/api/incidents?status=open'); ok(!idle.json.some((i) => i.server_name === 'srv-sim-e2e'), 'kondisi normal: tidak ada insiden dan tidak ada kejadian dikirim');
  ok((appLog().match(/commands\/poll/g) || []).length === pollsBefore, 'tanpa insiden agen tidak melakukan long-poll (tidak ada lalu lintas tambahan)');

  console.log('Insiden kritis');
  sim('dd if=/dev/zero of=/mnt/small/big bs=1M count=9 2>/dev/null');
  const inc = await until(async () => (await api('GET', '/api/incidents?status=open')).json.find((i) => i.server_name === 'srv-sim-e2e'), 45000);
  ok(!!inc, 'disk hampir penuh -> insiden kritis muncul di aplikasi (kunci ' + (inc?.key ?? '-') + ')');
  const det = inc && await until(async () => { const d = (await api('GET', `/api/incidents/${inc.id}`)).json; return d.recommendations.length ? d : null; }, 20000);
  ok(!!det, 'rekomendasi tersusun otomatis'); if (!det) throw new Error('berhenti: tidak ada rekomendasi');
  ok(det.incident.diag.length >= 1 && det.incident.diag.some((x) => /mnt\/small/.test(x.out)), 'insiden membawa diagnostik dari agen (df/du)');
  ok(det.path === 'agent', 'jalur eksekusi = agen (server tanpa SSH)');
  const rec = det.recommendations[0]; ok(rec.steps.some((x) => x.class === 'change' && /vacuum/.test(x.command)) && rec.steps.every((x) => x.status === 'pending'), 'rencana memuat langkah baca dan satu perubahan; belum ada yang dijalankan');
  ok(sim('ls /mnt/small/big').status === 0, 'berkas besar masih ada sebelum disetujui (tidak ada yang berjalan tanpa persetujuan)');

  console.log('Persetujuan dan eksekusi oleh agen');
  ok((await api('POST', `/api/recommendations/${rec.id}/approve`, {})).status === 200, 'rencana disetujui');
  const done = await until(async () => { const r = (await api('GET', `/api/recommendations/${rec.id}`)).json; return ['done', 'failed'].includes(r.status) ? r : null; }, 60000);
  ok(done?.status === 'done', 'semua langkah selesai via agen' + (done?.status === 'failed' ? ': ' + done.summary : ''));
  ok(done?.steps.filter((x) => x.status === 'done').every((x) => x.via === 'agent'), 'tiap langkah dijalankan lewat jalur agen');
  ok(sim('ls /mnt/small/big 2>&1').stdout.includes('No such file') || sim('ls /mnt/small/big').status !== 0, 'perubahan benar-benar terjadi di server (berkas besar terhapus oleh langkah vacuum)');
  ok(/disk|\/mnt\/small|Filesystem/i.test(done?.verify_out ?? ''), 'verifikasi (df) dijalankan dan dicatat');

  console.log('Pemulihan');
  const resolved = await until(async () => (await api('GET', '/api/incidents?status=resolved')).json.find((i) => i.id === inc.id), 45000);
  ok(!!resolved, 'agen melaporkan pulih -> insiden ditutup otomatis');
  ok((await api('GET', `/api/recommendations/${rec.id}`)).json.resolved_after === true, 'rekomendasi tercatat sebagai penyebab pulih (resolved_after)');
  const log = sim('cat /tmp/agent.log').stdout; ok(/kejadian open disk/.test(log) && /kejadian resolved disk/.test(log), 'log agen: tepat satu open dan satu resolved');
  const counts = { open: (log.match(/kejadian open /g) || []).length, resolved: (log.match(/kejadian resolved /g) || []).length }; ok(counts.open === 1 && counts.resolved === 1, 'tidak ada kejadian berulang selama kondisi berlangsung (open=' + counts.open + ', resolved=' + counts.resolved + ')');

} catch (e) { fail++; console.log('  GAGAL pengecualian: ' + e.message); }
finally {
  const tail = dock(['exec', SIM, 'sh', '-c', 'tail -8 /tmp/agent.log']).stdout; if (fail) console.log('\nlog agen (akhir):\n' + tail);
  dock(['rm', '-f', SIM]);
  const del = (await api('GET', '/api/servers')).json?.find?.((x) => x.name === 'srv-sim-e2e'); if (del) await api('DELETE', `/api/servers/${del.id}`);
}
console.log(`\n${pass} lolos, ${fail} gagal`); process.exit(fail ? 1 : 0);
