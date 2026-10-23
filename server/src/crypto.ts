// Enkripsi rahasia (AES-256-GCM), hash password (scrypt), token acak. Kunci dari MASTER_KEY (lingkungan/secret), bukan berkas di samping data.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opt: object) => Promise<Buffer>;
let KEY: Buffer | null = null;
export function initCrypto(masterKeyHex: string): void { KEY = Buffer.from(masterKeyHex, 'hex'); if (KEY.length !== 32) throw new Error('MASTER_KEY harus 32 byte'); }
function key(): Buffer { if (!KEY) throw new Error('crypto belum diinisialisasi'); return KEY; }

export function seal(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv), enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + enc.toString('base64');
}
export function open(sealed: string | null | undefined): string {
  if (!sealed) return '';
  const p = sealed.split(':'); if (p[0] !== 'v1' || p.length !== 4) return '';
  try { const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(p[1]!, 'base64')); d.setAuthTag(Buffer.from(p[2]!, 'base64')); return Buffer.concat([d.update(Buffer.from(p[3]!, 'base64')), d.final()]).toString('utf8'); } catch { return ''; }
}
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export function safeEqual(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

// scrypt: N=2^15, r=8, p=1 (OWASP). Format: scrypt$N$r$p$salt$hash
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16), N = 1 << 15, hash = await scrypt(pw, salt, 32, { N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 });
  return `scrypt$${N}$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const p = stored.split('$'); if (p[0] !== 'scrypt' || p.length !== 6) return false;
  const N = Number(p[1]), r = Number(p[2]), pp = Number(p[3]); if (!N || !r || !pp) return false;
  const want = Buffer.from(p[5]!, 'base64'), got = await scrypt(pw, Buffer.from(p[4]!, 'base64'), want.length, { N, r, p: pp, maxmem: 128 * N * r * 2 });
  return got.length === want.length && timingSafeEqual(got, want);
}
