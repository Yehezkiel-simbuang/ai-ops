// Keamanan target uji beban. Uji beban ke tempat yang salah (produksi, layanan orang lain) adalah serangan DoS, jadi target dibatasi:
// hanya alamat privat/lokal, nama host tanpa titik (nama layanan Docker), atau host yang Anda daftarkan sendiri di LOADTEST_ALLOWED_HOSTS.
// Runner memeriksa ulang setelah me-resolve DNS, jadi nama yang menunjuk ke IP publik tetap ditolak.
import { isIP } from 'node:net';
import { bad } from '../context.js';

function privateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(v6) === 6) {
    if (v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
    const mapped = /^::ffff:(.+)$/.exec(v6);   // IPv4 yang dipetakan: URL menormalkannya ke dua grup heksa (::ffff:a01:203)
    if (mapped) {
      const rest = mapped[1]!, hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      if (hex) { const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16); return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
      return privateV4(rest);
    }
  }
  return false;
}

export interface TargetCheck { origin: string; host: string; allowPublic: boolean }

/** Memeriksa dan menormalkan target (hanya origin). Melempar 400 bila tidak boleh. `allowed` = daftar LOADTEST_ALLOWED_HOSTS. */
export function checkTarget(raw: string, allowed: string[], allowPath = false): TargetCheck {
  let u: URL;
  try { u = new URL(raw); } catch { throw bad('Alamat target tidak valid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('Target harus http:// atau https://');
  if (u.username || u.password) throw bad('Target tidak boleh memuat nama pengguna atau password');
  if (!allowPath) {   // target uji: origin saja (path request diatur di skenario). Alamat metrik boleh punya path.
    if (u.pathname !== '/' && u.pathname !== '') throw bad('Isi alamat dasar saja (mis. http://10.0.0.5:8080); path request diatur di skenario');
    if (u.search || u.hash) throw bad('Target tidak boleh memuat query atau fragmen');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const listed = allowed.some((a) => host === a || (a.startsWith('.') && host.endsWith(a)));
  const local = host === 'localhost' || !host.includes('.') && isIP(host) === 0 || isPrivateIp(host);
  if (!local && !listed) {
    throw bad(`Target ${host} bukan alamat privat. Uji beban hanya boleh ke jaringan lokal atau host yang Anda daftarkan di LOADTEST_ALLOWED_HOSTS (mis. staging.contoh.com). Jangan menguji produksi atau layanan milik orang lain.`);
  }
  return { origin: u.origin, host, allowPublic: !local && listed };
}
