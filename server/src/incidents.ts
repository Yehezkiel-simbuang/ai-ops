// Insiden dari agen -> rekomendasi perbaikan -> persetujuan pengguna -> eksekusi -> verifikasi.
// Rekomendasi disusun dari playbook deterministik (selalu ada) lalu, bila model dikonfigurasi, disempurnakan oleh model.
// Setiap perintah diklasifikasi ulang oleh kebijakan (safety.ts) dan yang diblokir tidak pernah dijalankan.
// Perintah hanya dijalankan setelah pengguna menyetujui rencana; perintah yang disimpan tidak bisa berubah setelah itu.
import { z } from 'zod';
import * as Agents from './agents.js';
import { audit, bad, db, HttpError, log } from './context.js';
import { forRole, type RoleChat } from './llm.js';
import { isLevel, rank, RANK, type Level } from './levels.js';
import * as Monitor from './monitor.js';
import * as Notify from './notify.js';
import { classify } from './safety.js';
import { redactOutput } from './redact.js';
import * as Servers from './servers.js';
import { getRole } from './store.js';

const dep: { llm: RoleChat } = { llm: forRole };
export function configure(o: { llm?: RoleChat }): void { if (o.llm) dep.llm = o.llm; }

// ---------- kejadian masuk dari agen
// severity dari agen: info | minor | major | critical (nilai lain dianggap critical)
export const eventSchema = z.object({
  id: z.string().min(4).max(64), type: z.enum(['open', 'still_open', 'resolved']), key: z.string().min(1).max(120), title: z.string().max(200).default(''), kind: z.string().max(40).default('other'),
  severity: z.string().max(20).default('critical'), value: z.number().finite().nullish(), detail: z.string().max(600).default(''), ts: z.number().int().positive(),
  diag: z.array(z.object({ name: z.string().max(80), out: z.string().max(2500) })).max(8).optional()
});
export type AgentEvent = z.infer<typeof eventSchema>;

/** Waktu kejadian (ms). Agen mengirim jam kejadian aslinya (detik), jadi kejadian yang tertunda di spool saat aplikasi mati tetap tercatat pada jam sebenarnya, bukan jam tiba.
 *  Dibatasi: tidak lebih baru dari saat diterima (jam agen maju) dan tidak lebih tua dari 30 hari (batas penyimpanan kejadian). */
export const eventTime = (tsSec: number, receivedMs: number): number => Math.min(receivedMs, Math.max(receivedMs - 30 * 864e5, tsSec * 1000));

