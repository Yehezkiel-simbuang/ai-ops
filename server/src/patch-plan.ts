// Rencana patch: dari daftar paket yang dilaporkan agen, susun rekomendasi (kind='patch') yang lewat alur persetujuan yang sama
// dengan perbaikan insiden. Tidak ada yang dijalankan sebelum pengguna menyetujui; restart layanan dan reboot TIDAK ikut dalam rencana
// (keduanya memutus layanan dan dikerjakan terpisah setelah hasil pemasangan terlihat).
import { audit, bad, db, HttpError } from './context.js';
import * as Agents from './agents.js';
import * as Incidents from './incidents.js';
import { classify } from './safety.js';
import * as Servers from './servers.js';
import type { PatchFacts } from './patching.js';
import type { VulnReport } from './vulns.js';

const NAME = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const VERSION = /^[A-Za-z0-9.+~:_-]{1,100}$/;
const MAX_PACKAGES = 100;

export interface Impact { impact: string | null; restart: string | null; reboot: boolean }
const RULES: Array<{ re: RegExp; restart?: string; reboot?: boolean; impact: string }> = [
  { re: /^(linux-image|linux-modules|linux-generic|linux-headers|linux-base)/, reboot: true, impact: 'Kernel baru: baru dipakai setelah reboot.' },
  { re: /^(libc6|libc-bin|libssl[0-9.]*|openssl)$/, restart: 'layanan yang memakai pustaka ini', impact: 'Pustaka inti: layanan yang sedang berjalan baru memakai versi baru setelah direstart; reboot paling bersih.' },
  { re: /^(systemd|systemd-sysv|libsystemd0|udev|libudev1)$/, restart: 'systemd', reboot: true, impact: 'systemd: sebagian perubahan baru berlaku setelah reboot.' },
  { re: /^openssh-(server|client|sftp-server)$/, restart: 'ssh', impact: 'SSH: sesi yang sedang terbuka biasanya tidak putus, tetapi pastikan masih ada cara masuk lain sebelum merestart.' },
  { re: /^(nginx|nginx-.*|apache2|apache2-.*|haproxy|caddy)$/, restart: 'web server', impact: 'Web server: restart memutus koneksi yang sedang berjalan sesaat.' },
  { re: /^(mysql-.*|mariadb-.*|postgresql(-[0-9]+)?|postgresql-common)$/, restart: 'database', impact: 'Database: restart memutus semua koneksi; jadwalkan di luar jam sibuk.' },
  { re: /^php[0-9.]*(-.*)?$/, restart: 'php-fpm', impact: 'PHP: php-fpm perlu direstart agar kode baru dipakai.' },
  { re: /^(redis|redis-.*)$/, restart: 'redis', impact: 'Redis: restart mengosongkan cache bila tanpa persistensi.' },
  { re: /^(docker-ce|docker\.io|containerd(\.io)?|runc)$/, restart: 'docker', impact: 'Docker: merestart docker dapat menghentikan kontainer yang tidak diatur restart otomatis.' }
];
export function impactOf(name: string): Impact {
  const r = RULES.find((x) => x.re.test(name));
  return { impact: r?.impact ?? null, restart: r?.restart ?? null, reboot: !!r?.reboot };
}

interface PlanPkg { name: string; old: string; new: string; sec: boolean; official: boolean; cves: string[]; exploited: string[]; impact: string | null }
export interface PlanMeta { packages: PlanPkg[]; restarts: string[]; reboot: boolean; totals: { packages: number; security: number; cves: number; exploited: number; thirdParty: number } }

const NO_PATH = 'Tidak ada jalur eksekusi: isi kunci SSH server, atau aktifkan agen dengan allow_exec=true dan pastikan agen online.';

