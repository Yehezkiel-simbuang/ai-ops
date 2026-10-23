// Autentikasi: satu atau lebih pengguna admin, password di-hash scrypt, sesi di database (hanya hash token yang disimpan).
import { audit, bad, db, log } from './context.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import type { Config } from './config.js';

export interface SessionUser { id: number; username: string; mustChange: boolean }
/** Password awal bila ADMIN_PASSWORD tidak disetel. Selalu disertai kewajiban ganti: tidak ada fitur lain yang bisa dipakai sebelum diganti. */
export const DEFAULT_PASSWORD = '123456';
const DUMMY = hashPassword('dummy-password-for-timing').catch(() => '');   // dibandingkan saat pengguna tidak ada: cegah enumerasi lewat waktu respons

export async function ensureAdmin(cfg: Config): Promise<void> {
  const n = (await db().one<{ c: number }>('SELECT COUNT(*)::int AS c FROM users'))!.c; if (n > 0) return;
  const pw = cfg.ADMIN_PASSWORD ?? DEFAULT_PASSWORD, mustChange = !cfg.ADMIN_PASSWORD;   // password pilihan operator tidak dipaksa ganti; password bawaan selalu dipaksa
  await db().exec('INSERT INTO users(username,password_hash,created_at,must_change) VALUES($1,$2,$3,$4)', [cfg.ADMIN_USERNAME, await hashPassword(pw), Date.now(), mustChange]);
  await audit('sistem', 'admin.dibuat', `${cfg.ADMIN_USERNAME}${mustChange ? ' (password bawaan, wajib ganti)' : ''}`);
  if (mustChange) log().warn({ username: cfg.ADMIN_USERNAME }, `Admin pertama dibuat dengan password bawaan ${DEFAULT_PASSWORD}. Aplikasi memaksa penggantian saat masuk pertama; jangan biarkan aplikasi terbuka ke jaringan sebelum itu.`);
  else log().info({ username: cfg.ADMIN_USERNAME }, 'Admin pertama dibuat dari ADMIN_PASSWORD');
}

export async function login(cfg: Config, username: string, password: string, ip: string, ua: string): Promise<{ token: string; user: SessionUser } | null> {
  const u = await db().one('SELECT * FROM users WHERE username=$1', [String(username).slice(0, 100)]);
  const ok = u ? await verifyPassword(String(password), u.password_hash) : (await verifyPassword(String(password), (await DUMMY) || 'x'), false);
  if (!u || !ok) { await audit('sistem', 'login.gagal', `${String(username).slice(0, 50)} dari ${ip}`); return null; }
  const token = randomToken(32), now = Date.now();
  await db().exec('INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen,ip,ua) VALUES($1,$2,$3,$4,$5,$6,$7)', [sha256(token), u.id, now, now + cfg.SESSION_TTL_HOURS * 3600e3, now, ip.slice(0, 64), ua.slice(0, 200)]);
  await db().exec('UPDATE users SET last_login=$1 WHERE id=$2', [now, u.id]); await audit(u.username, 'login', ip);
  return { token, user: { id: u.id, username: u.username, mustChange: !!u.must_change } };
}

export async function authenticate(cfg: Config, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const now = Date.now(), r = await db().one('SELECT s.id AS sid, s.last_seen, u.id, u.username, u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>$2', [sha256(token), now]);
  if (!r) return null;
  if (now - r.last_seen > 5 * 60_000) await db().exec('UPDATE sessions SET last_seen=$1, expires_at=$2 WHERE id=$3', [now, now + cfg.SESSION_TTL_HOURS * 3600e3, r.sid]);   // sesi bergeser, tulis maksimal tiap 5 menit
  return { id: r.id, username: r.username, mustChange: !!r.must_change };
}
/** Pemulihan (dari CLI di server): kembalikan ke password bawaan dan wajibkan ganti. Semua sesi dicabut. */
export async function resetPassword(username: string): Promise<boolean> {
  const u = await db().one('SELECT id FROM users WHERE username=$1', [username]); if (!u) return false;
  await db().exec('UPDATE users SET password_hash=$1, must_change=true WHERE id=$2', [await hashPassword(DEFAULT_PASSWORD), u.id]);
  await db().exec('DELETE FROM sessions WHERE user_id=$1', [u.id]); await audit('sistem', 'password.dipulihkan', username);
  return true;
}
export async function logout(token: string | undefined): Promise<void> { if (token) await db().exec('DELETE FROM sessions WHERE id=$1', [sha256(token)]); }
export async function changePassword(userId: number, current: string, next: string): Promise<void> {
  if (next.length < 12) throw bad('Password baru minimal 12 karakter');
  if (next === current) throw bad('Password baru harus berbeda dari yang lama');
  if (next === DEFAULT_PASSWORD) throw bad('Password baru tidak boleh sama dengan password bawaan');
  const u = await db().one('SELECT * FROM users WHERE id=$1', [userId]); if (!u || !(await verifyPassword(current, u.password_hash))) throw bad('Password saat ini salah');
  if (next.toLowerCase() === String(u.username).toLowerCase()) throw bad('Password tidak boleh sama dengan nama pengguna');
  await db().exec('UPDATE users SET password_hash=$1, must_change=false WHERE id=$2', [await hashPassword(next), userId]);
  await db().exec('DELETE FROM sessions WHERE user_id=$1', [userId]);   // semua sesi lama dicabut
  await audit(u.username, 'password.ganti', '');
}