export async function ingest(serverId: number, events: AgentEvent[]): Promise<{ accepted: number; duplicates: number }> {
  let accepted = 0, duplicates = 0;
  for (const e of events) {
    const fresh = await db().exec('INSERT INTO agent_events(id,server_id,ts,type,key,received) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [e.id, serverId, e.ts, e.type, e.key, Date.now()]);
    if (!fresh) { duplicates++; continue; }
    accepted++;
    const received = Date.now(), now = eventTime(e.ts, received), alertKey = 'ag:' + e.key;   // now = jam kejadian di agen
    if (e.type === 'resolved') {
      const inc = await db().one("UPDATE incidents SET status='resolved', resolved_at=GREATEST(opened,$1), last_event=GREATEST(opened,$1) WHERE server_id=$2 AND key=$3 AND status='open' RETURNING *", [now, serverId, e.key]);
      await Monitor.syncAlerts(serverId, [{ key: alertKey, on: false }], 'agent');
      if (inc) {
        await db().exec("UPDATE recommendations SET status='superseded', summary=COALESCE(NULLIF(summary,''),'Pulih sebelum rencana disetujui') WHERE incident_id=$1 AND status='proposed'", [inc.id]);
        await db().exec("UPDATE recommendations SET resolved_after=true WHERE incident_id=$1 AND status IN ('done','executing')", [inc.id]);
      }
      continue;
    }
    const dg = JSON.stringify(e.diag ?? []), level: Level = isLevel(e.severity) ? e.severity : 'critical';
    const existing = await db().one("SELECT * FROM incidents WHERE server_id=$1 AND key=$2 AND status='open'", [serverId, e.key]);
    if (existing) {
      if (level !== existing.severity) {   // agen melaporkan tingkat baru (naik atau turun)
        await db().exec('UPDATE incidents SET severity=$1 WHERE id=$2', [level, existing.id]);
        await Monitor.syncAlerts(serverId, [{ key: alertKey, on: true, level, title: e.title || e.key, detail: e.detail }], 'agent');   // naik: dikabari lagi; turun: diperbarui diam-diam
        if (rank(level) >= RANK.major && rank(existing.severity) < RANK.major) void generate(existing.id).catch((err) => log().warn({ err: (err as Error).message, incident: existing.id }, 'gagal menyusun rekomendasi'));
      }
      if (e.diag?.length) await db().exec('UPDATE incidents SET last_event=GREATEST(last_event,$1), detail=$2, value=$3, event_count=event_count+1, diag=$4::jsonb WHERE id=$5', [now, e.detail, e.value ?? null, dg, existing.id]);
      else await db().exec('UPDATE incidents SET last_event=GREATEST(last_event,$1), detail=$2, value=$3, event_count=event_count+1 WHERE id=$4', [now, e.detail, e.value ?? null, existing.id]);
      continue;
    }
    const inc = await db().one<{ id: number }>("INSERT INTO incidents(server_id,key,kind,title,severity,detail,value,opened,last_event,diag) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9::jsonb) ON CONFLICT DO NOTHING RETURNING id", [serverId, e.key, e.kind, e.title || e.key, level, e.detail, e.value ?? null, now, dg]);
    if (!inc) continue;
    await Monitor.syncAlerts(serverId, [{ key: alertKey, on: true, level, title: e.title || e.key, detail: e.detail }], 'agent', now);
    if (rank(level) >= RANK.major) void generate(inc.id).catch((err) => log().warn({ err: (err as Error).message, incident: inc.id }, 'gagal menyusun rekomendasi'));
  }
  return { accepted, duplicates };
}

// ---------- playbook (tanpa model)
export interface StepSpec { title: string; command: string; rationale: string; risk: 'rendah' | 'sedang' | 'tinggi'; rollback?: string }
interface Plan { diagnosis: string; steps: StepSpec[]; verify: string }
const q = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";
const SAFE = /^[A-Za-z0-9@._:/-]+$/;

/** Redis tidak aktif. Kasus yang sudah terjadi: server mati mendadak, berkas AOF terpotong atau berisi nol, lalu Redis keluar tiap kali memuat dan systemd menyalakannya lagi
 *  (unit terus "activating", NRestarts naik, log: "Bad file format reading the append only file"). Hanya baca dan cadangan; memotong AOF (--fix) sengaja tidak otomatis karena menghapus data. */
export function redisPlan(unit: string, sudo: string): Plan {
  const read = (title: string, command: string, rationale: string): StepSpec => ({ title, command, rationale, risk: 'rendah' });
  return {
    diagnosis: `Layanan ${unit} tidak aktif. Penyebab yang sering: (1) crash-loop setelah server mati mendadak: berkas AOF terpotong atau berisi nol sehingga Redis keluar saat memuat; unit terus berstatus activating dan NRestarts naik, log menyebut "Bad file format reading the append only file"; (2) port 6379 masih dipegang proses lama; (3) pemilik atau izin direktori data tidak cocok dengan unit; (4) memori tidak cukup untuk memuat data. `
      + 'Langkah baca mengumpulkan buktinya. Bila AOF rusak, "redis-check-aof" tanpa --fix melaporkan "diff", yaitu byte yang akan terpotong; diff kecil di ujung file berarti kehilangan data sedikit. '
      + 'Memperbaiki dengan "redis-check-aof --fix" memotong file dan menghapus semua data setelah titik rusak, jadi sengaja tidak ada di rencana ini: lakukan sendiri setelah cadangan ada dan diff-nya Anda nilai kecil. Jangan hapus appendonlydir atau dump.rdb. Ini layanan data: restart memutus semua koneksi.',
    steps: [
      read('Status layanan dan jumlah restart', `${sudo}systemctl status ${unit} --no-pager -n 20 ; ${sudo}systemctl show ${unit} -p NRestarts -p Result -p ExecMainStatus -p TimeoutStartUSec`, 'Status terus "activating" dan NRestarts yang naik menandakan crash-loop, bukan layanan yang sekadar mati.'),
      read('Journal terakhir', `${sudo}journalctl -u ${unit} -n 60 --no-pager`, 'Mencari penyebab berhenti: konfigurasi, izin, port terpakai, OOM.'),
      read('Log Redis', `${sudo}tail -n 80 /var/log/redis/redis-server.log`, 'Alasan Redis keluar ada di sini, mis. "Bad file format reading the append only file". Jalur bawaan Debian/Ubuntu; sesuaikan bila logfile di redis.conf berbeda.'),
      read('Berkas data dan AOF (ukuran dan jam ubah)', `${sudo}ls -l --time-style=long-iso /var/lib/redis /var/lib/redis/appendonlydir ; df -h /var/lib/redis`, 'Berkas yang jam ubahnya berhenti berbulan-bulan berarti persistensi mati sejak itu; disk penuh juga merusak AOF.'),
      read('Periksa AOF (baca saja)', `${sudo}redis-check-aof /var/lib/redis/appendonlydir/appendonly.aof.manifest`, 'Melaporkan byte pertama yang rusak (ok_up_to) dan jumlah byte sesudahnya (diff). Tanpa --fix tidak mengubah apa pun.'),
      read('Memori dan overcommit', `${sudo}free -m ; ${sudo}sysctl vm.overcommit_memory`, 'Memuat data besar butuh RAM; overcommit 0 membuat fork untuk snapshot bisa gagal, dan snapshot yang berhenti membuat berkas data basi.'),
      { title: `Hentikan ${unit} (putus siklus restart)`, command: `${sudo}systemctl stop ${unit}`, rationale: 'Menyalin berkas data saat Redis sedang memuat atau menulis tidak konsisten.', risk: 'sedang', rollback: `${sudo}systemctl start ${unit}` },
      { title: 'Cadangkan direktori data Redis', command: `${sudo}cp -a /var/lib/redis /root/redis-backup-$(date +%Y%m%d%H%M)`, rationale: 'Salinan utuh sebelum berkas apa pun diperbaiki atau dipotong. Pastikan ruang disk cukup (lihat langkah berkas data).', risk: 'sedang', rollback: 'Salinan tidak mengubah data asli; hapus manual bila tidak diperlukan.' },
      { title: `Jalankan ulang ${unit}`, command: `${sudo}systemctl restart ${unit}`, rationale: 'Hanya setelah penyebab jelas dan diperbaiki; bila AOF masih rusak, Redis akan kembali crash-loop.', risk: 'tinggi', rollback: `${sudo}systemctl status ${unit} --no-pager` }
    ],
    verify: `${sudo}systemctl is-active ${unit}`
  };
}

export function playbook(inc: { key: string; kind: string; title: string; detail: string }, server: { use_sudo: boolean }): Plan {
  const sudo = server.use_sudo ? 'sudo -n ' : '';
  const arg = inc.key.includes(':') ? inc.key.slice(inc.key.indexOf(':') + 1) : '';
  const read = (title: string, command: string, rationale: string): StepSpec => ({ title, command, rationale, risk: 'rendah' });
  switch (inc.kind) {
    case 'service': {
      const unit = SAFE.test(arg) ? arg : '';
      if (!unit) break;
      if (/^redis(-server)?$/.test(unit)) return redisPlan(unit, sudo);
      const db = /^(mysql|mysqld|mariadb|postgresql|redis|redis-server)/.test(unit);
      return { diagnosis: `Layanan ${unit} tidak aktif. Periksa dulu penyebabnya di status dan journal; restart hanya bila penyebabnya sudah jelas dan aman.${db ? ' Ini layanan data: restart memutus semua koneksi yang sedang berjalan.' : ''}`,
        steps: [read('Lihat status layanan', `${sudo}systemctl status ${unit} --no-pager -n 20`, 'Memastikan keadaan dan pesan galat terakhir.'), read('Baca journal terakhir', `${sudo}journalctl -u ${unit} -n 60 --no-pager`, 'Mencari penyebab berhenti (OOM, konfigurasi salah, disk penuh).'),
          { title: `Jalankan ulang ${unit}`, command: `${sudo}systemctl restart ${unit}`, rationale: 'Memulihkan layanan setelah penyebab diperiksa.', risk: db ? 'tinggi' : 'sedang', rollback: `${sudo}systemctl status ${unit} --no-pager` }],
        verify: `${sudo}systemctl is-active ${unit}` };
    }
    case 'disk': {
      const path = SAFE.test(arg) ? arg : '/';
      return { diagnosis: `Disk ${path} hampir penuh. Cari penyebab terbesar dulu. Pembersihan yang aman: memangkas journal systemd; penghapusan berkas aplikasi sebaiknya Anda putuskan sendiri setelah melihat daftar.`,
        steps: [read('Direktori terbesar', `du -xk -d1 ${q(path)} 2>/dev/null | sort -rn | head -12`, 'Menemukan lokasi pemakaian terbesar.'), read('Berkas log besar', 'find /var/log -type f -size +100M', 'Log besar adalah penyebab paling umum.'), read('Pemakaian journal', `${sudo}journalctl --disk-usage`, 'Memeriksa ukuran journal systemd.'),
          { title: 'Pangkas journal hingga 200 MB', command: `${sudo}journalctl --vacuum-size=200M`, rationale: 'Membebaskan ruang tanpa menyentuh berkas aplikasi; data journal lama hilang.', risk: 'rendah', rollback: 'Tidak bisa dibalik; hanya log lama yang terhapus.' }],
        verify: `df -P ${q(path)}` };
    }
    case 'mem':
      return { diagnosis: 'Memori tersedia hampir habis. Temukan proses terbesar dan cek apakah OOM killer sudah bertindak. Mengurangi pemakaian (mis. memperkecil pool atau me-restart proses yang bocor) butuh keputusan Anda.',
        steps: [read('Ringkasan memori', 'free -m', 'Melihat total, tersedia, dan swap.'), read('Proses terbesar (memori)', 'ps -eo pid,pmem,rss,etime,comm --sort=-pmem | head -12', 'Menunjuk pelaku utama.'), read('Jejak OOM', `${sudo}journalctl -k --no-pager | grep -i "out of memory" | tail -5`, 'Memeriksa apakah kernel sudah membunuh proses.')],
        verify: 'free -m' };
    case 'load':
      return { diagnosis: 'Beban CPU sangat tinggi. Cari proses yang memakai CPU dan apakah penyebabnya menunggu I/O (iowait) atau komputasi.',
        steps: [read('Beban dan uptime', 'uptime', 'Melihat tren 1/5/15 menit.'), read('Proses teratas (CPU)', 'ps -eo pid,pcpu,pmem,stat,etime,comm --sort=-pcpu | head -12', 'Menunjuk pelaku utama.'), read('Statistik CPU/IO', 'vmstat 1 5', 'Membedakan CPU sibuk dari menunggu disk.')], verify: 'uptime' };
    case 'io':
      return { diagnosis: 'Tekanan I/O disk kritis: proses menunggu disk. Pada penyimpanan bersama atau lambat (RAID, SAN, disk jaringan, ZFS tanpa perangkat log) pola ini sering berupa stall fsync. Ukur latensi per perangkat sebelum mengubah apa pun.',
        steps: [read('PSI I/O', 'cat /proc/pressure/io', 'Mengukur seberapa lama proses menunggu I/O.'), read('Proses menunggu I/O (D)', "ps -eo pid,stat,wchan:20,comm | awk '$2 ~ /^D/' | head -15", 'Menunjuk proses yang tertahan.'), read('Latensi per perangkat', 'iostat -x 1 3', 'await dan %util tiap perangkat.'), read('Pool ZFS (jika ada)', `${sudo}zpool iostat -l 1 3`, 'Latensi sinkron/asinkron pada pool ZFS.')], verify: 'cat /proc/pressure/io' };
    case 'log': {
      const m = /^log:(.+)$/.exec(inc.key);
      return { diagnosis: `Kemunculan pesan di log melonjak (${m?.[1] ?? 'log'}). Baca baris terbaru untuk menentukan penyebab.`, steps: [read('Ekor log', 'journalctl -n 80 --no-pager', 'Konteks kejadian di journal sistem.')], verify: 'uptime' };
    }
    case 'security': {
      // Hanya langkah baca: apa yang harus DIUBAH (blokir IP, hapus akun, cabut kunci) adalah keputusan pemilik server setelah melihat buktinya.
      const topic = arg || 'umum';
      const common = [read('Login terakhir', 'last -n 25 -w', 'Siapa yang masuk, dari mana, dan kapan.'), read('Koneksi SSH yang sedang aktif', "ss -tn state established '( sport = :22 )' | head -20", 'Memastikan tidak ada sesi yang tidak dikenal sedang terbuka.')];
      const diag: Record<string, { text: string; steps: StepSpec[] }> = {
        ssh_fail: { text: 'Banyak login SSH gagal dalam waktu singkat: kemungkinan brute force. Periksa apakah ada yang berhasil masuk setelah rentetan gagal, dan dari IP mana. Memblokir IP atau mengunci login password adalah keputusan Anda.', steps: [read('Percobaan gagal terbaru', `${sudo}journalctl -u ssh -u sshd -n 80 --no-pager | grep -E "Failed|Invalid" | tail -40`, 'Melihat pola nama pengguna dan sumber.'), read('Login yang berhasil', `${sudo}journalctl -u ssh -u sshd -n 200 --no-pager | grep Accepted | tail -15`, 'Memastikan tidak ada yang berhasil masuk dari sumber yang sama.'), ...common] },
        root_login: { text: 'Ada login root yang berhasil lewat SSH. Bila itu bukan Anda atau tim Anda, anggap server terkompromi: periksa sesi aktif dan kunci yang dipakai.', steps: [...common, read('Kunci yang diizinkan untuk root', `${sudo}ls -la /root/.ssh`, 'Melihat kapan berkas kunci terakhir diubah.')] },
        users: { text: 'Ada akun baru yang bisa login (atau akun lama berubah shell/UID). Pastikan itu perubahan yang disengaja.', steps: [read('Akun yang bisa login', "getent passwd | cut -d: -f1,3,6,7 | grep -Ev ':(/usr)?/s?bin/(nologin|false)$'", 'Daftar akun dengan UID, folder rumah, dan shell.'), read('Akun bersandi UID 0', "getent passwd | awk -F: '$3==0'", 'Hanya root yang seharusnya UID 0.'), ...common] },
        keys: { text: 'Berkas authorized_keys berubah: ada kunci SSH yang ditambah atau diganti. Kunci tak dikenal berarti ada pintu masuk baru.', steps: [read('Berkas kunci dan waktu ubahnya', `${sudo}ls -la --time-style=full-iso /root/.ssh /home/*/.ssh`, 'Melihat berkas mana yang berubah dan kapan.'), read('Jenis dan komentar kunci (tanpa isi kunci)', `${sudo}cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys | cut -d' ' -f1,3-`, 'Mencocokkan dengan kunci yang Anda kenal; isi kunci sengaja tidak ditampilkan.'), ...common] },
        sudoers: { text: 'Aturan sudo berubah. Perubahan seperti NOPASSWD untuk akun biasa memberi akses root tanpa sandi.', steps: [read('Isi sudoers.d', `${sudo}ls -la --time-style=full-iso /etc/sudoers.d`, 'Berkas mana yang baru atau berubah.'), read('Aturan NOPASSWD', `${sudo}grep -rn NOPASSWD /etc/sudoers /etc/sudoers.d`, 'Akun yang bisa sudo tanpa sandi.'), read('Anggota grup sudo', 'getent group sudo wheel', 'Siapa yang punya hak sudo.')] },
        sshd: { text: 'Konfigurasi sshd berubah. Periksa pengaturan yang melemahkan keamanan (PermitRootLogin, PasswordAuthentication, port).', steps: [read('Pengaturan sshd yang penting', 'grep -Ein "^[[:space:]]*(permitrootlogin|passwordauthentication|port|pubkeyauthentication|allowusers)" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf', 'Nilai yang tertulis di berkas; bila ada beberapa, yang paling awal dibaca sshd yang berlaku.'), read('Berkas konfigurasi dan waktu ubahnya', 'ls -la --time-style=full-iso /etc/ssh/sshd_config /etc/ssh/sshd_config.d', 'Berkas mana yang berubah.')] },
        ports: { text: 'Ada port baru yang mendengarkan dari luar. Cari prosesnya dan pastikan memang layanan yang Anda pasang.', steps: [read('Port mendengarkan beserta prosesnya', `${sudo}ss -ltnp`, 'Proses yang memegang tiap port.'), read('Waktu mulai proses', 'ps -eo pid,lstart,user,comm --sort=start_time | tail -15', 'Proses yang baru dijalankan.')] }
      };
      const d = diag[topic] ?? { text: `${inc.title}: ${inc.detail}. Kumpulkan bukti dulu sebelum mengubah apa pun.`, steps: common };
      return { diagnosis: d.text, steps: d.steps, verify: 'last -n 5 -w' };
    }
    case 'port': case 'http':
      return { diagnosis: 'Layanan tidak menjawab di port/URL yang dipantau. Pastikan prosesnya hidup dan port benar-benar didengarkan.',
        steps: [read('Port mendengarkan', 'ss -ltnp | head -25', 'Memeriksa proses yang memegang port.'), read('Proses web/DB', 'ps -eo pid,pcpu,pmem,etime,comm --sort=-pcpu | head -10', 'Memeriksa apakah proses utama hidup.')], verify: 'ss -ltn | head -15' };
  }
  return { diagnosis: `${inc.title}: ${inc.detail}. Belum ada playbook khusus; kumpulkan keadaan dasar server.`, steps: [read('Beban dan memori', 'uptime && free -m', 'Gambaran umum.'), read('Proses teratas', 'ps -eo pid,pcpu,pmem,etime,comm --sort=-pcpu | head -10', 'Pelaku utama.')], verify: 'uptime' };
}

// ---------- penyempurnaan oleh model (opsional)
const llmSchema = z.object({ diagnosis: z.string().max(2000), steps: z.array(z.object({ title: z.string().max(160), command: z.string().min(1).max(1500), rationale: z.string().max(400).default(''), risk: z.enum(['rendah', 'sedang', 'tinggi']).default('sedang'), rollback: z.string().max(400).default('') })).max(8), verify: z.string().max(500).default('') });

async function refine(base: Plan, inc: Record<string, any>, server: Servers.ServerRow): Promise<{ plan: Plan; source: 'llm' | 'playbook' }> {
  const role = (await getRole('setup')) ? 'setup' : (await getRole('monitor')) ? 'monitor' : null;
  if (!role) return { plan: base, source: 'playbook' };
  const diag = (inc.diag as Array<{ name: string; out: string }>).map((d) => `## ${d.name}\n${d.out}`).join('\n\n').slice(0, 7000);
  const prompt = `Insiden kritis di server "${server.name}" (${server.os_info || 'OS tidak diketahui'}${server.use_sudo ? ', ada sudo -n' : ', tanpa sudo'}).\nJudul: ${inc.title}\nDetail: ${inc.detail}\nJenis: ${inc.kind}\nCatatan pemilik: ${server.notes || '(tidak ada)'}\n\nDATA DIAGNOSTIK dari agen saat insiden mulai:\n${diag || '(tidak ada)'}\n\nRencana dasar (playbook):\n${base.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.command}`).join('\n')}\n\nTugas: tulis diagnosis singkat berbasis data di atas (jangan mengarang) dan rencana perbaikan. Aturan: maks. 6 langkah, satu perintah shell per langkah, non-interaktif; langkah BACA dulu, perubahan sekecil dan semudah dibalik mungkin dengan cadangan dulu bila menyentuh berkas konfigurasi; jangan pernah mengusulkan reboot, penghapusan rekursif, format, atau DROP DATABASE. Sertakan "rollback" untuk tiap langkah yang mengubah sesuatu dan satu perintah "verify" yang hanya membaca.\nBalas HANYA JSON: {"diagnosis":"...","steps":[{"title":"","command":"","rationale":"","risk":"rendah|sedang|tinggi","rollback":""}],"verify":"..."}`;
  try {
    const r = await dep.llm(role, { system: 'Kamu SRE senior yang teliti. Bahasa Indonesia, ringkas, berbasis bukti.', messages: [{ role: 'user', content: prompt }], maxTokens: 1800 });
    const t = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
    const parsed = llmSchema.safeParse(JSON.parse(t.slice(a, b + 1)));
    if (!parsed.success || !parsed.data.steps.length) return { plan: base, source: 'playbook' };
    return { plan: { diagnosis: parsed.data.diagnosis, steps: parsed.data.steps, verify: parsed.data.verify || base.verify }, source: 'llm' };
  } catch (e) { log().warn({ err: (e as Error).message }, 'penyempurnaan model gagal; memakai playbook'); return { plan: base, source: 'playbook' }; }
}

// ---------- menyusun dan menyimpan rekomendasi
export async function generate(incidentId: number, opt: { useModel?: boolean } = {}): Promise<number> {
  const inc = await db().one('SELECT * FROM incidents WHERE id=$1', [incidentId]); if (!inc) throw bad('Insiden tidak ada');
  const server = await Servers.get(inc.server_id); if (!server) throw bad('Server tidak ada');
  const base = playbook(inc as never, server), { plan, source } = opt.useModel === false ? { plan: base, source: 'playbook' as const } : await refine(base, inc, server);
  const verifyClass = plan.verify ? classify(plan.verify) : { cls: 'read' as const };
  const verify = verifyClass.cls === 'read' ? plan.verify : base.verify;
  await db().exec("UPDATE recommendations SET status='superseded', updated=$1 WHERE incident_id=$2 AND status IN ('proposed','failed')", [Date.now(), incidentId]);
  const id = await db().tx(async (t) => {
    const rec = (await t.one<{ id: number }>('INSERT INTO recommendations(incident_id,server_id,created,updated,source,diagnosis,verify) VALUES($1,$2,$3,$3,$4,$5,$6) RETURNING id', [incidentId, inc.server_id, Date.now(), source, plan.diagnosis, verify]))!;
    let n = 0;
    for (const s of plan.steps) {
      const c = classify(s.command); if (c.cls === 'blocked') continue;   // tidak pernah disimpan, apalagi dijalankan
      await t.exec('INSERT INTO rec_steps(rec_id,n,title,command,class,risk,rationale,rollback) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [rec.id, ++n, s.title, s.command, c.cls, s.risk, s.rationale, s.rollback ?? '']);
    }
    return rec.id;
  });
  Notify.recommendationReady(server.name, inc.title, plan.diagnosis, source);
  return id;
}

export async function listIncidents(status?: string) {
  const where = status === 'open' || status === 'resolved' ? 'WHERE i.status=$1' : '';
  const rows = await db().query(`SELECT i.id, i.server_id, s.name AS server_name, i.key, i.kind, i.title, i.severity, i.detail, i.value, i.opened, i.last_event, i.resolved_at, i.status, i.event_count,
      (SELECT r.status FROM recommendations r WHERE r.incident_id=i.id ORDER BY r.id DESC LIMIT 1) AS rec_status, (SELECT r.id FROM recommendations r WHERE r.incident_id=i.id ORDER BY r.id DESC LIMIT 1) AS rec_id
    FROM incidents i JOIN servers s ON s.id=i.server_id ${where} ORDER BY i.status, CASE i.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, i.opened DESC LIMIT 100`, where ? [status] : []);
  return rows;
}
export async function incidentDetail(id: number) {
  const inc = await db().one('SELECT i.*, s.name AS server_name FROM incidents i JOIN servers s ON s.id=i.server_id WHERE i.id=$1', [id]); if (!inc) throw new HttpError(404, 'Insiden tidak ada');
  const recs = await db().query('SELECT * FROM recommendations WHERE incident_id=$1 ORDER BY id DESC LIMIT 5', [id]);
  const out = [];
  for (const r of recs) out.push({ ...r, steps: await db().query('SELECT * FROM rec_steps WHERE rec_id=$1 ORDER BY n', [r.id]) });
  const server = await Servers.get(inc.server_id), agent = await Agents.statusOf(inc.server_id);
  return { incident: inc, recommendations: out, path: server ? execPath(server, agent) : 'none' };
}

// ---------- jalur eksekusi
export function execPath(server: Pick<Servers.ServerRow, 'exec_via' | 'ssh_key_enc' | 'key_path'>, agent: { exec_enabled: boolean; online: boolean } | null): 'ssh' | 'agent' | 'none' {
  const hasKey = !!(server.ssh_key_enc || server.key_path), agentOk = !!agent && agent.exec_enabled && agent.online;
  if (server.exec_via === 'ssh') return hasKey ? 'ssh' : 'none';
  if (server.exec_via === 'agent') return agentOk ? 'agent' : 'none';
  return hasKey ? 'ssh' : agentOk ? 'agent' : 'none';
}

// ---------- persetujuan dan eksekusi
export async function approve(recId: number, stepNs: number[] | null, by: string): Promise<void> {
  const rec = await db().one('SELECT * FROM recommendations WHERE id=$1', [recId]); if (!rec) throw new HttpError(404, 'Rekomendasi tidak ada');
  const server = await Servers.get(rec.server_id); if (!server) throw bad('Server tidak ada');
  const path = execPath(server, await Agents.statusOf(rec.server_id)); if (path === 'none') throw bad('Tidak ada jalur eksekusi: isi kunci SSH server, atau aktifkan agen dengan allow_exec=true dan pastikan agen online.');
  const steps = await db().query('SELECT * FROM rec_steps WHERE rec_id=$1 ORDER BY n', [recId]);
  const chosen = new Set((stepNs && stepNs.length ? stepNs : steps.filter((s) => s.status !== 'done' && s.class !== 'blocked').map((s) => s.n)) as number[]);
  if (![...chosen].some((n) => steps.some((s) => s.n === n && s.class !== 'blocked'))) throw bad('Pilih minimal satu langkah');
  // klaim atomik + satu eksekusi per server pada satu waktu
  const claimed = await db().one("UPDATE recommendations SET status='approved', approved_by=$1, approved_at=$2, updated=$2 WHERE id=$3 AND status IN ('proposed','failed') AND NOT EXISTS (SELECT 1 FROM recommendations x WHERE x.server_id=$4 AND x.status IN ('executing','approved')) RETURNING id", [by, Date.now(), recId, rec.server_id]);
  if (!claimed) throw bad('Rencana ini sudah disetujui/berjalan, atau ada eksekusi lain yang masih berjalan di server ini');
  for (const s of steps) {
    if (s.status === 'done') continue;
    await db().exec("UPDATE rec_steps SET status=$1, exit_code=NULL, stdout='', stderr='', started=NULL, finished=NULL WHERE id=$2", [s.class === 'blocked' ? 'blocked' : chosen.has(s.n) ? 'pending' : 'skipped', s.id]);
  }
  await audit(by, 'rekomendasi.setuju', `#${recId} langkah ${[...chosen].join(',')} via ${path}`);
  void execute(recId).catch(async (e) => { log().error({ err: (e as Error).message, rec: recId }, 'eksekusi rekomendasi gagal'); await db().exec("UPDATE recommendations SET status='failed', summary=$1, updated=$2 WHERE id=$3", ['Kesalahan internal: ' + (e as Error).message, Date.now(), recId]); });
}

