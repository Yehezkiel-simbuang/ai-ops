// Analisis docker-compose.yml sebelum dipasang di server playground. Compose dari pengguna dijalankan di server nyata,
// jadi opsi yang bisa menembus isolasi kontainer atau menyentuh host diblokir. Pagar ini bukan pengganti isolasi server
// playground (tetap khusus uji), melainkan pencegah salah ketik yang berbahaya.
import { parse } from 'yaml';

export const MAX_COMPOSE_CHARS = 60_000;   // base64-nya harus muat dalam satu argumen perintah SSH (batas 128 KiB)
const MAX_SERVICES = 20;

export interface ComposeService { name: string; image: string; ports: Array<{ host: number | null; container: number }>; volumes: string[]; hasHealthcheck: boolean }
export interface ComposeAnalysis {
  services: ComposeService[]; publish: Array<{ service: string; host: number; container: number }>;
  problems: string[];   // memblokir pemasangan
  warnings: string[];   // diberitahukan, tidak memblokir
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const BLOCKED_PORTS = new Set([22, 2375, 2376]);

/** "8080:80", "127.0.0.1:8080:80/tcp", "80", atau bentuk panjang {target, published}. */
function parsePort(p: unknown): { host: number | null; container: number } | null {
  if (typeof p === 'number') return { host: null, container: p };
  if (isObj(p)) { const c = Number(p.target), h = p.published === undefined ? null : Number(p.published); return Number.isInteger(c) ? { host: Number.isInteger(h) ? h : null, container: c } : null; }
  if (typeof p !== 'string') return null;
  const parts = p.split('/')[0]!.split(':'), nums = parts.map((x) => Number(x));
  if (parts.length === 1 && Number.isInteger(nums[0])) return { host: null, container: nums[0]! };
  const c = nums[nums.length - 1]!, h = nums[nums.length - 2]!;
  return Number.isInteger(c) && Number.isInteger(h) ? { host: h, container: c } : null;
}

function volumeProblem(v: unknown): string | null {
  const src = typeof v === 'string' ? v.split(':')[0]! : isObj(v) && v.type === 'bind' ? String(v.source ?? '') : isObj(v) ? '' : '';
  if (!src) return null;
  if (src.startsWith('/') || src.startsWith('~') || src.includes('..')) return `Volume "${src}" menunjuk ke folder di luar proyek. Pakai volume bernama atau path relatif seperti ./data.`;
  return null;
}

export function analyze(text: string): ComposeAnalysis {
  const out: ComposeAnalysis = { services: [], publish: [], problems: [], warnings: [] };
  if (!text.trim()) { out.problems.push('Isi Compose kosong'); return out; }
  if (text.length > MAX_COMPOSE_CHARS) { out.problems.push(`Compose terlalu panjang (maks. ${MAX_COMPOSE_CHARS} karakter)`); return out; }
  let doc: unknown;
  try { doc = parse(text); } catch (e) { out.problems.push(`YAML tidak valid: ${(e as Error).message.split('\n')[0]}`); return out; }
  if (!isObj(doc) || !isObj(doc.services) || !Object.keys(doc.services).length) { out.problems.push('Compose harus punya bagian "services" berisi minimal satu layanan'); return out; }
  const names = Object.keys(doc.services);
  if (names.length > MAX_SERVICES) out.problems.push(`Terlalu banyak layanan (maks. ${MAX_SERVICES})`);
  for (const name of names) {
    const s = (doc.services as Obj)[name];
    if (!isObj(s)) { out.problems.push(`Layanan "${name}" tidak valid`); continue; }
    const at = `Layanan "${name}"`;
    if (s.build !== undefined) out.problems.push(`${at}: "build" tidak didukung karena kode sumber tidak ada di server playground. Pakai "image" yang sudah jadi.`);
    else if (typeof s.image !== 'string' || !s.image) out.problems.push(`${at}: wajib punya "image"`);
    if (s.privileged === true) out.problems.push(`${at}: "privileged" tidak diizinkan`);
    for (const k of ['network_mode', 'pid', 'ipc', 'uts', 'userns_mode', 'cgroup']) if (s[k] === 'host' || (k === 'network_mode' && typeof s[k] === 'string' && String(s[k]).startsWith('container:'))) out.problems.push(`${at}: "${k}: ${String(s[k])}" tidak diizinkan`);
    if (Array.isArray(s.cap_add) && s.cap_add.length) out.problems.push(`${at}: "cap_add" tidak diizinkan`);
    if (Array.isArray(s.devices) && s.devices.length) out.problems.push(`${at}: "devices" tidak diizinkan`);
    if (s.container_name !== undefined) out.problems.push(`${at}: hapus "container_name" (bentrok dengan susunan lain; nama dikelola otomatis)`);
    if (s.env_file !== undefined) out.problems.push(`${at}: "env_file" tidak didukung; tulis nilainya di "environment"`);
    if (Array.isArray(s.security_opt) && s.security_opt.some((o) => /unconfined/i.test(String(o)))) out.problems.push(`${at}: opsi keamanan "unconfined" tidak diizinkan`);
    const vols = Array.isArray(s.volumes) ? s.volumes : [];
    for (const v of vols) { const p = volumeProblem(v); if (p) out.problems.push(`${at}: ${p}`); }
    const ports = (Array.isArray(s.ports) ? s.ports : []).map(parsePort).filter((p): p is { host: number | null; container: number } => p !== null);
    for (const p of ports) {
      if (p.host !== null) {
        if (BLOCKED_PORTS.has(p.host)) out.problems.push(`${at}: port ${p.host} di server tidak boleh dipakai`);
        else if (p.host < 1024) out.warnings.push(`${at}: port ${p.host} di server adalah port istimewa`);
        out.publish.push({ service: name, host: p.host, container: p.container });
      }
    }
    if (typeof s.image === 'string' && (!s.image.includes(':') || s.image.endsWith(':latest')) && !s.image.includes('@')) out.warnings.push(`${at}: image "${s.image}" tanpa versi tetap; hasil uji bisa berubah antar pemasangan`);
    if (!s.healthcheck) out.warnings.push(`${at}: tanpa healthcheck; status "siap" hanya berarti kontainer berjalan`);
    out.services.push({ name, image: String(s.image ?? ''), ports, volumes: vols.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))), hasHealthcheck: !!s.healthcheck });
  }
  if (!out.publish.length) out.warnings.push('Tidak ada port yang dipublikasikan ke server, jadi uji beban dari luar tidak bisa menjangkaunya. Tambahkan mis. "8080:80" pada layanan yang diuji.');
  else if (out.publish.some((p) => p.host === 0)) out.problems.push('Port host 0 tidak valid');
  return out;
}

