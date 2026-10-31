// Cek CVE: apakah server Anda terdampak, apakah patch sudah ada, dan apa yang bisa dilakukan sekarang. Sumber publik: tracker keamanan Ubuntu (status per rilis dan paket,
// termasuk teks mitigasi resmi bila diterbitkan), OSV.dev (ringkasan dan vektor CVSS), dan daftar CISA KEV yang sudah dipakai fitur patch.
// Prinsip: yang berasal dari sumber resmi diberi label "resmi", yang saran umum diberi label "umum"; sumber yang gagal dihubungi = "tidak diketahui", bukan "aman".
import { audit, bad, db, HttpError, log } from './context.js';
import { RANK } from './levels.js';
import * as Notify from './notify.js';
import * as Servers from './servers.js';

const UBUNTU = 'https://ubuntu.com/security/cves/', OSV = 'https://api.osv.dev/v1/vulns/', TIMEOUT_MS = 20_000, MAX_WATCH = 30, DPKG_CONCURRENCY = 3;
export const CVE_RE = /^CVE-\d{4}-\d{4,7}$/;
export const normalizeId = (raw: string): string => { const id = String(raw ?? '').trim().toUpperCase(); if (!CVE_RE.test(id)) throw bad('Format CVE tidak valid. Contoh: CVE-2026-98432'); return id; };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let doFetch: Fetcher = (url, init) => fetch(url, init);
/** Untuk uji: ganti pengambil data agar tidak menyentuh internet. */
export function setFetch(f: Fetcher | null): void { doFetch = f ?? ((url, init) => fetch(url, init)); }

type Got = { status: 'ok'; json: any } | { status: 'tidak-ada' } | { status: 'gagal'; error: string };
async function getJson(url: string): Promise<Got> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await doFetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
    if (r.status === 404) return { status: 'tidak-ada' };
    if (!r.ok) return { status: 'gagal', error: `HTTP ${r.status}` };
    return { status: 'ok', json: await r.json() };
  } catch (e) { return { status: 'gagal', error: (e as Error).name === 'AbortError' ? 'waktu habis' : (e as Error).message }; }
  finally { clearTimeout(t); }
}

// ---------- rilis Ubuntu
const CODENAME: Record<string, string> = { '14.04': 'trusty', '16.04': 'xenial', '18.04': 'bionic', '20.04': 'focal', '22.04': 'jammy', '23.04': 'lunar', '23.10': 'mantic', '24.04': 'noble', '24.10': 'oracular', '25.04': 'plucky', '25.10': 'questing', '26.04': 'resolute', '26.10': 'stonking' };
const VERSION_OF = Object.fromEntries(Object.entries(CODENAME).map(([v, c]) => [c, v]));
export const releaseLabel = (codename: string): string => (VERSION_OF[codename] ? `Ubuntu ${VERSION_OF[codename]}` : codename);

export interface ServerOs { id: number; name: string; host: string; hasAgent: boolean; osId: string | null; osVersion: string | null; kernel: string | null }
/** Fakta OS dari laporan agen (os_id, os_version, kernel) bila ada; jika tidak, dari baris os_info hasil Uji koneksi ("Linux 6.8.0-147-generic x86_64 | Ubuntu 24.04.4 LTS | ..."). */
const OS_NAMES: Array<[RegExp, string]> = [[/Ubuntu/i, 'ubuntu'], [/Debian/i, 'debian'], [/CentOS/i, 'centos'], [/Rocky/i, 'rocky'], [/AlmaLinux/i, 'almalinux'], [/Red Hat|RHEL/i, 'rhel'], [/Fedora/i, 'fedora'], [/Alpine/i, 'alpine'], [/SUSE/i, 'suse']];
export function osOf(row: { id: number; name: string; host: string; os_info?: string | null; agent_patch?: any }): ServerOs {
  const p = row.agent_patch && typeof row.agent_patch === 'object' ? row.agent_patch : null, info = String(row.os_info ?? '');
  let osId: string | null = typeof p?.os_id === 'string' ? p.os_id.toLowerCase() : null, osVersion: string | null = typeof p?.os_version === 'string' ? p.os_version : null;
  let kernel: string | null = typeof p?.kernel === 'string' && p.kernel ? p.kernel : null;
  if (!osId) {   // baris os_info = "Linux <kernel> <arsitektur> | <PRETTY_NAME> | ...": nama distro dikenali agar pesannya "belum dinilai", bukan "tidak diketahui"
    const name = info.split('|')[1] ?? '', hit = OS_NAMES.find(([re]) => re.test(name));
    if (hit) { osId = hit[1]; const v = hit[1] === 'ubuntu' ? /(\d{2}\.\d{2})/.exec(name) : /(\d+(?:\.\d+)?)/.exec(name); osVersion = v ? v[1]! : null; }
  }
  if (!kernel) { const m = /^Linux\s+(\S+)/.exec(info); if (m) kernel = m[1]!; }
  if (osId === 'ubuntu' && osVersion) { const m = /^(\d{2}\.\d{2})/.exec(osVersion); osVersion = m ? m[1]! : osVersion; }
  return { id: row.id, name: row.name, host: row.host, hasAgent: !!p, osId, osVersion, kernel };
}
export const codenameOf = (os: ServerOs): string | null => (os.osId === 'ubuntu' && os.osVersion ? CODENAME[os.osVersion] ?? null : null);