export async function reject(recId: number, by: string): Promise<void> {
  const n = await db().exec("UPDATE recommendations SET status='rejected', updated=$1 WHERE id=$2 AND status IN ('proposed','failed')", [Date.now(), recId]);
  if (!n) throw bad('Rekomendasi tidak bisa ditolak pada status ini'); await audit(by, 'rekomendasi.tolak', `#${recId}`);
}

async function runOne(server: Servers.ServerRow, path: 'ssh' | 'agent', recId: number, n: number | null, command: string, timeoutS: number): Promise<{ exit: number; stdout: string; stderr: string; via: string }> {
  if (path === 'ssh') { const r = await Servers.run(server, command, { timeoutMs: timeoutS * 1000 }); return { exit: r.exitCode, stdout: r.stdout, stderr: r.stderr, via: 'ssh' }; }
  const agent = await Agents.statusOf(server.id); if (!agent?.online) return { exit: 255, stdout: '', stderr: 'agen offline', via: 'agent' };
  const id = await Agents.enqueue(server.id, recId, n, command, timeoutS), c = await Agents.waitResult(id, (timeoutS + 60) * 1000);
  return { exit: c.status === 'rejected' ? 126 : (c.exit_code ?? 1), stdout: c.stdout ?? '', stderr: c.rejected ? `ditolak agen: ${c.rejected}` : (c.stderr ?? ''), via: 'agent' };
}

