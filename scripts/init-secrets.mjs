#!/usr/bin/env node
// Membuat ./secrets (database, kunci enkripsi, password admin). Tidak menimpa yang sudah ada kecuali --force.
// PENTING: master_key.txt dipakai mengenkripsi API key dan kunci SSH di database. Cadangkan di tempat aman; kalau hilang, data terenkripsi tidak bisa dibuka.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'secrets'), force = process.argv.includes('--force');
mkdirSync(dir, { recursive: true });

/** Rahasia runner uji beban: dibuat bila belum ada (juga pada instalasi lama), tanpa menyentuh rahasia lain. */
function ensureLoadgenSecret() {
  const f = join(dir, 'loadgen_secret.txt');
  if (existsSync(f)) return false;
  writeFileSync(f, randomBytes(32).toString('base64url'), { mode: 0o600 });
  try { chmodSync(f, 0o600); } catch { /* Windows */ }
  return true;
}
const dbPw = randomBytes(24).toString('base64url'), master = randomBytes(32).toString('hex');
const files = { 'db_password.txt': dbPw, 'database_url.txt': `postgres://aiops:${dbPw}@db:5432/aiops`, 'master_key.txt': master, 'admin_password.txt': '' };   // kosong = aplikasi memakai password bawaan 123456 dan memaksa penggantian saat masuk pertama
if (!force && Object.keys(files).some((f) => existsSync(join(dir, f)))) { if (ensureLoadgenSecret()) console.log('secrets/loadgen_secret.txt dibuat (rahasia runner uji beban).'); console.error('secrets/ sudah ada. Tidak ditimpa (pakai --force hanya bila yakin: master_key baru membuat data terenkripsi lama tak terbaca).'); process.exit(1); }
for (const [f, v] of Object.entries(files)) { writeFileSync(join(dir, f), v, { mode: 0o600 }); try { chmodSync(join(dir, f), 0o600); } catch { /* Windows */ } }
ensureLoadgenSecret();
console.log('secrets/ dibuat.\n\nLogin pertama:\n  pengguna : admin\n  password : 123456\n\nAplikasi akan LANGSUNG memaksa Anda mengganti password ini saat masuk pertama (minimal 12 karakter). Jangan buka aplikasi ke jaringan sebelum itu. Cadangkan secrets/master_key.txt.');
