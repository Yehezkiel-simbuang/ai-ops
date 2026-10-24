// Kerentanan yang ditutup oleh patch yang tertunda. Sumber publik, tanpa RAG: pencocokan persis paket dan versi.
//  - OSV.dev: untuk tiap paket sumber ditanyakan kerentanan yang menimpa versi TERPASANG dan yang menimpa versi BARU; selisihnya = yang ditutup patch.
//    (Data Debian dan Ubuntu dicatat per paket sumber, bukan paket biner.)
//  - CISA KEV: CVE yang sedang dieksploitasi. Hanya CVE yang tertutup patch dan ada di KEV yang menaikkan tingkat peringatan.
// Gagal menghubungi sumber = "tidak diketahui", tidak pernah dibaca sebagai "tidak ada kerentanan".
import { db, log } from './context.js';

const DAY = 864e5, OSV = 'https://api.osv.dev/v1/query', KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const MAX_SOURCES = 120, PARALLEL = 4, TIMEOUT_MS = 20_000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let doFetch: Fetcher = (url, init) => fetch(url, init);
/** Untuk uji: ganti pengambil data agar tidak menyentuh internet. */
export function setFetch(f: Fetcher | null): void { doFetch = f ?? ((url, init) => fetch(url, init)); }

export interface Vuln { id: string; cves: string[]; summary: string }
export interface PkgFacts { name: string; source?: string; old: string; new: string; sec: boolean }
export interface PkgVulns extends PkgFacts { cves: string[]; ids: string[]; exploited: string[]; unknown: boolean }
export interface VulnReport { ecosystem: string | null; pkgs: PkgVulns[]; kev_at: number | null }

/** Nama ekosistem OSV; null = distro yang belum didukung (tidak dinilai). */
export function ecosystemOf(osId: string | undefined, version: string | undefined): string | null {
  const id = (osId ?? '').toLowerCase(), v = version ?? '';
  if (id === 'debian' && /^\d+/.test(v)) return `Debian:${v.split('.')[0]}`;
  if (id === 'ubuntu' && /^\d{2}\.\d{2}$/.test(v)) return `Ubuntu:${v}${v.endsWith('.04') && Number(v.slice(0, 2)) % 2 === 0 ? ':LTS' : ''}`;
  return null;
}

