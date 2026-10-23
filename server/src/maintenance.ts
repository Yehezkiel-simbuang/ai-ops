// Pemeliharaan terjadwal per server: tugas berulang/sekali, selesaikan + riwayat, tunda, templat standar, dan ringkasan harian
// ("jangan sampai lupa") yang dikirim ke kanal notifikasi. Termasuk pengingat rotasi password dan kredensial yang akan kedaluwarsa.
import { audit, bad, db, HttpError, log, metaGet, metaSet } from './context.js';
import * as Notify from './notify.js';

const DAY = 864e5;
export interface Template { id: string; title: string; category: string; every_days: number; priority: 'rendah' | 'normal' | 'tinggi'; description: string }
export const TEMPLATES: Template[] = [
  { id: 'os-update', title: 'Pembaruan keamanan OS', category: 'keamanan', every_days: 30, priority: 'tinggi', description: 'Terapkan pembaruan keamanan, lalu reboot terjadwal bila diminta (lihat "perlu reboot" di fakta server).' },
  { id: 'backup-restore', title: 'Uji pemulihan cadangan', category: 'cadangan', every_days: 90, priority: 'tinggi', description: 'Pulihkan satu cadangan ke lingkungan uji dan pastikan datanya utuh. Cadangan yang tidak pernah diuji belum bisa dianggap ada.' },
  { id: 'disk-log', title: 'Periksa ruang disk dan log', category: 'kapasitas', every_days: 14, priority: 'normal', description: 'Cek pemakaian disk, pertumbuhan log/database, dan rotasi log.' },
  { id: 'disk-health', title: 'Kesehatan disk (SMART, status RAID, scrub bila ZFS)', category: 'perangkat keras', every_days: 30, priority: 'tinggi', description: 'Periksa SMART dan status RAID atau pool penyimpanan yang dipakai; jalankan scrub bila ada.' },
  { id: 'accounts', title: 'Tinjau akun pengguna dan kunci SSH', category: 'keamanan', every_days: 90, priority: 'normal', description: 'Hapus akun/kunci yang tidak dipakai; pastikan login root/password dibatasi.' },
  { id: 'rotate-creds', title: 'Rotasi kredensial penting', category: 'keamanan', every_days: 90, priority: 'normal', description: 'Ganti password root, database, dan panel admin; perbarui di vault.' },
  { id: 'certs', title: 'Periksa masa berlaku sertifikat', category: 'keamanan', every_days: 30, priority: 'normal', description: 'Pastikan sertifikat TLS dan pembaruan otomatisnya masih berjalan.' },
  { id: 'firewall', title: 'Tinjau aturan firewall', category: 'keamanan', every_days: 180, priority: 'rendah', description: 'Tutup port yang tidak perlu; cocokkan dengan daftar layanan yang terdokumentasi.' },
  { id: 'cleanup', title: 'Bersihkan paket dan berkas lama', category: 'kapasitas', every_days: 30, priority: 'rendah', description: 'Hapus kernel/paket lama, cache, dan snapshot yang tidak terpakai.' },
  { id: 'doc-review', title: 'Perbarui dokumentasi server ini', category: 'dokumentasi', every_days: 90, priority: 'rendah', description: 'Pastikan fungsi, alamat, layanan, dan runbook di AI Ops masih sesuai kenyataan.' }
];

export interface TaskIn { title?: string; description?: string; category?: string; priority?: string; every_days?: number | null; due_at?: number | null; enabled?: boolean }
const cut = (s: unknown, n: number): string => String(s ?? '').trim().slice(0, n);
function validate(t: TaskIn, partial = false) {
  const o: Record<string, unknown> = {};
  if (t.title !== undefined || !partial) { o.title = cut(t.title, 160); if (!o.title) throw bad('Judul tugas wajib diisi'); }
  if (t.description !== undefined) o.description = cut(t.description, 2000); if (t.category !== undefined) o.category = cut(t.category, 40) || 'umum';
  if (t.priority !== undefined) { if (!['rendah', 'normal', 'tinggi'].includes(t.priority)) throw bad('Prioritas harus rendah, normal, atau tinggi'); o.priority = t.priority; }
  if (t.every_days !== undefined) { const d = t.every_days == null || (t.every_days as unknown) === '' ? null : Number(t.every_days); if (d != null && !(Number.isInteger(d) && d >= 1 && d <= 3650)) throw bad('Periode 1-3650 hari'); o.every_days = d; }
  if (t.due_at !== undefined && t.due_at !== null) { const d = Number(t.due_at); if (!Number.isFinite(d) || d <= 0) throw bad('Tanggal jatuh tempo tidak valid'); o.due_at = d; }
  if (t.enabled !== undefined) o.enabled = !!t.enabled;
  return o;
}
const status = (due: number, now: number): 'terlambat' | 'segera' | 'ok' => (due < now ? 'terlambat' : due < now + 7 * DAY ? 'segera' : 'ok');
const withStatus = (r: Record<string, any>, now = Date.now()) => ({ ...r, status: r.enabled ? status(r.due_at, now) : 'nonaktif', days_left: Math.ceil((r.due_at - now) / DAY) });