/** Alamat publik (IPv4 di luar rentang privat, loopback, link-local, dan CGNAT). Nama host atau IPv6: tidak diketahui. */
export function isPublicHost(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim()); if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return null;
  return !(a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
}

// ---------- data Ubuntu dan OSV
export interface PkgStatus { status: string; fixed: string }
export interface CvePkg { name: string; statuses: Record<string, PkgStatus> }
export interface UbuntuCve { id: string; description: string; published: string | null; updated: string | null; priority: string; cvss: number | null; mitigation: string; notes: string[]; notices: string[]; references: string[]; packages: CvePkg[] }

export function parseUbuntu(j: any): UbuntuCve | null {
  if (!j || typeof j !== 'object' || typeof j.id !== 'string') return null;
  const str = (v: unknown, max = 4000): string => String(v ?? '').trim().slice(0, max);
  const packages: CvePkg[] = (Array.isArray(j.packages) ? j.packages : []).filter((p: any) => p && typeof p.name === 'string').map((p: any) => ({
    name: String(p.name).slice(0, 120),
    statuses: Object.fromEntries((Array.isArray(p.statuses) ? p.statuses : []).filter((s: any) => s && typeof s.release_codename === 'string').map((s: any) => [s.release_codename, { status: str(s.status, 40), fixed: str(s.description, 120) }]))
  }));
  return {
    id: j.id, description: str(j.description, 3000), published: typeof j.published === 'string' ? j.published : null, updated: typeof j.updated_at === 'string' ? j.updated_at : null,
    priority: str(j.priority, 20), cvss: typeof j.cvss3 === 'number' ? j.cvss3 : null, mitigation: str(j.mitigation, 3000),
    notes: (Array.isArray(j.notes) ? j.notes : []).map((n: any) => str(n?.note, 600)).filter(Boolean).slice(0, 5),
    notices: (Array.isArray(j.notices_ids) ? j.notices_ids : []).filter((x: unknown) => typeof x === 'string').slice(0, 10) as string[],
    references: (Array.isArray(j.references) ? j.references : []).map((r: any) => (typeof r === 'string' ? r : str(r?.url, 300))).filter((u: string) => /^https?:\/\//.test(u)).slice(0, 8), packages
  };
}

export interface OsvInfo { summary: string; details: string; published: string | null; modified: string | null; vector: string | null; ecosystems: string[] }
export function parseOsv(j: any): OsvInfo | null {
  if (!j || typeof j !== 'object' || typeof j.id !== 'string') return null;
  const sev = (Array.isArray(j.severity) ? j.severity : []).find((s: any) => typeof s?.score === 'string' && /^CVSS:/.test(s.score));
  return {
    summary: String(j.summary ?? '').trim().slice(0, 300), details: String(j.details ?? '').trim().slice(0, 3000), published: typeof j.published === 'string' ? j.published : null, modified: typeof j.modified === 'string' ? j.modified : null,
    vector: sev ? String(sev.score).slice(0, 120) : null, ecosystems: [...new Set((Array.isArray(j.affected) ? j.affected : []).map((a: any) => String(a?.package?.ecosystem ?? '')).filter(Boolean))].slice(0, 12) as string[]
  };
}
export const isNetworkVector = (v: string | null): boolean => !!v && /\/AV:N\//.test(v);

// ---------- pembanding versi dpkg dan kernel
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const ord = (c: string | undefined): number => (c === undefined || isDigit(c) ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c === '~' ? -1 : c.charCodeAt(0) + 256);
function verrev(a: string, b: string): number {   // algoritma dpkg: bagian bukan angka dibandingkan per huruf (~ paling kecil), bagian angka secara numerik
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) { const d = ord(a[i]) - ord(b[j]); if (d) return d; i++; j++; }
    while (a[i] === '0') i++; while (b[j] === '0') j++;
    let diff = 0;
    while (isDigit(a[i]) && isDigit(b[j])) { if (!diff) diff = a.charCodeAt(i) - b.charCodeAt(j); i++; j++; }
    if (isDigit(a[i])) return 1; if (isDigit(b[j])) return -1; if (diff) return diff;
  }
  return 0;
}
/** Bandingkan dua versi paket Debian/Ubuntu: negatif bila a < b, 0 bila sama, positif bila a > b. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const e = /^(\d+):(.*)$/.exec(v), rest = e ? e[2]! : v, k = rest.lastIndexOf('-'); return { epoch: e ? Number(e[1]) : 0, up: k >= 0 ? rest.slice(0, k) : rest, rev: k >= 0 ? rest.slice(k + 1) : '' }; };
  const x = split(a), y = split(b);
  return x.epoch !== y.epoch ? x.epoch - y.epoch : verrev(x.up, y.up) || verrev(x.rev, y.rev);
}

/** Paket sumber kernel menurut jenisnya: 6.8.0-147-generic -> linux, 6.8.0-1048-aws -> linux-aws. */
export function kernelSource(release: string | null): string {
  const flavor = /^\d+\.\d+\.\d+-\d+-(.+)$/.exec(release ?? '')?.[1] ?? 'generic';
  return ({ generic: 'linux', lowlatency: 'linux', virtual: 'linux' } as Record<string, string>)[flavor] ?? `linux-${flavor}`;
}
const abiOf = (v: string): { up: string; abi: number } | null => { const m = /^(\d+\.\d+\.\d+)-(\d+)/.exec(v); return m ? { up: m[1]!, abi: Number(m[2]) } : null; };
/** Kernel yang sedang berjalan lebih lama dari versi perbaikan? Dibandingkan menurut nomor ABI (6.8.0-147 vs 6.8.0-149.149); null bila bentuknya tidak dikenal. */
export function kernelBefore(running: string, fixed: string): boolean | null {
  const r = abiOf(running), f = abiOf(fixed); if (!r || !f) return null;
  const c = verrev(r.up, f.up); return c !== 0 ? c < 0 : r.abi < f.abi;
}

