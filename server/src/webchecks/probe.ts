// Satu kali pemeriksaan HTTP dari server ini ke sebuah URL. Aplikasi ini memegang kredensial, jadi permintaan keluar dijaga:
// alamat link-local/metadata cloud (169.254.0.0/16, fe80::/10) dan alamat tak bermakna ditolak SAAT menyambung (bukan hanya saat
// menyimpan), sehingga DNS rebinding tidak lolos. Badan respons tidak pernah dibaca; hanya status, waktu, dan sertifikat.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { bad } from '../context.js';

export interface ProbeResult { ok: boolean; code: number | null; ms: number; error: string; certExpires: number | null }

/** Alamat yang tidak boleh dituju: link-local (termasuk metadata cloud 169.254.169.254) dan alamat tak bermakna. */
export function blockedAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(v) === 4) { const [a = 0, b = 0] = v.split('.').map(Number); return a === 0 || (a === 169 && b === 254); }
  if (isIP(v) === 6) {
    if (v === '::' || /^fe[89ab]/.test(v)) return true;
    const mapped = /^::ffff:(.+)$/.exec(v);
    if (mapped) {
      const rest = mapped[1]!, hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      if (hex) { const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16); return blockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
      return blockedAddress(rest);
    }
  }
  return false;
}

/** Memeriksa dan merapikan URL yang akan dipantau. Melempar 400 bila tidak boleh. */
export function parseTarget(raw: string): string {
  let u: URL; try { u = new URL(raw.trim()); } catch { throw bad('URL tidak valid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('URL harus http:// atau https://');
  if (u.username || u.password) throw bad('URL tidak boleh memuat nama pengguna atau kata sandi');
  if (!u.hostname) throw bad('URL tidak punya host');
  if (blockedAddress(u.hostname)) throw bad('Alamat tujuan diblokir (link-local atau alamat metadata)');
  return u.href;
}

function guardedLookup(host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void): void {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, '', 0);
    const list = addrs as dns.LookupAddress[];
    if (list.some((a) => blockedAddress(a.address))) return cb(new Error('Alamat tujuan diblokir (link-local atau alamat metadata)'), '', 0);
    if (opts.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export async function probe(url: string, timeoutMs: number, maxRedirects = 3): Promise<ProbeResult> {
  const started = Date.now(), deadline = started + timeoutMs;
  let current = url, certExpires: number | null = null;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let target: string; try { target = parseTarget(current); } catch (e) { return { ok: false, code: null, ms: Date.now() - started, error: (e as Error).message, certExpires }; }
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, code: null, ms: Date.now() - started, error: `Waktu habis (${timeoutMs} ms)`, certExpires };
    const step = await new Promise<{ code?: number; location?: string; error?: string; cert?: number | null }>((resolve) => {
      const u = new URL(target), mod = u.protocol === 'https:' ? https : http;
      let done = false; const finish = (v: Parameters<typeof resolve>[0]): void => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const req = mod.request(u, { method: 'GET', agent: false, lookup: guardedLookup as never, headers: { 'user-agent': 'AIOps-Uptime/1.0', accept: '*/*' } }, (res) => {
        let cert: number | null = null;
        if (u.protocol === 'https:') { const c = (res.socket as TLSSocket).getPeerCertificate?.(); const t = c?.valid_to ? Date.parse(c.valid_to) : NaN; cert = Number.isFinite(t) ? t : null; }
        const out = { code: res.statusCode ?? 0, location: String(res.headers.location ?? ''), cert };
        res.destroy();   // badan tidak dibaca
        finish(out);
      });
      const timer = setTimeout(() => { req.destroy(); finish({ error: `Waktu habis (${timeoutMs} ms)` }); }, left);
      req.on('error', (e) => finish({ error: (e as NodeJS.ErrnoException).code && (e as NodeJS.ErrnoException).code !== 'ERR_TLS_CERT_ALTNAME_INVALID' ? `${(e as NodeJS.ErrnoException).code}: ${e.message}`.slice(0, 200) : e.message.slice(0, 200) }));
      req.end();
    });
    if (step.cert) certExpires = step.cert;
    if (step.error) return { ok: false, code: null, ms: Date.now() - started, error: step.error, certExpires };
    if (REDIRECTS.has(step.code!) && step.location) {
      if (hop >= maxRedirects) return { ok: false, code: null, ms: Date.now() - started, error: 'Terlalu banyak pengalihan', certExpires };
      try { current = new URL(step.location, target).href; continue; } catch { /* lokasi rusak: anggap respons akhir */ }
    }
    return { ok: true, code: step.code!, ms: Date.now() - started, error: '', certExpires };
  }
  return { ok: false, code: null, ms: Date.now() - started, error: 'Terlalu banyak pengalihan', certExpires };   // tak tercapai; menjaga tipe
}
