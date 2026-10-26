// Enkripsi rahasia (AES-256-GCM), hash password (scrypt), token acak. Kunci dari MASTER_KEY (lingkungan/secret), bukan berkas di samping data.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opt: object) => Promise<Buffer>;
/** Cincin kunci: kunci aktif untuk menyegel, ditambah kunci lama yang masih boleh dibuka sampai semua data dienkripsi ulang (`rotate-key`). */
interface Keyed { id: string; key: Buffer }
let CURRENT: Keyed | null = null;
let RING: Keyed[] = [];
let onOpenFail: (why: string) => void = () => undefined;

const keyedOf = (hex: string): Keyed => {
  const key = Buffer.from(hex, 'hex'); if (key.length !== 32) throw new Error('MASTER_KEY harus 32 byte');
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };   // pengenal kunci (bukan rahasia): memilih kunci saat membuka
};
export function initCrypto(masterKeyHex: string, previousHex: string[] = []): void {
  CURRENT = keyedOf(masterKeyHex);
  const seen = new Set([CURRENT.id]); RING = [CURRENT];
  for (const h of previousHex) { const k = keyedOf(h); if (!seen.has(k.id)) { seen.add(k.id); RING.push(k); } }
}
/** Dipanggil saat sebuah nilai tersegel tidak bisa dibuka (kunci salah atau data rusak); mengganti diam-diam menjadi peringatan di log. */
export function setOpenFailureHandler(fn: (why: string) => void): void { onOpenFail = fn; }
function current(): Keyed { if (!CURRENT) throw new Error('crypto belum diinisialisasi'); return CURRENT; }

/** Format v2: v2:<id-kunci>:<iv>:<tag>:<data>. Format v1 lama (tanpa id kunci) tetap bisa dibuka. */
export function seal(plain: string): string {
  if (!plain) return '';
  const k = current(), iv = randomBytes(12), c = createCipheriv('aes-256-gcm', k.key, iv), enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v2:${k.id}:` + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + enc.toString('base64');
}
function decrypt(key: Buffer, iv: string, tag: string, data: string): string | null {
  try { const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'); } catch { return null; }
}
export function open(sealed: string | null | undefined): string {
  if (!sealed) return '';
  current();
  const p = sealed.split(':');
  let out: string | null = null, why = '';
  if (p[0] === 'v2' && p.length === 5) {
    const k = RING.find((x) => x.id === p[1]);
    if (!k) why = `kunci ${p[1]} tidak ada di cincin kunci (isi MASTER_KEY_PREVIOUS)`;
    else { out = decrypt(k.key, p[2]!, p[3]!, p[4]!); if (out === null) why = 'data rusak atau diubah'; }
  } else if (p[0] === 'v1' && p.length === 4) {
    for (const k of RING) { out = decrypt(k.key, p[1]!, p[2]!, p[3]!); if (out !== null) break; }
    if (out === null) why = 'tidak cocok dengan kunci mana pun di cincin kunci';
  } else why = 'format tidak dikenal';
  if (out === null) { onOpenFail(why); return ''; }
  return out;
}
/** Apakah nilai tersegel ini belum memakai kunci aktif (v1, atau v2 dengan kunci lama)? */
export function needsRotation(sealed: string | null | undefined): boolean {
  if (!sealed) return false;
  return !sealed.startsWith(`v2:${current().id}:`);
}
export const activeKeyId = (): string => current().id;

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