async function execute(recId: number): Promise<void> {
  const rec = (await db().one('SELECT * FROM recommendations WHERE id=$1', [recId]))!, server = (await Servers.get(rec.server_id))!;
  const path = execPath(server, await Agents.statusOf(rec.server_id)); if (path === 'none') throw new Error('jalur eksekusi hilang');
  await db().exec("UPDATE recommendations SET status='executing', updated=$1 WHERE id=$2", [Date.now(), recId]);
  let failed = '', ran = 0, readFails = 0;
  for (const s of await db().query("SELECT * FROM rec_steps WHERE rec_id=$1 AND status='pending' ORDER BY n", [recId])) {
    if (classify(s.command).cls === 'blocked') { await db().exec("UPDATE rec_steps SET status='blocked' WHERE id=$1", [s.id]); failed = `Langkah ${s.n} diblokir kebijakan`; break; }
    await db().exec("UPDATE rec_steps SET status='running', started=$1, via=$2 WHERE id=$3", [Date.now(), path, s.id]);
    const r = await runOne(server, path, recId, s.n, s.command, s.class === 'read' ? 60 : rec.kind === 'patch' ? 600 : 180);   // memasang paket bisa lama; batas agen 10 menit
    await db().exec('UPDATE rec_steps SET status=$1, exit_code=$2, stdout=$3, stderr=$4, finished=$5, via=$6 WHERE id=$7', [r.exit === 0 ? 'done' : 'failed', r.exit, redactOutput(r.stdout).slice(0, 20000), redactOutput(r.stderr).slice(0, 20000), Date.now(), r.via, s.id]);
    await audit('agen', 'rekomendasi.langkah', `#${recId}.${s.n} [${s.class}] exit ${r.exit} via ${r.via}`); ran++;
    if (r.exit !== 0) {
      if (s.class === 'change') { failed = `Langkah ${s.n} (${s.title}) gagal dengan exit ${r.exit}`; break; }   // perubahan gagal: berhenti, jangan lanjut ke langkah berikutnya
      readFails++;   // langkah baca yang gagal (mis. alat tidak terpasang) hanya mengurangi data diagnosis, tidak menghentikan perbaikan
    }
  }
  let verifyOut = '';
  if (!failed && rec.verify && classify(rec.verify).cls === 'read') { const v = await runOne(server, path, recId, null, rec.verify, 60); verifyOut = (v.stdout || v.stderr).slice(0, 4000); }
  await db().exec('UPDATE recommendations SET status=$1, summary=$2, verify_out=$3, updated=$4 WHERE id=$5', [failed ? 'failed' : 'done', failed || `${ran} langkah dijalankan via ${path}${readFails ? ` (${readFails} langkah baca gagal, tidak menghentikan perbaikan)` : ''}. Tunggu agen melaporkan pulih bila kondisi sudah normal.`, verifyOut, Date.now(), recId]);
  if (rec.kind === 'patch') await db().exec("INSERT INTO meta(key,value) VALUES($1,'1') ON CONFLICT(key) DO UPDATE SET value='1'", [`patch_refresh_${rec.server_id}`]);   // agen diminta melapor ulang pada detak jantung berikutnya
  Notify.recommendationResult(server.name, rec.id, !failed, failed || `${ran} langkah selesai`);
}

export async function recover(): Promise<void> {
  await db().exec("UPDATE recommendations SET status='failed', summary='Terputus: aplikasi dimulai ulang saat eksekusi', updated=$1 WHERE status IN ('executing','approved')", [Date.now()]);
  await db().exec("UPDATE rec_steps SET status='failed', stderr='terputus' WHERE status IN ('running','pending') AND rec_id IN (SELECT id FROM recommendations WHERE status='failed' AND summary LIKE 'Terputus%')");
}
let lastPurge = 0;
export async function purge(now = Date.now()): Promise<void> { if (now - lastPurge < 6 * 3600e3) return; lastPurge = now; await db().exec('DELETE FROM agent_events WHERE received<$1', [now - 30 * 864e5]); await db().exec("DELETE FROM agent_commands WHERE created<$1", [now - 14 * 864e5]); await db().exec("DELETE FROM incidents WHERE status='resolved' AND resolved_at<$1", [now - 90 * 864e5]); }
