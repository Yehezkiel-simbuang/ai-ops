// Bahan pemasangan agen di server: info biner (checksum) dan panduan (konfigurasi + skrip). Tanpa HTTP.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const AGENT_FILES = /^(aiops-agent-linux-(amd64|arm64)|SHA256SUMS)$/;
const BINARIES = ['aiops-agent-linux-amd64', 'aiops-agent-linux-arm64'];

export function binaryInfo(binDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of BINARIES) { const p = resolve(binDir, f); if (existsSync(p)) out[f] = createHash('sha256').update(readFileSync(p)).digest('hex'); }
  return out;
}

/** Unit systemd agen. Agen berjalan sebagai root. Pengerasan dibagi dua: set dasar aman untuk keduanya, dan set ketat HANYA bila eksekusi perintah mati (hanya memantau).
 *  Dengan eksekusi menyala, perintah perbaikan yang disetujui perlu menulis ke /etc, memasang paket, dan memakai sudo, jadi NoNewPrivileges dan ProtectSystem tidak dipasang. */
const COMMON_HARDENING = ['LockPersonality=yes', 'RestrictRealtime=yes', 'RestrictSUIDSGID=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes'];
const MONITOR_ONLY_HARDENING = ['NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectSystem=full', 'ProtectHome=read-only'];
export function unitText(exec: boolean): string {
  return ['[Unit]', 'Description=AI Ops agent', 'After=network-online.target', 'Wants=network-online.target', '', '[Service]', 'ExecStart=/usr/local/bin/aiops-agent -config /etc/aiops-agent.json', 'Restart=always', 'RestartSec=5', 'StateDirectory=aiops-agent',
    ...COMMON_HARDENING, ...(exec ? [] : MONITOR_ONLY_HARDENING), '', '[Install]', 'WantedBy=multi-user.target'].join('\n');
}

/** Peringatan yang perlu dibaca sebelum menjalankan skrip: alamat yang tidak bisa dijangkau server lain, dan http tanpa enkripsi. */
export function guideWarnings(publicUrl: string): string[] {
  let u: URL; try { u = new URL(publicUrl); } catch { return []; }
  const out: string[] = [];
  const host = u.hostname.toLowerCase().replace('[', '').replace(']', '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.')) out.push(`Alamat ${u.host} hanya berlaku di komputer AI Ops sendiri. Server lain tidak bisa mengunduh agen dari sini ("Failed to connect to localhost"). Atur PUBLIC_URL ke alamat yang bisa dijangkau server itu, misalnya http://192.168.1.10:4317, mulai ulang aplikasi, lalu buat panduan ini lagi.`);
  if (u.protocol === 'http:') out.push('Alamat memakai http:// (tanpa enkripsi), jadi konfigurasi agen diberi insecure_http. Permintaan agen tetap bertanda tangan HMAC dan secret tidak ikut dikirim, tetapi isinya bisa dibaca di jaringan. Pakai hanya di jaringan lab yang tepercaya; untuk server sungguhan pakai https://.');
  return out;
}

export function installGuide(publicUrl: string, cred: { keyId: string; secret: string }, opt: { exec: boolean; services: string[] }) {
  const config = {
    server_url: publicUrl, ...(publicUrl.startsWith('http://') ? { insecure_http: true } : {}), key_id: cred.keyId, secret: cred.secret, interval_seconds: 30, heartbeat_seconds: 60, allow_exec: opt.exec,
    thresholds: { load_per_core_crit: 3, mem_avail_pct_crit: 5, disk_pct_crit: 95, io_psi_crit: 50, disk_path: '/' }, services: opt.services,
    security: { enabled: true, ssh_fail_crit: 30, ssh_fail_window_seconds: 600, root_login_crit: false, hold_minutes: 120 }
  };
  const configText = JSON.stringify(config, null, 2);
  const script = [
    '# 1) Unduh biner dan verifikasi checksum (jalankan sebagai root di server)',
    'A=$(case "$(uname -m)" in x86_64) echo amd64;; aarch64) echo arm64;; *) echo tidak-didukung;; esac)',
    `cd /tmp && curl -fsSLO ${publicUrl}/agent/download/aiops-agent-linux-$A && curl -fsSLO ${publicUrl}/agent/download/SHA256SUMS`,
    'grep " aiops-agent-linux-$A$" SHA256SUMS | sha256sum -c - && install -m 755 aiops-agent-linux-$A /usr/local/bin/aiops-agent',
    '',
    '# 2) Konfigurasi (berisi rahasia: mode 600)',
    "install -m 600 /dev/null /etc/aiops-agent.json && cat > /etc/aiops-agent.json <<'JSON'", configText, 'JSON',
    '',
    '# 3) Layanan systemd',
    "cat > /etc/systemd/system/aiops-agent.service <<'UNIT'", unitText(opt.exec), 'UNIT',
    'systemctl daemon-reload && systemctl enable --now aiops-agent',
    '',
    '# 4) Cek: agen mencetak hasil pemeriksaan tanpa mengirim apa pun',
    'aiops-agent -check -config /etc/aiops-agent.json'
  ].join('\n');
  return { config, configText, script };
}