/** Keluaran `dpkg-query -W -f='${source:Package} ${source:Version}\n'`: paket sumber terpasang dengan versi tertinggi. */
export function parseDpkg(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, ver] = line.trim().split(/\s+/); if (!name || !ver || !/^[a-z0-9][a-z0-9+.-]*$/.test(name)) continue;
    const old = m.get(name); if (!old || compareVersions(ver, old) > 0) m.set(name, ver);
  }
  return m;
}
export const DPKG_CMD = "dpkg-query -W -f='${source:Package} ${source:Version}\\n' 2>/dev/null | sort -u";

// ---------- penilaian per server
export type Verdict = 'rentan_tanpa_patch' | 'rentan_patch_tersedia' | 'tidak_diketahui' | 'aman' | 'tidak_terdampak';
const VERDICT_RANK: Record<Verdict, number> = { rentan_tanpa_patch: 5, rentan_patch_tersedia: 4, tidak_diketahui: 3, aman: 2, tidak_terdampak: 1 };
export interface PkgVerdict { name: string; status: string; fixed: string; installed: string | null; verdict: Verdict; text: string }
export interface ServerVerdict { server_id: number; name: string; host: string; hasAgent: boolean; publicHost: boolean | null; os: string | null; release: string | null; kernel: string | null; verdict: Verdict; packages: PkgVerdict[]; note: string | null; kernelPkg: boolean }

const NO_PATCH = new Set(['pending', 'needed', 'needs-triage', 'deferred', 'in-progress', 'active']);