/** Analisis plus daftar batas sumber daya per layanan (untuk ringkasan hasil uji). */
export function analyzeWithLimits(text: string): ComposeAnalysis & { limits: string[] } {
  const a = analyze(text); let limits: string[] = [];
  try { const d = parse(text) as { services?: Record<string, { deploy?: { resources?: { limits?: Record<string, string> } } }> }; limits = Object.entries(d.services ?? {}).flatMap(([n, s]) => { const l = s?.deploy?.resources?.limits; return l ? [`${n}: ${[l.cpus ? `${l.cpus} CPU` : '', l.memory ?? ''].filter(Boolean).join(', ')}`] : []; }); } catch { /* sudah dilaporkan analyze */ }
  return { ...a, limits };
}

/** Port target uji beban: yang dipilih bila ada di daftar, kalau tidak yang pertama dipublikasikan; null bila tidak ada. */
export function targetPort(a: ComposeAnalysis, wanted: number): number | null {
  if (wanted && a.publish.some((p) => p.host === wanted)) return wanted;
  return a.publish[0]?.host ?? null;
}

const MEM = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i;
const toMb = (v: string): number | undefined => { const m = MEM.exec(String(v).trim()); if (!m) return undefined; const n = Number(m[1]), u = (m[2] ?? '').toLowerCase(); return u === 'g' ? n * 1024 : u === 'k' ? n / 1024 : n; };
/** Batas CPU (jumlah core) dan memori (MB) per layanan, bila compose menetapkannya. Dipakai untuk menilai seberapa penuh sebuah komponen. */
export function serviceLimits(text: string): Record<string, { cpus?: number; memMb?: number }> {
  const out: Record<string, { cpus?: number; memMb?: number }> = {};
  try {
    const d = parse(text) as { services?: Record<string, { deploy?: { resources?: { limits?: Record<string, string> } } }> };
    for (const [n, s] of Object.entries(d.services ?? {})) {
      const l = s?.deploy?.resources?.limits; if (!l) continue;
      const cpus = Number(l.cpus), memMb = l.memory ? toMb(l.memory) : undefined;
      out[n] = { ...(Number.isFinite(cpus) && cpus > 0 ? { cpus } : {}), ...(memMb ? { memMb } : {}) };
    }
  } catch { /* sudah dilaporkan analyze */ }
  return out;
}
