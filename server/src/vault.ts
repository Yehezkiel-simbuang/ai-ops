// Vault kredensial: rahasia terenkripsi AES-256-GCM, berversi, pembangkit password/username acak (crypto.randomInt),
// dan "ungkap" yang wajib konfirmasi password akun + tercatat di audit. Rahasia tidak pernah ada di daftar atau ekspor.
import { randomInt } from 'node:crypto';
import { audit, bad, db, HttpError } from './context.js';
import { open, seal, verifyPassword } from './crypto.js';

export const KINDS = ['ssh', 'password', 'database', 'web', 'api_key', 'ssh_key', 'other'] as const;
export interface GenOpts { length?: number; upper?: boolean; lower?: boolean; digits?: boolean; symbols?: boolean; avoidAmbiguous?: boolean }
const SETS = { upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower: 'abcdefghijklmnopqrstuvwxyz', digits: '0123456789', symbols: '!@#$%^&*()-_=+[]{};:,.?' };
const AMBIG = /[Il1O0o|`'"\\/]/g;

export function generatePassword(o: GenOpts = {}): string {
  const length = Math.min(128, Math.max(8, Math.floor(o.length ?? 24)));
  const use = { upper: o.upper !== false, lower: o.lower !== false, digits: o.digits !== false, symbols: o.symbols !== false } as Record<keyof typeof SETS, boolean>;
  if (!Object.values(use).some(Boolean)) throw bad('Pilih minimal satu jenis karakter');
  const pools = (Object.keys(SETS) as Array<keyof typeof SETS>).filter((k) => use[k]).map((k) => (o.avoidAmbiguous ? SETS[k].replace(AMBIG, '') : SETS[k]));
  const all = pools.join(''), out: string[] = pools.map((p) => p[randomInt(p.length)]!);   // minimal satu dari tiap jenis yang dipilih
  while (out.length < length) out.push(all[randomInt(all.length)]!);
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }   // acak ulang (Fisher-Yates) agar posisi jenis tidak terduga
  return out.join('');
}
export function generateUsername(prefix = 'svc'): string {
  const p = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'svc', a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return `${p}-${Array.from({ length: 5 }, () => a[randomInt(a.length)]).join('')}`;
}

export interface CredIn { label?: string; kind?: string; username?: string; secret?: string; generate?: boolean | GenOpts; url?: string; port?: number | null; notes?: string; rotate_every_days?: number | null; expires_at?: number | null }
const cut = (s: unknown, n: number): string => String(s ?? '').trim().slice(0, n);
function validate(c: CredIn, partial = false) {
  const o: Record<string, unknown> = {};
  if (c.label !== undefined || !partial) { o.label = cut(c.label, 100); if (!o.label) throw bad('Label wajib diisi (mis. "root SSH", "MySQL root")'); }
  if (c.kind !== undefined || !partial) { o.kind = c.kind ?? 'password'; if (!(KINDS as readonly string[]).includes(o.kind as string)) throw bad('Jenis kredensial tidak dikenal'); }
  if (c.username !== undefined) o.username = cut(c.username, 120); if (c.url !== undefined) o.url = cut(c.url, 300); if (c.notes !== undefined) o.notes = cut(c.notes, 1000);
  if (c.port !== undefined) { const p = c.port == null || (c.port as unknown) === '' ? null : Number(c.port); if (p != null && !(Number.isInteger(p) && p >= 1 && p <= 65535)) throw bad('Port tidak valid'); o.port = p; }
  if (c.rotate_every_days !== undefined) { const d = c.rotate_every_days == null || (c.rotate_every_days as unknown) === '' ? null : Number(c.rotate_every_days); if (d != null && !(Number.isInteger(d) && d >= 1 && d <= 3650)) throw bad('Periode rotasi 1-3650 hari'); o.rotate_every_days = d; }
  if (c.expires_at !== undefined) o.expires_at = c.expires_at ? Number(c.expires_at) : null;
  return o;
}
const publicRow = (r: Record<string, any>, now = Date.now()) => {
  const { secret_enc, ...rest } = r; const due = r.rotate_every_days ? r.rotated_at + r.rotate_every_days * 864e5 : null;
  return { ...rest, has_secret: !!secret_enc, age_days: Math.floor((now - r.rotated_at) / 864e5), rotation_due_at: due, rotation_overdue: due != null && due < now, expired: r.expires_at != null && r.expires_at < now };
};

export async function list(serverId: number | null, q?: string) {
  const where: string[] = [], args: unknown[] = [];
  if (serverId) { args.push(serverId); where.push(`c.server_id=$${args.length}`); }
  if (q?.trim()) { args.push('%' + q.trim().replace(/[\\%_]/g, (m) => '\\' + m) + '%'); where.push(`(c.label ILIKE $${args.length} OR c.username ILIKE $${args.length} OR c.url ILIKE $${args.length} OR s.name ILIKE $${args.length})`); }
  const rows = await db().query(`SELECT c.*, s.name AS server_name, (SELECT COUNT(*)::int FROM credential_versions v WHERE v.credential_id=c.id) AS versions FROM credentials c LEFT JOIN servers s ON s.id=c.server_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.name NULLS FIRST, c.label LIMIT 500`, args);
  return rows.map((r) => publicRow(r));
}

async function pruneVersions(t: { exec: (s: string, a?: unknown[]) => Promise<number> }, credId: number): Promise<void> {
  await t.exec('DELETE FROM credential_versions WHERE credential_id=$1 AND id NOT IN (SELECT id FROM credential_versions WHERE credential_id=$1 ORDER BY id DESC LIMIT 10)', [credId]);
}
export async function create(serverId: number | null, c: CredIn, by: string): Promise<{ credential: ReturnType<typeof publicRow>; generated?: string }> {
  if (serverId && !(await db().one('SELECT 1 AS x FROM servers WHERE id=$1', [serverId]))) throw new HttpError(404, 'Server tidak ada');
  const v = validate(c); let secret = String(c.secret ?? ''), generated: string | undefined;
  if (!secret && c.generate) { secret = generated = generatePassword(typeof c.generate === 'object' ? c.generate : {}); }
  if (secret.length > 20000) throw bad('Rahasia terlalu panjang');
  const now = Date.now();
  const id = await db().tx(async (t) => {
    const r = (await t.one<{ id: number }>('INSERT INTO credentials(server_id,label,kind,username,secret_enc,url,port,notes,rotate_every_days,rotated_at,expires_at,created,updated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$10) RETURNING id',
      [serverId, v.label, v.kind, v.username ?? '', seal(secret), v.url ?? '', v.port ?? null, v.notes ?? '', v.rotate_every_days ?? null, now, v.expires_at ?? null]))!;
    if (secret) await t.exec('INSERT INTO credential_versions(credential_id,secret_enc,changed_at,changed_by) VALUES($1,$2,$3,$4)', [r.id, seal(secret), now, by]);
    return r.id;
  });
  await audit(by, 'vault.tambah', `${v.label}${serverId ? ' (server ' + serverId + ')' : ''}`);
  return { credential: publicRow((await db().one('SELECT * FROM credentials WHERE id=$1', [id]))!), generated };
}
export async function update(id: number, c: CredIn, by: string) {
  const old = await db().one('SELECT * FROM credentials WHERE id=$1', [id]); if (!old) throw new HttpError(404, 'Kredensial tidak ada');
  const v = validate(c, true), sets: string[] = ['updated=$1'], args: unknown[] = [Date.now()];
  for (const [k, val] of Object.entries(v)) { args.push(val); sets.push(`${k}=$${args.length}`); }
  await db().tx(async (t) => {
    if (c.secret) { if (c.secret.length > 20000) throw bad('Rahasia terlalu panjang'); args.push(seal(c.secret)); sets.push(`secret_enc=$${args.length}`); args.push(Date.now()); sets.push(`rotated_at=$${args.length}`); await t.exec('INSERT INTO credential_versions(credential_id,secret_enc,changed_at,changed_by) VALUES($1,$2,$3,$4)', [id, seal(c.secret), Date.now(), by]); await pruneVersions(t, id); }
    args.push(id); await t.exec(`UPDATE credentials SET ${sets.join(', ')} WHERE id=$${args.length}`, args);
  });
  await audit(by, c.secret ? 'vault.ganti-rahasia' : 'vault.ubah', old.label);
  return publicRow((await db().one('SELECT * FROM credentials WHERE id=$1', [id]))!);
}
export async function rotate(id: number, opts: GenOpts, by: string): Promise<{ secret: string; credential: ReturnType<typeof publicRow> }> {
  const old = await db().one('SELECT * FROM credentials WHERE id=$1', [id]); if (!old) throw new HttpError(404, 'Kredensial tidak ada');
  const secret = generatePassword(opts), now = Date.now();
  await db().tx(async (t) => { await t.exec('UPDATE credentials SET secret_enc=$1, rotated_at=$2, updated=$2 WHERE id=$3', [seal(secret), now, id]); await t.exec('INSERT INTO credential_versions(credential_id,secret_enc,changed_at,changed_by) VALUES($1,$2,$3,$4)', [id, seal(secret), now, by]); await pruneVersions(t, id); });
  await audit(by, 'vault.rotasi', old.label);
  return { secret, credential: publicRow((await db().one('SELECT * FROM credentials WHERE id=$1', [id]))!) };
}
export async function remove(id: number, by: string): Promise<void> { const old = await db().one('SELECT label FROM credentials WHERE id=$1', [id]); if (!old) return; await db().exec('DELETE FROM credentials WHERE id=$1', [id]); await audit(by, 'vault.hapus', old.label); }

// ---------- ungkap: wajib password akun (step-up), tercatat tanpa isi rahasia
async function confirm(userId: number, password: string, what: string, by: string): Promise<void> {
  const u = await db().one('SELECT password_hash FROM users WHERE id=$1', [userId]);
  if (!u || !password || !(await verifyPassword(String(password), u.password_hash))) { await audit(by, 'vault.ungkap-ditolak', what); throw new HttpError(403, 'Password salah'); }
}
export async function reveal(id: number, password: string, userId: number, by: string): Promise<{ secret: string; label: string; username: string }> {
  const c = await db().one('SELECT * FROM credentials WHERE id=$1', [id]); if (!c) throw new HttpError(404, 'Kredensial tidak ada');
  await confirm(userId, password, c.label, by);
  await db().exec('UPDATE credentials SET last_revealed=$1 WHERE id=$2', [Date.now(), id]); await audit(by, 'vault.ungkap', c.label);
  return { secret: open(c.secret_enc), label: c.label, username: c.username };
}
export async function versions(id: number) { return db().query('SELECT id, changed_at, changed_by FROM credential_versions WHERE credential_id=$1 ORDER BY id DESC', [id]); }
export async function revealVersion(versionId: number, password: string, userId: number, by: string): Promise<{ secret: string; changed_at: number }> {
  const v = await db().one('SELECT v.*, c.label FROM credential_versions v JOIN credentials c ON c.id=v.credential_id WHERE v.id=$1', [versionId]); if (!v) throw new HttpError(404, 'Versi tidak ada');
  await confirm(userId, password, `${v.label} (versi lama)`, by); await audit(by, 'vault.ungkap-versi', v.label);
  return { secret: open(v.secret_enc), changed_at: v.changed_at };
}