/** Satu paket pada satu rilis: apa kata Ubuntu, dan (bila versi terpasang diketahui) apakah server sudah di atas versi perbaikan. */
export function judgePackage(name: string, st: PkgStatus, installed: string | null, running: string | null, isKernel: boolean): PkgVerdict {
  const base = { name, status: st.status, fixed: st.fixed, installed };
  if (st.status === 'not-affected' || st.status === 'DNE') return { ...base, verdict: 'tidak_terdampak', text: 'Ubuntu: tidak terdampak' };
  if (st.status === 'ignored') return { ...base, verdict: 'rentan_tanpa_patch', text: 'Ubuntu menandai tidak akan diperbaiki' };
  if (st.status === 'released') {
    const behind = isKernel && running ? kernelBefore(running, st.fixed) : installed ? compareVersions(installed, st.fixed) < 0 : null;
    const have = isKernel ? running : installed;
    if (behind === true) return { ...base, installed: have, verdict: 'rentan_patch_tersedia', text: `Perbaikan tersedia di ${st.fixed}; terpasang ${have}` };
    if (behind === false) return { ...base, installed: have, verdict: 'aman', text: `Sudah ${have} (perbaikan di ${st.fixed})` };
    return { ...base, verdict: 'tidak_diketahui', text: `Perbaikan tersedia di ${st.fixed}; versi terpasang tidak diketahui` };
  }
  if (NO_PATCH.has(st.status)) return { ...base, verdict: 'rentan_tanpa_patch', text: st.status === 'pending' && st.fixed ? `Belum dirilis; perbaikan disiapkan di ${st.fixed}` : 'Belum ada perbaikan dari Ubuntu' };
  return { ...base, verdict: 'tidak_diketahui', text: `Status Ubuntu tidak dikenal: ${st.status || 'kosong'}` };
}

/** Penilaian satu server. installed = paket sumber terpasang (null bila tidak bisa dibaca). */
export function assessServer(info: UbuntuCve | null, os: ServerOs, installed: Map<string, string> | null, readError: string | null = null): ServerVerdict {
  const codename = codenameOf(os), osText = os.osId ? `${os.osId === 'ubuntu' ? 'Ubuntu' : os.osId} ${os.osVersion ?? ''}`.trim() : null, ksrc = kernelSource(os.kernel);
  const out: ServerVerdict = { server_id: os.id, name: os.name, host: os.host, hasAgent: os.hasAgent, publicHost: isPublicHost(os.host), os: osText, release: codename, kernel: os.kernel, verdict: 'tidak_diketahui', packages: [], note: null, kernelPkg: false };
  if (!info) { out.note = 'Data tracker Ubuntu tidak tersedia, jadi server ini tidak bisa dinilai.'; return out; }
  if (!os.osId) { out.note = 'OS server belum diketahui. Jalankan Uji koneksi atau pasang agen.'; return out; }
  if (!codename) { out.note = os.osId === 'ubuntu' ? `Rilis Ubuntu ${os.osVersion} belum dikenal.` : `OS ${osText} belum dinilai (baru Ubuntu).`; return out; }
  const pkgs: PkgVerdict[] = [];
  for (const p of info.packages) {
    const st = p.statuses[codename]; if (!st || st.status === 'DNE') continue;
    const isKernel = p.name === ksrc;
    if (!isKernel && !installed?.has(p.name)) continue;   // hanya paket yang benar-benar terpasang (kernel: yang sedang berjalan)
    pkgs.push(judgePackage(p.name, st, isKernel ? null : installed?.get(p.name) ?? null, os.kernel, isKernel));
  }
  out.packages = pkgs.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || a.name.localeCompare(b.name));
  out.kernelPkg = pkgs.some((p) => p.name === ksrc);
  if (!installed) out.note = `Daftar paket terpasang tidak bisa dibaca${readError ? ` (${readError})` : ''}; hanya kernel yang dinilai.`;
  out.verdict = pkgs.length ? pkgs.reduce<Verdict>((w, p) => (VERDICT_RANK[p.verdict] > VERDICT_RANK[w] ? p.verdict : w), 'tidak_terdampak') : installed ? 'tidak_terdampak' : 'tidak_diketahui';
  if (!pkgs.length && installed) out.note = 'Tidak ada paket terpasang yang tercantum pada CVE ini untuk rilis server ini.';
  return out;
}