export async function list(opt: { serverId?: number | null; scope?: string } = {}) {
  const where: string[] = ['m.enabled'], args: unknown[] = [], now = Date.now();
  if (opt.serverId) { args.push(opt.serverId); where.push(`m.server_id=$${args.length}`); }
  if (opt.scope === 'overdue') { args.push(now); where.push(`m.due_at<$${args.length}`); } else if (opt.scope === 'soon') { args.push(now + 7 * DAY); where.push(`m.due_at<$${args.length}`); }
  const rows = await db().query(`SELECT m.*, s.name AS server_name FROM maintenance_tasks m LEFT JOIN servers s ON s.id=m.server_id WHERE ${where.join(' AND ')} ORDER BY m.due_at LIMIT 300`, args);
  return rows.map((r) => withStatus(r, now));
}
export async function add(serverId: number | null, t: TaskIn): Promise<Record<string, any>> {
  if (serverId && !(await db().one('SELECT 1 AS x FROM servers WHERE id=$1', [serverId]))) throw new HttpError(404, 'Server tidak ada');
  const v = validate(t), now = Date.now(), every = (v.every_days as number | null) ?? null, due = (v.due_at as number | undefined) ?? now + (every ?? 7) * DAY;
  const r = await db().one('INSERT INTO maintenance_tasks(server_id,title,description,category,priority,every_days,due_at,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [serverId, v.title, v.description ?? '', v.category ?? 'umum', v.priority ?? 'normal', every, due, now]);
  return withStatus(r!);
}
export async function addTemplates(serverId: number, ids: string[]): Promise<string[]> {
  if (!(await db().one('SELECT 1 AS x FROM servers WHERE id=$1', [serverId]))) throw new HttpError(404, 'Server tidak ada');
  const added: string[] = [], now = Date.now();
  for (const id of ids) {
    const tpl = TEMPLATES.find((x) => x.id === id); if (!tpl) throw bad(`Templat "${id}" tidak ada`);
    const n = await db().exec('INSERT INTO maintenance_tasks(server_id,title,description,category,priority,every_days,due_at,created) SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE NOT EXISTS (SELECT 1 FROM maintenance_tasks WHERE server_id=$1 AND title=$2)', [serverId, tpl.title, tpl.description, tpl.category, tpl.priority, tpl.every_days, now + Math.min(tpl.every_days, 14) * DAY, now]);
    if (n) added.push(tpl.title);
  }
  return added;
}
export async function update(id: number, t: TaskIn): Promise<Record<string, any>> {
  const v = validate(t, true); if (!Object.keys(v).length) throw bad('Tidak ada yang diubah');
  const sets: string[] = [], args: unknown[] = []; for (const [k, val] of Object.entries(v)) { args.push(val); sets.push(`${k}=$${args.length}`); }
  args.push(id); const r = await db().one(`UPDATE maintenance_tasks SET ${sets.join(', ')} WHERE id=$${args.length} RETURNING *`, args); if (!r) throw new HttpError(404, 'Tugas tidak ada'); return withStatus(r);
}
export async function remove(id: number): Promise<void> { await db().exec('DELETE FROM maintenance_tasks WHERE id=$1', [id]); }
export async function snooze(id: number, days: number): Promise<Record<string, any>> {
  const d = Math.floor(Number(days)); if (!(d >= 1 && d <= 365)) throw bad('Tunda 1-365 hari');
  const r = await db().one('UPDATE maintenance_tasks SET due_at=GREATEST(due_at, $1) + $2 WHERE id=$3 RETURNING *', [Date.now(), d * DAY, id]); if (!r) throw new HttpError(404, 'Tugas tidak ada'); return withStatus(r);
}
// selesai: dicatat di riwayat; berulang -> jatuh tempo berikutnya = sekarang + periode (tugas yang terlambat tidak menumpuk); sekali -> nonaktif
export async function complete(id: number, by: string, notes = '', doneAt = Date.now()): Promise<Record<string, any>> {
  const t = await db().one('SELECT * FROM maintenance_tasks WHERE id=$1', [id]); if (!t) throw new HttpError(404, 'Tugas tidak ada');
  if (doneAt > Date.now() + 60_000) throw bad('Tanggal selesai tidak boleh di masa depan');
  const r = await db().tx(async (x) => {
    await x.exec('INSERT INTO maintenance_log(task_id,server_id,title,done_at,done_by,notes) VALUES($1,$2,$3,$4,$5,$6)', [id, t.server_id, t.title, doneAt, by, cut(notes, 1000)]);
    return (await x.one('UPDATE maintenance_tasks SET last_done=$1, last_done_by=$2, due_at=CASE WHEN every_days IS NULL THEN due_at ELSE $1 + every_days::bigint * 86400000 END, enabled=(every_days IS NOT NULL) WHERE id=$3 RETURNING *', [doneAt, by, id]))!;
  });
  await audit(by, 'pemeliharaan.selesai', t.title); return withStatus(r);
}
export async function logFor(serverId: number) { return db().query('SELECT * FROM maintenance_log WHERE server_id=$1 ORDER BY done_at DESC LIMIT 100', [serverId]); }

// ---------- ringkasan harian
export interface DigestItem { kind: 'tugas' | 'rotasi' | 'kedaluwarsa' | 'minor'; text: string; overdue: boolean }
export async function digestItems(now = Date.now()): Promise<DigestItem[]> {
  const out: DigestItem[] = [];
  for (const t of await db().query('SELECT m.*, s.name AS server_name FROM maintenance_tasks m LEFT JOIN servers s ON s.id=m.server_id WHERE m.enabled AND m.due_at < $1 ORDER BY m.due_at', [now + 3 * DAY])) {
    const d = Math.ceil((t.due_at - now) / DAY); out.push({ kind: 'tugas', overdue: d < 0, text: `${t.server_name ?? 'Umum'}: ${t.title} (${d < 0 ? 'terlambat ' + -d + ' hari' : d === 0 ? 'jatuh tempo hari ini' : 'jatuh tempo ' + d + ' hari lagi'})` });
  }
  for (const c of await db().query('SELECT c.label, c.rotated_at, c.rotate_every_days, s.name AS server_name FROM credentials c LEFT JOIN servers s ON s.id=c.server_id WHERE c.rotate_every_days IS NOT NULL AND c.rotated_at + c.rotate_every_days::bigint * 86400000 < $1 ORDER BY c.rotated_at', [now + 3 * DAY])) {
    const due = c.rotated_at + c.rotate_every_days * DAY, d = Math.ceil((due - now) / DAY); out.push({ kind: 'rotasi', overdue: d < 0, text: `${c.server_name ?? 'Umum'}: ganti password "${c.label}" (${d < 0 ? 'terlambat ' + -d + ' hari' : 'dalam ' + d + ' hari'})` });
  }
  for (const c of await db().query('SELECT c.label, c.expires_at, s.name AS server_name FROM credentials c LEFT JOIN servers s ON s.id=c.server_id WHERE c.expires_at IS NOT NULL AND c.expires_at < $1 ORDER BY c.expires_at', [now + 14 * DAY])) {
    const d = Math.ceil((c.expires_at - now) / DAY); out.push({ kind: 'kedaluwarsa', overdue: d < 0, text: `${c.server_name ?? 'Umum'}: "${c.label}" ${d < 0 ? 'sudah kedaluwarsa ' + -d + ' hari lalu' : 'kedaluwarsa dalam ' + d + ' hari'}` });
  }
  for (const a of await db().query("SELECT a.title, a.detail, s.name AS server_name FROM alerts a JOIN servers s ON s.id=a.server_id WHERE a.level='minor' AND NOT a.resolved AND NOT a.acked ORDER BY a.ts DESC LIMIT 30")) out.push({ kind: 'minor', overdue: false, text: `${a.server_name}: ${a.title} (${a.detail}) [minor]` });
  return out;
}
const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** dipanggil berkala oleh pemimpin penjadwal; mengirim paling banyak satu ringkasan per hari lokal, setelah jam yang diatur (bawaan 08:00) */
export async function runDigest(now = Date.now()): Promise<boolean> {
  if ((await metaGet('digest_enabled')) === '0') return false;
  const hour = Number((await metaGet('digest_hour')) ?? 8), d = new Date(now), today = localDay(now);
  if (d.getHours() < hour || (await metaGet('digest_last')) === today) return false;
  await metaSet('digest_last', today);   // ditandai lebih dulu: tidak dikirim ganda walau pemeriksaan berjalan bersamaan
  const items = await digestItems(now); if (!items.length) return false;
  const late = items.filter((i) => i.overdue).length;
  try { await Notify.dispatch({ kind: 'maintenance', level: late ? 'major' : 'info', importance: late ? 4 : 3, title: `[PEMELIHARAAN] ${items.length} hal perlu perhatian${late ? ` (${late} terlambat)` : ''}`, text: items.slice(0, 15).map((i) => '- ' + i.text).join('\n') + (items.length > 15 ? `\n... dan ${items.length - 15} lainnya` : '') + '\nBuka AI Ops > Inventaris untuk menyelesaikannya.' }); } catch (e) { log().warn({ err: (e as Error).message }, 'ringkasan pemeliharaan gagal dikirim'); }
  return true;
}
