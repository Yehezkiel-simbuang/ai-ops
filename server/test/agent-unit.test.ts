// Unit systemd agen: pengerasan. Agen berjalan sebagai root; set ketat hanya bila eksekusi perintah mati.
import { describe, expect, it } from 'vitest';
import { installGuide, unitText } from '../src/agent-install.js';

const keys = (u: string): string[] => u.split('\n').filter((l) => /^[A-Za-z]+=/.test(l)).map((l) => l.split('=')[0]!);

describe('unit systemd agen', () => {
  it('mode hanya-memantau: pengerasan penuh (tanpa hak baru, sistem berkas dibaca-saja, folder rumah baca-saja)', () => {
    const u = unitText(false);
    for (const k of ['NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectSystem=full', 'ProtectHome=read-only', 'LockPersonality=yes', 'RestrictRealtime=yes', 'RestrictSUIDSGID=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes']) expect(u, k).toContain(k);
  });
  it('mode dengan eksekusi: hanya set dasar, supaya perbaikan yang disetujui masih bisa menulis ke /etc, memasang paket, dan memakai sudo', () => {
    const u = unitText(true);
    for (const k of ['NoNewPrivileges', 'ProtectSystem', 'ProtectHome', 'PrivateTmp']) expect(u, k).not.toContain(k);
    for (const k of ['LockPersonality=yes', 'RestrictRealtime=yes', 'RestrictSUIDSGID=yes']) expect(u, k).toContain(k);
  });
  it('berkas unit tetap utuh: bagian, perintah mulai, restart, direktori status, dan tanpa kunci ganda', () => {
    for (const exec of [false, true]) {
      const u = unitText(exec), ks = keys(u);
      expect(u.startsWith('[Unit]\n')).toBe(true); expect(u).toContain('\n[Service]\n'); expect(u).toContain('\n[Install]\nWantedBy=multi-user.target');
      expect(u).toContain('ExecStart=/usr/local/bin/aiops-agent -config /etc/aiops-agent.json'); expect(u).toContain('Restart=always'); expect(u).toContain('StateDirectory=aiops-agent');
      expect(new Set(ks).size).toBe(ks.length);
      expect(u).not.toMatch(/^User=/m);   // sengaja root: agen perlu membaca log, /proc, dan menjalankan perbaikan
    }
  });
  it('skrip pemasangan memakai unit yang sesuai dengan pilihan eksekusi', () => {
    const cred = { keyId: 'ak_x', secret: 's'.repeat(43) };
    const monitor = installGuide('https://aiops.contoh.com', cred, { exec: false, services: [] }).script, exec = installGuide('https://aiops.contoh.com', cred, { exec: true, services: [] }).script;
    expect(monitor).toContain('ProtectSystem=full'); expect(monitor).toContain('"allow_exec": false'); expect(exec).not.toContain('ProtectSystem'); expect(exec).toContain('"allow_exec": true');
    for (const s of [monitor, exec]) { expect(s).toContain("cat > /etc/systemd/system/aiops-agent.service <<'UNIT'"); expect(s).toContain('\nUNIT\n'); expect(s).toContain('systemctl daemon-reload'); }
  });
});