// ---------- saran
export interface Advice { kind: 'resmi' | 'umum'; title: string; text: string; link?: string }
/** Saran dari keadaan server. "resmi" hanya teks mitigasi dari Ubuntu; selebihnya "umum": langkah wajar untuk jenis masalah ini, bukan penawar khusus CVE-nya. */
export function adviceFor(info: UbuntuCve | null, vector: string | null, servers: ServerVerdict[]): Advice[] {
  const out: Advice[] = [];
  if (info?.mitigation) out.push({ kind: 'resmi', title: 'Mitigasi dari Ubuntu', text: info.mitigation });
  const noPatch = servers.filter((s) => s.verdict === 'rentan_tanpa_patch'), withPatch = servers.filter((s) => s.verdict === 'rentan_patch_tersedia');
  if (!info?.mitigation && (noPatch.length || withPatch.length)) out.push({ kind: 'resmi', title: 'Mitigasi dari Ubuntu', text: 'Ubuntu tidak menerbitkan mitigasi atau workaround untuk CVE ini. Satu-satunya perbaikan resmi adalah paket yang diperbarui.' });
  for (const s of withPatch) out.push({ kind: 'umum', title: `Pasang patch di ${s.name}`, text: s.kernelPkg ? 'Perbarui paket kernel lalu reboot; kernel baru baru aktif setelah reboot.' : 'Perbarui paket yang tercantum lalu restart layanan yang memakainya.', link: `/patch/${s.server_id}` });
  if (noPatch.length) {
    out.push({ kind: 'umum', title: 'Pantau rilis patch', text: `Belum ada perbaikan untuk ${noPatch.map((s) => s.name).join(', ')}. Aktifkan Pantau: aplikasi mengecek tracker Ubuntu berkala dan memberi tahu begitu perbaikan dirilis, lalu meminta agen melapor ulang pembaruan.` });
    if (noPatch.some((s) => s.kernelPkg)) out.push({ kind: 'umum', title: 'Siapkan jendela reboot', text: 'Perbaikan kernel butuh reboot. Tentukan waktu pemeliharaan sekarang supaya pemasangan tidak tertunda saat patch keluar.' }, { kind: 'umum', title: 'Cek Livepatch Ubuntu', text: 'Jalankan "pro status" atau "canonical-livepatch status" di server. Ini hanya cara memeriksa; belum tentu ada livepatch untuk CVE ini.' });
    const exposed = noPatch.filter((s) => s.publicHost === true);
    if (exposed.length) out.push({ kind: 'umum', title: `Kurangi paparan jaringan: ${exposed.map((s) => s.name).join(', ')}`, text: `${isNetworkVector(vector) ? 'CVE ini bisa dieksploitasi lewat jaringan.' : 'Server ini berIP publik.'} Batasi akses masuk ke port yang perlu saja dan, bila bisa, hanya dari alamat tepercaya atau lewat VPN. Ini mengurangi risiko, tidak menutup kerentanannya.` });
    else if (isNetworkVector(vector)) out.push({ kind: 'umum', title: 'Kurangi paparan jaringan', text: 'CVE ini bisa dieksploitasi lewat jaringan. Pastikan hanya port yang perlu yang bisa dijangkau dan hanya dari sumber tepercaya. Ini mengurangi risiko, tidak menutup kerentanannya.' });
  }
  if (servers.some((s) => s.verdict === 'tidak_diketahui')) out.push({ kind: 'umum', title: 'Lengkapi data server', text: 'Ada server yang belum bisa dinilai (OS belum diketahui atau daftar paket tidak terbaca). Jalankan Uji koneksi atau pasang agen, lalu cek lagi.' });
  return out;
}

// ---------- ambil data server dan paket terpasang
interface ServerRowX extends Servers.ServerRow { agent_patch: any }
async function loadServers(): Promise<ServerRowX[]> { return db().query<ServerRowX>('SELECT s.*, a.patch AS agent_patch FROM servers s LEFT JOIN agents a ON a.server_id=s.id ORDER BY s.name'); }

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!); } }));
  return out;
}