/** Susun rencana patch dari paket yang dipilih (bawaan: yang bertanda keamanan; bila tidak ada, semua). Tidak menjalankan apa pun. */
export async function propose(serverId: number, names: string[] | null, by: string): Promise<number> {
  const server = await Servers.get(serverId); if (!server) throw new HttpError(404, 'Server tidak ada');
  const row = await db().one<{ patch: PatchFacts | null; patch_vulns: VulnReport | null }>('SELECT patch, patch_vulns FROM agents WHERE server_id=$1', [serverId]), f = row?.patch;
  if (!f?.packages?.length) throw bad('Belum ada daftar paket dari agen. Pasang agen dan tunggu laporan pertamanya, atau memang tidak ada pembaruan.');
  if (f.manager !== 'apt') throw bad('Penerapan patch baru mendukung Debian dan Ubuntu (apt).');
  if (Incidents.execPath(server, await Agents.statusOf(serverId)) === 'none') throw bad(NO_PATH);

  const known = new Map(f.packages.map((p) => [p.name, p]));
  const wanted = names?.length ? names : (f.packages.some((p) => p.sec) ? f.packages.filter((p) => p.sec) : f.packages).map((p) => p.name);
  const picked = [...new Set(wanted)];
  for (const n of picked) if (!known.has(n) || !NAME.test(n)) throw bad(`Paket "${n.slice(0, 60)}" tidak ada di daftar pembaruan server ini`);
  if (picked.length > MAX_PACKAGES) throw bad(`Terlalu banyak paket (maksimal ${MAX_PACKAGES} sekali jalan); pilih yang paling penting dulu.`);
  if (picked.some((n) => !VERSION.test(known.get(n)!.old) || !VERSION.test(known.get(n)!.new))) throw bad('Ada versi paket dengan karakter yang tidak dikenal; rencana tidak dibuat.');

  const vulns = new Map((row?.patch_vulns?.pkgs ?? []).map((p) => [p.name, p]));
  const packages: PlanPkg[] = picked.map((n) => { const p = known.get(n)!, v = vulns.get(n); return { name: n, old: p.old, new: p.new, sec: p.sec, official: p.official !== false, cves: v?.cves ?? [], exploited: v?.exploited ?? [], impact: impactOf(n).impact }; });
  const restarts = [...new Set(picked.map((n) => impactOf(n).restart).filter((x): x is string => !!x))], reboot = picked.some((n) => impactOf(n).reboot);
  const allCves = new Set(packages.flatMap((p) => p.cves)), hot = new Set(packages.flatMap((p) => p.exploited));
  const totals = { packages: packages.length, security: packages.filter((p) => p.sec).length, cves: allCves.size, exploited: hot.size, thirdParty: packages.filter((p) => !p.official).length };
  const meta: PlanMeta = { packages, restarts, reboot, totals };

  const sudo = server.use_sudo ? 'sudo -n ' : '', list = picked.join(' ');
  const rollback = `${sudo}apt-get install -y --allow-downgrades ${packages.map((p) => `${p.name}=${p.old}`).join(' ')}`;
  const steps: Array<{ title: string; command: string; rationale: string; risk: 'rendah' | 'sedang' | 'tinggi'; rollback?: string }> = [
    { title: 'Cek ruang disk dan paket yang ditahan', command: 'df -h / /var; apt-mark showhold', rationale: 'Memastikan ada ruang untuk mengunduh dan tidak ada paket yang sengaja ditahan.', risk: 'rendah' },
    { title: 'Perbarui daftar paket', command: `${sudo}env DEBIAN_FRONTEND=noninteractive apt-get update`, rationale: 'Mengambil daftar terbaru dari repositori supaya yang dipasang adalah versi terbaru.', risk: 'rendah' },
    { title: `Pasang ${packages.length} pembaruan terpilih`, command: `${sudo}env DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade -o Dpkg::Options::=--force-confold ${list}`, rationale: 'Hanya meningkatkan paket yang sudah terpasang (tanpa memasang paket baru) dan mempertahankan berkas konfigurasi Anda.', risk: restarts.length || reboot ? 'sedang' : 'rendah', rollback },
    { title: 'Cek layanan yang perlu restart', command: `command -v needrestart >/dev/null && ${sudo}needrestart -b || echo "needrestart tidak terpasang; periksa layanan yang perlu restart secara manual"`, rationale: 'Menunjukkan layanan yang masih memakai versi lama setelah pembaruan. Restartnya tidak dilakukan otomatis.', risk: 'rendah' },
    { title: 'Cek layanan yang gagal', command: 'systemctl list-units --failed --no-legend --no-pager', rationale: 'Memastikan tidak ada layanan yang rusak setelah pembaruan.', risk: 'rendah' },
    { title: 'Cek apakah perlu reboot', command: 'test -f /var/run/reboot-required && cat /var/run/reboot-required || echo "tidak ada permintaan restart server"', rationale: 'Kernel atau pustaka inti yang diperbarui baru dipakai setelah reboot. Reboot disetujui terpisah, di luar rencana ini.', risk: 'rendah' }
  ];

  const lines = [
    `${totals.packages} paket akan diperbarui${totals.security ? ` (${totals.security} keamanan)` : ''}${totals.cves ? `, menutup ${totals.cves} CVE` : ''}.`,
    totals.exploited ? `${totals.exploited} CVE di antaranya sedang dieksploitasi (daftar CISA KEV): patch ini mendesak.` : '',
    restarts.length ? `Layanan yang kemungkinan perlu direstart setelahnya: ${restarts.join(', ')}. Restart tidak ikut dalam rencana ini.` : 'Tidak ada layanan yang jelas perlu direstart, tetapi periksa hasil langkah 4.',
    reboot ? 'Reboot kemungkinan diperlukan (kernel atau systemd). Reboot dikerjakan terpisah, di luar rencana ini.' : '',
    totals.thirdParty ? `${totals.thirdParty} paket berasal dari repositori pihak ketiga, jadi kerentanannya tidak bisa dicek.` : '',
    'Dampak di atas adalah perkiraan dari nama paket, bukan jaminan. Simpan snapshot atau cadangan sebelum patch besar.'
  ].filter(Boolean);

  return db().tx(async (t) => {
    await t.exec("UPDATE recommendations SET status='superseded', updated=$1 WHERE server_id=$2 AND kind='patch' AND status IN ('proposed','failed')", [Date.now(), serverId]);
    const rec = (await t.one<{ id: number }>("INSERT INTO recommendations(incident_id,server_id,created,updated,source,diagnosis,verify,kind,title,meta) VALUES(NULL,$1,$2,$2,'playbook',$3,$4,'patch',$5,$6::jsonb) RETURNING id",
      [serverId, Date.now(), lines.join('\n'), 'systemctl list-units --failed --no-legend --no-pager | wc -l', `Patch ${server.name}: ${totals.packages} paket`, JSON.stringify(meta)]))!;
    let n = 0;
    for (const s of steps) {
      const c = classify(s.command); if (c.cls === 'blocked') throw new Error(`Langkah rencana patch diblokir kebijakan: ${c.why}`);   // tidak boleh terjadi; jangan menyimpan rencana yang tidak bisa jalan
      await t.exec('INSERT INTO rec_steps(rec_id,n,title,command,class,risk,rationale,rollback) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [rec.id, ++n, s.title, s.command, c.cls, s.risk, s.rationale, s.rollback ?? '']);
    }
    await audit(by, 'patch.rencana', `#${rec.id} ${server.name}: ${totals.packages} paket`);
    return rec.id;
  });
}

/** Satu rencana beserta langkah, jalur eksekusi, dan ringkasan dampaknya. */
export async function detail(recId: number) {
  const rec = await db().one<Record<string, any>>("SELECT * FROM recommendations WHERE id=$1 AND kind='patch'", [recId]);
  if (!rec) throw new HttpError(404, 'Rencana patch tidak ada');
  const server = await Servers.get(rec.server_id), steps = await db().query('SELECT * FROM rec_steps WHERE rec_id=$1 ORDER BY n', [recId]);
  return { ...rec, steps, server_name: server?.name ?? '', path: server ? Incidents.execPath(server, await Agents.statusOf(rec.server_id)) : 'none' };
}