async function post(body: unknown): Promise<any> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await doFetch(OSV, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error(`OSV HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const toVuln = (v: any): Vuln => ({
  id: String(v.id).slice(0, 60),
  cves: [...new Set([...(v.upstream ?? []), ...(v.aliases ?? []), ...(v.related ?? [])].filter((x: unknown): x is string => typeof x === 'string' && /^CVE-\d{4}-\d+$/.test(x)))].slice(0, 30),
  summary: String(v.summary || String(v.details ?? '').split('\n')[0] || '').slice(0, 160)
});

/** Kerentanan yang menimpa satu paket sumber pada satu versi; null bila sumber tidak bisa dihubungi. Di-cache 24 jam. */
export async function vulnsAt(eco: string, source: string, version: string, now = Date.now()): Promise<Vuln[] | null> {
  const key = `${eco}|${source}|${version}`, hit = await db().one<{ vulns: Vuln[]; fetched: number }>('SELECT vulns, fetched FROM vuln_cache WHERE key=$1', [key]);
  if (hit && now - hit.fetched < DAY) return hit.vulns;
  try {
    const all = new Map<string, Vuln>();
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await post({ package: { name: source, ecosystem: eco }, version, ...(token ? { page_token: token } : {}) });
      for (const v of r.vulns ?? []) all.set(String(v.id), toVuln(v));
      token = r.next_page_token; if (!token) break;
    }
    const out = [...all.values()];
    await db().exec('INSERT INTO vuln_cache(key,vulns,fetched) VALUES($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET vulns=EXCLUDED.vulns, fetched=EXCLUDED.fetched', [key, JSON.stringify(out), now]);
    return out;
  } catch (e) {
    log().warn({ err: (e as Error).message, source }, 'OSV tidak terjangkau');
    return hit ? hit.vulns : null;   // jawaban basi lebih baik daripada tidak tahu apa-apa
  }
}

/** Perbarui daftar KEV bila lebih tua dari 24 jam. Gagal = pakai yang ada. Mengembalikan waktu pembaruan terakhir yang berhasil. */
export async function ensureKev(now = Date.now()): Promise<number | null> {
  const meta = await db().one<{ value: string }>("SELECT value FROM meta WHERE key='kev_fetched'"), last = meta ? Number(meta.value) : null;
  if (last && now - last < DAY) return last;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60_000);
    const r = await doFetch(KEV_URL, { signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) throw new Error(`KEV HTTP ${r.status}`);
    const ids = (((await r.json()) as { vulnerabilities?: Array<{ cveID?: string }> }).vulnerabilities as Array<{ cveID?: string }> | undefined)?.map((v) => v.cveID).filter((x): x is string => typeof x === 'string' && /^CVE-\d{4}-\d+$/.test(x)) ?? [];
    if (ids.length < 100) throw new Error('daftar KEV tidak masuk akal (terlalu pendek); tidak dipakai');   // respons rusak jangan menghapus daftar yang baik
    await db().exec('DELETE FROM kev'); await db().exec('INSERT INTO kev(cve) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [ids]);
    await db().exec("INSERT INTO meta(key,value) VALUES('kev_fetched',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [String(now)]);
    return now;
  } catch (e) { log().warn({ err: (e as Error).message }, 'daftar KEV tidak terambil'); return last; }
}
const exploitedAmong = async (cves: string[]): Promise<string[]> => (cves.length ? (await db().query<{ cve: string }>('SELECT cve FROM kev WHERE cve = ANY($1::text[])', [cves])).map((r) => r.cve) : []);

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

/** Untuk tiap paket yang akan naik: kerentanan yang DITUTUP patch (menimpa versi terpasang, tidak menimpa versi baru), dan mana yang sedang dieksploitasi. */
export async function assessPackages(osId: string | undefined, osVersion: string | undefined, pkgs: PkgFacts[], now = Date.now()): Promise<VulnReport> {
  const eco = ecosystemOf(osId, osVersion);
  if (!eco || !pkgs.length) return { ecosystem: eco, pkgs: [], kev_at: null };   // tidak ada yang perlu ditanyakan: jangan menyentuh jaringan
  const kevAt = await ensureKev(now);
  const srcOf = (p: PkgFacts) => p.source || p.name;
  // paket keamanan didahulukan; batasi jumlah paket sumber agar satu laporan besar tidak menahan jalur ini terlalu lama
  const order = [...pkgs].sort((a, b) => Number(b.sec) - Number(a.sec)), sources = [...new Set(order.map(srcOf))].slice(0, MAX_SOURCES), keep = new Set(sources);
  const jobs = order.filter((p) => keep.has(srcOf(p))), found = new Map<string, Vuln[] | null>();
  const uniq = [...new Map(jobs.flatMap((p) => [[`${srcOf(p)}|${p.old}`, [srcOf(p), p.old] as const], [`${srcOf(p)}|${p.new}`, [srcOf(p), p.new] as const]])).entries()];
  await pool(uniq, PARALLEL, async ([k, [s, v]]) => { found.set(k, await vulnsAt(eco, s, v, now)); });
  const out: PkgVulns[] = [];
  for (const p of jobs) {
    const before = found.get(`${srcOf(p)}|${p.old}`), after = found.get(`${srcOf(p)}|${p.new}`);
    if (!before || !after) { out.push({ ...p, cves: [], ids: [], exploited: [], unknown: true }); continue; }
    const still = new Set(after.map((v) => v.id)), fixed = before.filter((v) => !still.has(v.id)), cves = [...new Set(fixed.flatMap((v) => v.cves))];
    out.push({ ...p, cves, ids: fixed.map((v) => v.id).slice(0, 20), exploited: await exploitedAmong(cves), unknown: false });
  }
  return { ecosystem: eco, pkgs: out, kev_at: kevAt };
}