async function readInstalled(s: ServerRowX): Promise<{ map: Map<string, string> | null; error: string | null }> {
  try {
    const r = await Servers.run(s, DPKG_CMD, { timeoutMs: 20_000 });
    if (r.exitCode !== 0 || !r.stdout.trim()) return { map: null, error: r.timedOut ? 'waktu habis' : (r.stderr || 'server tidak terjangkau').trim().split('\n').slice(-1)[0]!.slice(0, 120) };
    return { map: parseDpkg(r.stdout), error: null };
  } catch (e) { return { map: null, error: (e as Error).message.slice(0, 120) }; }
}

// ---------- pencarian
export interface Lookup {
  id: string; found: boolean; sources: { ubuntu: string; osv: string }; summary: string; description: string; published: string | null; updated: string | null; priority: string; cvss: number | null; vector: string | null;
  kev: boolean | null; mitigation: string; notices: string[]; references: string[]; matrix: Array<{ name: string; statuses: Record<string, PkgStatus> }>; matrixTotal: number; matrixReleases: string[]; releaseLabels: Record<string, string>;
  servers: ServerVerdict[]; advice: Advice[]; watching: boolean;
}
const SUPPORTED_FIRST = ['noble', 'jammy', 'focal', 'resolute', 'bionic', 'xenial'];

export async function lookup(rawId: string): Promise<Lookup> {
  const id = normalizeId(rawId);
  const [ub, osv] = await Promise.all([getJson(`${UBUNTU}${id}.json`), getJson(`${OSV}${id}`)]);
  if (ub.status === 'gagal' && osv.status === 'gagal') throw new HttpError(502, `Sumber data kerentanan tidak terjangkau dari server aplikasi (Ubuntu: ${ub.error}; OSV: ${osv.error}). Coba lagi nanti.`);
  const u = ub.status === 'ok' ? parseUbuntu(ub.json) : null, o = osv.status === 'ok' ? parseOsv(osv.json) : null;
  const sources = { ubuntu: ub.status === 'ok' ? (u ? 'ok' : 'tidak dikenal') : ub.status === 'gagal' ? `gagal: ${ub.error}` : 'tidak ada', osv: osv.status === 'ok' ? (o ? 'ok' : 'tidak dikenal') : osv.status === 'gagal' ? `gagal: ${osv.error}` : 'tidak ada' };
  const watching = !!(await db().one('SELECT 1 AS x FROM cve_watch WHERE cve=$1', [id]));
  if (!u && !o) return { id, found: false, sources, summary: '', description: '', published: null, updated: null, priority: '', cvss: null, vector: null, kev: null, mitigation: '', notices: [], references: [], matrix: [], matrixTotal: 0, matrixReleases: [], releaseLabels: {}, servers: [], advice: [], watching };

  const kevCount = Number((await db().one<{ n: number }>('SELECT COUNT(*)::int AS n FROM kev'))?.n ?? 0), kev = kevCount > 0 ? !!(await db().one('SELECT 1 AS x FROM kev WHERE cve=$1', [id])) : null;
  const rows = await loadServers(), osList = rows.map((r) => osOf(r));
  const reads = new Map<number, { map: Map<string, string> | null; error: string | null }>();
  if (u) await mapLimit(rows.filter((r) => codenameOf(osOf(r))), DPKG_CONCURRENCY, async (r) => { reads.set(r.id, await readInstalled(r)); });
  const servers = osList.map((os) => { const rd = reads.get(os.id); return assessServer(u, os, rd?.map ?? null, rd?.error ?? null); });
  servers.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || a.name.localeCompare(b.name));

  const relevant = new Set(servers.flatMap((s) => s.packages.filter((p) => p.verdict !== 'tidak_terdampak').map((p) => p.name)));
  const used = new Set(servers.map((s) => s.release).filter(Boolean) as string[]);
  const matrixReleases = [...new Set([...used, ...SUPPORTED_FIRST.slice(0, 3)])].filter((r) => u?.packages.some((p) => p.statuses[r]));
  const ordered = (u?.packages ?? []).filter((p) => matrixReleases.some((r) => p.statuses[r])).sort((a, b) => Number(relevant.has(b.name)) - Number(relevant.has(a.name)) || a.name.length - b.name.length || a.name.localeCompare(b.name));
  const matrix = ordered.slice(0, 12).map((p) => ({ name: p.name, statuses: Object.fromEntries(matrixReleases.filter((r) => p.statuses[r]).map((r) => [r, p.statuses[r]!])) }));
  const vector = o?.vector ?? null;
  return {
    id, found: true, sources, summary: o?.summary || (u?.description.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 300) ?? ''), description: u?.description || o?.details || '',
    published: u?.published ?? o?.published ?? null, updated: u?.updated ?? o?.modified ?? null, priority: u?.priority ?? '', cvss: u?.cvss ?? null, vector, kev, mitigation: u?.mitigation ?? '', notices: u?.notices ?? [], references: u?.references ?? [],
    matrix, matrixTotal: ordered.length, matrixReleases, releaseLabels: Object.fromEntries(matrixReleases.map((r) => [r, releaseLabel(r)])), servers, advice: adviceFor(u, vector, servers), watching
  };
}

