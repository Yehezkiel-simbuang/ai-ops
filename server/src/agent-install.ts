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

const UNIT = '[Unit]\nDescription=AI Ops agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=/usr/local/bin/aiops-agent -config /etc/aiops-agent.json\nRestart=always\nRestartSec=5\nStateDirectory=aiops-agent\n\n[Install]\nWantedBy=multi-user.target';

export function installGuide(publicUrl: string, cred: { keyId: string; secret: string }, opt: { exec: boolean; services: string[] }) {
  const config = {
    server_url: publicUrl, key_id: cred.keyId, secret: cred.secret, interval_seconds: 30, heartbeat_seconds: 60, allow_exec: opt.exec,
    thresholds: { load_per_core_crit: 3, mem_avail_pct_crit: 5, disk_pct_crit: 95, io_psi_crit: 50, disk_path: '/' }, services: opt.services
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
    "cat > /etc/systemd/system/aiops-agent.service <<'UNIT'", UNIT, 'UNIT',
    'systemctl daemon-reload && systemctl enable --now aiops-agent',
    '',
    '# 4) Cek: agen mencetak hasil pemeriksaan tanpa mengirim apa pun',
    'aiops-agent -check -config /etc/aiops-agent.json'
  ].join('\n');
  return { config, configText, script };
}