// ---------- pantau
export type Snapshot = Record<string, string>;   // "paket@rilis" -> "status|versi-perbaikan"
export function snapshotOf(info: UbuntuCve, releases: string[], pkgs: string[]): Snapshot {
  const want = pkgs.length ? new Set(pkgs) : null, out: Snapshot = {};
  for (const p of info.packages) { if (want && !want.has(p.name)) continue; for (const r of releases) { const st = p.statuses[r]; if (st) out[`${p.name}@${r}`] = `${st.status}|${st.fixed}`; } }
  return out;
}
export interface Change { pkg: string; release: string; from: string; to: string; released: boolean }
export function diffSnapshots(old: Snapshot, cur: Snapshot): Change[] {
  const out: Change[] = [];
  for (const [k, to] of Object.entries(cur)) {
    const from = old[k] ?? ''; if (from === to) continue;
    const [pkg, release] = k.split('@') as [string, string];
    out.push({ pkg, release, from, to, released: to.startsWith('released|') && !from.startsWith('released|') });
  }
  return out;
}
const fmtStatus = (s: string): string => { const [st, fixed] = s.split('|'); return st ? (fixed && st !== 'not-affected' ? `${st} ${fixed}` : st) : 'baru'; };

async function watchedReleases(): Promise<string[]> { return [...new Set((await loadServers()).map((r) => codenameOf(osOf(r))).filter(Boolean) as string[])]; }

export async function watch(rawId: string, actor: string): Promise<{ ok: true; changes: number }> {
  const id = normalizeId(rawId);
  if (Number((await db().one<{ n: number }>('SELECT COUNT(*)::int AS n FROM cve_watch'))!.n) >= MAX_WATCH && !(await db().one('SELECT 1 AS x FROM cve_watch WHERE cve=$1', [id]))) throw bad(`Maksimal ${MAX_WATCH} CVE yang dipantau`);
  const look = await lookup(id); if (!look.found) throw bad('CVE tidak ditemukan di Ubuntu maupun OSV.dev, jadi tidak ada yang bisa dipantau.');
  const ub = await getJson(`${UBUNTU}${id}.json`), info = ub.status === 'ok' ? parseUbuntu(ub.json) : null;
  if (!info) throw bad('Tracker Ubuntu tidak punya data CVE ini, jadi status perbaikannya tidak bisa dipantau.');
  const pkgs = [...new Set(look.servers.flatMap((s) => s.packages.filter((p) => p.verdict !== 'tidak_terdampak').map((p) => p.name)))], releases = await watchedReleases();
  const snap = snapshotOf(info, releases, pkgs), now = Date.now();
  await db().exec(`INSERT INTO cve_watch(cve,created,last_check,snapshot,pkgs) VALUES($1,$2,$2,$3::jsonb,$4::jsonb) ON CONFLICT (cve) DO UPDATE SET snapshot=EXCLUDED.snapshot, pkgs=EXCLUDED.pkgs, last_check=EXCLUDED.last_check`, [id, now, JSON.stringify(snap), JSON.stringify(pkgs)]);
  await audit(actor, 'cve.pantau', id);
  return { ok: true, changes: 0 };
}
export async function unwatch(rawId: string, actor: string): Promise<void> {
  const id = normalizeId(rawId); await db().exec('DELETE FROM cve_watch WHERE cve=$1', [id]); await audit(actor, 'cve.berhenti-pantau', id);
}
export async function listWatches() {
  return (await db().query<{ cve: string; created: number; last_check: number | null; notified: number | null; snapshot: Snapshot }>('SELECT cve, created, last_check, notified, snapshot FROM cve_watch ORDER BY created DESC')).map((w) => ({
    cve: w.cve, created: Number(w.created), last_check: w.last_check == null ? null : Number(w.last_check), notified: w.notified == null ? null : Number(w.notified), state: Object.entries(w.snapshot ?? {}).slice(0, 6).map(([k, v]) => ({ key: k, value: fmtStatus(v) }))
  }));
}

/** Cek tiap CVE yang dipantau: bila status perbaikan berubah, kabari; bila perbaikan dirilis, minta agen melaporkan pembaruan sekarang supaya patch muncul di rencana patch. */
export async function checkWatches(now = Date.now()): Promise<{ checked: number; changed: number }> {
  const list = await db().query<{ cve: string; snapshot: Snapshot; pkgs: string[] }>('SELECT cve, snapshot, pkgs FROM cve_watch ORDER BY last_check NULLS FIRST LIMIT $1', [MAX_WATCH]);
  if (!list.length) return { checked: 0, changed: 0 };
  const rows = await loadServers(), osList = rows.map((r) => osOf(r)), releases = [...new Set(osList.map(codenameOf).filter(Boolean) as string[])];
  let changed = 0;
  for (const w of list) {
    const got = await getJson(`${UBUNTU}${w.cve}.json`), info = got.status === 'ok' ? parseUbuntu(got.json) : null;
    if (!info) { log().warn({ cve: w.cve, status: got.status }, 'pantau CVE: data Ubuntu tidak terbaca, dicoba lagi nanti'); continue; }
    const cur = snapshotOf(info, releases, w.pkgs ?? []), diff = diffSnapshots(w.snapshot ?? {}, cur);
    await db().exec('UPDATE cve_watch SET last_check=$1, snapshot=$2::jsonb WHERE cve=$3', [now, JSON.stringify(cur), w.cve]);
    if (!diff.length) continue;
    changed++;
    const released = diff.filter((d) => d.released), hit = [...new Set(released.map((d) => d.release))];
    const names = osList.filter((o) => hit.includes(codenameOf(o) ?? '')).map((o) => o.name);
    const lines = diff.slice(0, 8).map((d) => `${d.pkg} (${releaseLabel(d.release)}): ${fmtStatus(d.from)} -> ${fmtStatus(d.to)}`);
    const title = released.length ? `[CVE] ${w.cve}: perbaikan dirilis untuk ${hit.map(releaseLabel).join(', ')}` : `[CVE] ${w.cve}: status perbaikan berubah`;
    const text = `${lines.join('\n')}${names.length ? `\nServer yang perlu diperbarui: ${names.join(', ')}. Buka Cek CVE atau halaman Patch server untuk memasangnya.` : ''}`;
    if (released.length) {   // agen melapor ulang pembaruan pada heartbeat berikutnya, tidak menunggu putaran 6 jam
      for (const o of osList) if (o.hasAgent && hit.includes(codenameOf(o) ?? '')) await db().exec("INSERT INTO meta(key,value) VALUES($1,'1') ON CONFLICT(key) DO UPDATE SET value='1'", [`patch_refresh_${o.id}`]);
    }
    await db().exec('UPDATE cve_watch SET notified=$1 WHERE cve=$2', [now, w.cve]);
    await Notify.dispatch({ kind: 'cve', level: released.length ? 'major' : 'info', importance: released.length ? RANK.major : RANK.info, title, text }).catch((e) => log().warn({ err: (e as Error).message }, 'notifikasi CVE gagal'));
    await audit('sistem', 'cve.berubah', `${w.cve}: ${lines[0] ?? ''}`.slice(0, 300));
  }
  return { checked: list.length, changed };
}

let lastTick = 0;
/** Dipanggil penjadwal tiap menit; benar-benar bekerja tiap 6 jam. */
export async function tick(now = Date.now()): Promise<void> {
  if (now - lastTick < 6 * 3600e3) return; lastTick = now;
  await checkWatches(now).catch((e) => log().warn({ err: (e as Error).message }, 'pantau CVE gagal'));
}
/** Untuk uji. */
export function resetTick(): void { lastTick = 0; }
