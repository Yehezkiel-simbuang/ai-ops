// Standar pemantauan GLOBAL: ambang peringatan/kritis dan jumlah konfirmasi untuk tiap pemeriksaan, dipakai semua server.
// Urutan nilai: standar yang diatur pengguna (tabel global_limits) -> bawaan di kode (BASE_LIMITS dan PACKS).
// Server MEMAKAI standar saat pemeriksaan berjalan (tidak menyalin), jadi mengubahnya langsung berlaku di semua server.
// Pemeriksaan kustom (bukan dari paket) tetap memakai nilainya sendiri.
import { z } from 'zod';
import { analystRole } from './ai.js';
import * as Checks from './checks.js';
import { audit, bad, db } from './context.js';
import { allPacks, customPacks } from './custom-packs.js';
import { forRole, type RoleChat } from './llm.js';

const dep: { llm: RoleChat } = { llm: forRole };
export function configure(o: { llm?: RoleChat }): void { if (o.llm) dep.llm = o.llm; }

export interface BaseLimit { label: string; description: string; metric: string; unit: string; dir: 'gt' | 'lt'; warn: number | null; crit: number | null; min: number; max: number }
/** Bawaan pemeriksaan dasar. "load" dinyatakan sebagai kelipatan jumlah core (1,5 = 1,5 kali jumlah core). */
export const BASE_LIMITS: Record<string, BaseLimit> = {
  load: { label: 'Beban CPU', description: 'Rata-rata antrean proses 5 menit, dibanding jumlah core. 1 berarti tepat penuh.', metric: 'load5', unit: 'x core', dir: 'gt', warn: 1.5, crit: 3, min: 0.1, max: 100 },
  mem: { label: 'Memori tersedia', description: 'Persen memori yang masih bisa dipakai. Makin kecil makin berbahaya.', metric: 'mem_avail_pct', unit: '%', dir: 'lt', warn: 10, crit: 5, min: 0, max: 100 },
  swap: { label: 'Swap terpakai', description: 'Memori yang dipindah ke disk. Banyak swap biasanya tanda RAM kurang.', metric: 'swap_used_mb', unit: 'MB', dir: 'gt', warn: 1024, crit: null, min: 0, max: 1_000_000 },
  disk: { label: 'Disk root terpakai', description: 'Persen ruang disk di "/" yang terisi.', metric: 'disk_root_pct', unit: '%', dir: 'gt', warn: 85, crit: 95, min: 0, max: 100 },
  io: { label: 'Tekanan I/O disk', description: 'Persen waktu proses menunggu disk (PSI, 10 detik). Tinggi berarti disk macet.', metric: 'io_psi10', unit: '%', dir: 'gt', warn: 20, crit: 50, min: 0, max: 100 }
};

export interface Override { warn: number | null; crit: number | null; confirm: number | null }
export type Limits = Record<string, { warn: number | null; crit: number | null }>;

const baseKey = (k: string) => `base:${k}`;
export const packKey = (pack: string, name: string) => `pack:${pack}:${name}`;

export async function loadOverrides(): Promise<Map<string, Override>> {
  const rows = await db().query<{ key: string; warn: number | null; crit: number | null; confirm: number | null }>('SELECT key, warn, crit, confirm FROM global_limits');
  return new Map(rows.map((r) => [r.key, { warn: r.warn, crit: r.crit, confirm: r.confirm }]));
}

/** Ambang dasar yang dipakai pemeriksaan resource (menggantikan nilai tetap di kode). */
export async function baseLimits(): Promise<Limits> {
  const o = await loadOverrides();
  return Object.fromEntries(Object.keys(BASE_LIMITS).filter((k) => o.has(baseKey(k))).map((k) => [k, { warn: o.get(baseKey(k))!.warn, crit: o.get(baseKey(k))!.crit }]));
}

interface PackCheck { key: string; pack: string; packLabel: string; category: 'umum' | 'aplikasi'; name: string; type: string; typeLabel: string; numeric: boolean; dir: 'gt' | 'lt'; unit: string; default: { warn: number | null; crit: number | null; confirm: number } }
const unitOf = (name: string, type: string): string => (/pct|%/.test(`${type} ${name}`) ? '%' : /\(ms\)/.test(name) ? 'ms' : /\(MB\)/.test(name) ? 'MB' : 'nilai');

/** Katalog pemeriksaan standar, dibangun dari definisi paket di kode. */
export async function packCatalog(): Promise<PackCheck[]> {
  const out: PackCheck[] = [];
  for (const [pack, P] of Object.entries(await allPacks())) {
    let defs: Checks.CheckDef[] = []; try { defs = P.make(Object.fromEntries(P.fields.map((f) => [f.k, f.def])), false); } catch { continue; }
    for (const d of defs) {
      const T = Checks.TYPES[d.type]; if (!T) continue;
      out.push({ key: packKey(pack, d.name), pack, packLabel: P.label, category: P.category ?? 'umum', name: d.name, type: d.type, typeLabel: T.label, numeric: T.kind === 'number' || T.kind === 'http' || T.kind === 'fpm', dir: d.dir ?? 'gt', unit: unitOf(d.name, d.type), default: { warn: d.warn ?? null, crit: d.crit ?? null, confirm: d.confirm ?? 2 } });
    }
  }
  return out;
}

/** Nilai yang berlaku untuk satu baris pemeriksaan: standar bila pemeriksaan berasal dari paket, kalau tidak nilainya sendiri. */
export function effective<T extends { pack?: string | null; name: string; warn?: number | null; crit?: number | null; confirm?: number | null }>(c: T, overrides: Map<string, Override>, catalog: Map<string, PackCheck>): { warn: number | null; crit: number | null; confirm: number; source: 'global' | 'bawaan' | 'sendiri' } {
  const own = { warn: c.warn ?? null, crit: c.crit ?? null, confirm: c.confirm ?? 2 };
  if (!c.pack) return { ...own, source: 'sendiri' };
  const key = packKey(c.pack, c.name), def = catalog.get(key);
  if (!def) return { ...own, source: 'sendiri' };
  const o = overrides.get(key);
  if (o) return { warn: o.warn, crit: o.crit, confirm: o.confirm ?? def.default.confirm, source: 'global' };
  return { ...def.default, source: 'bawaan' };
}
export const catalogMap = async (): Promise<Map<string, PackCheck>> => new Map((await packCatalog()).map((p) => [p.key, p]));

export const orderProblem = Checks.orderProblem;

export const standardBody = z.object({ key: z.string().min(1).max(200), warn: z.number().nullable().optional(), crit: z.number().nullable().optional(), confirm: z.number().int().min(1).max(10).nullable().optional(), reset: z.boolean().optional() });

async function meta(key: string): Promise<{ dir: 'gt' | 'lt'; min: number; max: number; unit: string; label: string; numeric: boolean }> {
  if (key.startsWith('base:')) { const b = BASE_LIMITS[key.slice(5)]; if (!b) throw bad('Standar tidak dikenal'); return { dir: b.dir, min: b.min, max: b.max, unit: b.unit, label: b.label, numeric: true }; }
  const p = (await packCatalog()).find((x) => x.key === key); if (!p) throw bad('Standar tidak dikenal');
  return { dir: p.dir, min: -1_000_000, max: 1_000_000_000, unit: p.unit, label: p.name, numeric: p.numeric };
}

export async function setStandard(b: z.infer<typeof standardBody>, actor: string) {
  const m = await meta(b.key);
  if (b.reset) { await db().exec('DELETE FROM global_limits WHERE key=$1', [b.key]); await audit(actor, 'standar.pulihkan', m.label); return getStandards(); }
  if (!m.numeric) throw bad('Pemeriksaan ini hanya hidup atau mati dan tidak punya ambang');
  const warn = b.warn ?? null, crit = b.crit ?? null;
  if (b.key.startsWith('base:') && warn == null) throw bad('Ambang peringatan wajib diisi');
  for (const v of [warn, crit]) if (v != null && (!Number.isFinite(v) || v < m.min || v > m.max)) throw bad(`Nilai harus antara ${m.min} dan ${m.max} ${m.unit}`);
  const p = orderProblem(m.dir, warn, crit); if (p) throw bad(p);
  await db().exec('INSERT INTO global_limits(key,warn,crit,confirm,updated) VALUES($1,$2,$3,$4,$5) ON CONFLICT (key) DO UPDATE SET warn=$2, crit=$3, confirm=$4, updated=$5', [b.key, warn, crit, b.confirm ?? null, Date.now()]);
  await audit(actor, 'standar.ubah', `${m.label} ${warn ?? '-'}/${crit ?? '-'}`);
  return getStandards();
}

export interface Stat { count: number; min: number; max: number; avg: number; p95: number; servers: number }

async function usageStats() {
  const since = Date.now() - 7 * 864e5, base = new Map<string, Stat>(), packs = new Map<string, Stat>();
  const names = Object.values(BASE_LIMITS).map((b) => b.metric);
  const cores = new Map((await db().query<{ server_id: number; v: number }>('SELECT DISTINCT ON (server_id) server_id, value AS v FROM metrics WHERE name=$1 AND ts>$2 ORDER BY server_id, ts DESC', ['nproc', since])).map((r) => [r.server_id, r.v || 1]));
  for (const r of await db().query<{ name: string; server_id: number; n: string; mn: number; mx: number; av: number; p95: number }>(
    'SELECT name, server_id, count(*) AS n, min(value) AS mn, max(value) AS mx, avg(value) AS av, percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95 FROM metrics WHERE ts>$1 AND name = ANY($2::text[]) GROUP BY name, server_id', [since, names])) {
    const key = Object.keys(BASE_LIMITS).find((k) => BASE_LIMITS[k]!.metric === r.name)!, d = key === 'load' ? cores.get(r.server_id) ?? 1 : 1, cur = base.get(key);   // beban dibagi jumlah core tiap server
    const s = { count: Number(r.n), min: r.mn / d, max: r.mx / d, avg: r.av / d, p95: r.p95 / d, servers: 1 };
    base.set(key, cur ? { count: cur.count + s.count, min: Math.min(cur.min, s.min), max: Math.max(cur.max, s.max), avg: (cur.avg * cur.count + s.avg * s.count) / (cur.count + s.count), p95: Math.max(cur.p95, s.p95), servers: cur.servers + 1 } : s);
  }
  for (const r of await db().query<{ pack: string; name: string; n: string; mn: number; mx: number; av: number; p95: number; sv: string }>(
    `SELECT c.pack, c.name, count(*) AS n, min(m.value) AS mn, max(m.value) AS mx, avg(m.value) AS av, percentile_cont(0.95) WITHIN GROUP (ORDER BY m.value) AS p95, count(DISTINCT m.server_id) AS sv
       FROM metrics m JOIN checks c ON c.server_id=m.server_id AND m.name='chk:'||c.id WHERE m.ts>$1 AND c.pack<>'' GROUP BY c.pack, c.name`, [since])) packs.set(packKey(r.pack, r.name), { count: Number(r.n), min: r.mn, max: r.mx, avg: r.av, p95: r.p95, servers: Number(r.sv) });
  const using = new Map((await db().query<{ pack: string; name: string; n: string }>("SELECT pack, name, count(*) AS n FROM checks WHERE pack<>'' GROUP BY pack, name")).map((r) => [packKey(r.pack, r.name), Number(r.n)]));
  return { base, packs, using };
}

export async function getStandards() {
  const o = await loadOverrides(), { base, packs, using } = await usageStats();
  const baseRows = Object.entries(BASE_LIMITS).map(([k, b]) => {
    const ov = o.get(baseKey(k));
    return { key: baseKey(k), label: b.label, description: b.description, unit: b.unit, dir: b.dir, min: b.min, max: b.max, numeric: true, warn: ov ? ov.warn : b.warn, crit: ov ? ov.crit : b.crit, confirm: null as number | null, default: { warn: b.warn, crit: b.crit, confirm: null as number | null }, custom: !!ov, stats: base.get(k) ?? null, servers: base.get(k)?.servers ?? 0 };
  });
  const customs = new Map((await customPacks()).map((c) => [c.id, c])), groups = new Map<string, { id: string; label: string; category: 'umum' | 'aplikasi'; custom: boolean; unit: string | null; checks: unknown[] }>();
  for (const p of await packCatalog()) {
    const ov = o.get(p.key), g = groups.get(p.pack) ?? { id: p.pack, label: p.packLabel, category: customs.has(p.pack) ? 'aplikasi' as const : p.category, custom: customs.has(p.pack), unit: customs.get(p.pack)?.unit ?? null, checks: [] };
    g.checks.push({ key: p.key, name: p.name, typeLabel: p.typeLabel, numeric: p.numeric, dir: p.dir, unit: p.unit, warn: ov ? ov.warn : p.default.warn, crit: ov ? ov.crit : p.default.crit, confirm: ov?.confirm ?? p.default.confirm, default: p.default, custom: !!ov, stats: packs.get(p.key) ?? null, servers: using.get(p.key) ?? 0 });
    groups.set(p.pack, g);
  }
  return { base: baseRows, packs: [...groups.values()] };
}

// ---------- usulan AI dari data nyata (bukan tebakan murni)
const suggestSchema = z.object({ suggestions: z.array(z.object({ key: z.string().max(200), warn: z.number().nullable(), crit: z.number().nullable(), why: z.string().max(300).default('') })).max(80) });
export interface Proposal { key: string; name: string; unit: string; current: { warn: number | null; crit: number | null }; warn: number | null; crit: number | null; why: string; problem: string }

export async function suggest(): Promise<{ proposals: Proposal[]; model: string; withData: number; total: number }> {
  const { role, model } = await analystRole();
  const st = await getStandards();
  const rows: Array<{ key: string; name: string; unit: string; dir: 'gt' | 'lt'; warn: number | null; crit: number | null; stats: Stat | null; min: number; max: number }> = [
    ...st.base.map((b) => ({ key: b.key, name: b.label, unit: b.unit, dir: b.dir, warn: b.warn, crit: b.crit, stats: b.stats, min: b.min, max: b.max })),
    ...st.packs.flatMap((g) => (g.checks as Array<{ key: string; name: string; unit: string; dir: 'gt' | 'lt'; warn: number | null; crit: number | null; numeric: boolean; stats: Stat | null }>).filter((c) => c.numeric).map((c) => ({ key: c.key, name: c.name, unit: c.unit, dir: c.dir, warn: c.warn, crit: c.crit, stats: c.stats, min: -1_000_000, max: 1_000_000_000 })))
  ];
  const withData = rows.filter((r) => r.stats && r.stats.count >= 30).length;
  const lines = rows.map((r) => `- ${r.key} | ${r.name} (${r.unit}, bahaya bila ${r.dir === 'gt' ? 'NAIK' : 'TURUN'}) | sekarang warn=${r.warn ?? '-'} crit=${r.crit ?? '-'} | data 7 hari: ${r.stats ? `${r.stats.count} sampel dari ${r.stats.servers} server, min ${r.stats.min.toFixed(2)}, rata-rata ${r.stats.avg.toFixed(2)}, p95 ${r.stats.p95.toFixed(2)}, maks ${r.stats.max.toFixed(2)}` : 'belum ada'}`).join('\n');
  const r = await dep.llm(role, {
    system: 'Kamu SRE. Tetapkan ambang peringatan (warn) dan kritis (crit) untuk standar pemantauan GLOBAL. Aturan ketat: gunakan data 7 hari bila ada dan jangan menebak bila datanya kurang: bila tidak ada data atau kurang dari 30 sampel, kembalikan nilai sekarang apa adanya. Untuk bahaya NAIK: kritis >= peringatan, dan peringatan sedikit di atas p95 agar kebiasaan normal tidak berbunyi. Untuk bahaya TURUN: kritis <= peringatan. Jawab HANYA JSON, tulis alasan singkat yang menyebut angka dari data.',
    messages: [{ role: 'user', content: `Daftar standar (kunci | nama | arah | nilai sekarang | data):\n${lines}\n\nBalas JSON: {"suggestions":[{"key":"kunci persis dari daftar","warn":angka atau null,"crit":angka atau null,"why":"alasan singkat"}]}` }],
    maxTokens: 4000
  });
  let parsed; try { const t = r.text, a = t.indexOf('{'), z2 = t.lastIndexOf('}'); parsed = suggestSchema.parse(JSON.parse(t.slice(a, z2 + 1))); } catch { throw bad('Jawaban model tidak bisa dibaca; coba lagi'); }
  const byKey = new Map(rows.map((x) => [x.key, x]));
  const proposals: Proposal[] = parsed.suggestions.flatMap((s) => {
    const row = byKey.get(s.key); if (!row || (s.warn === row.warn && s.crit === row.crit)) return [];
    const problem = orderProblem(row.dir, s.warn, s.crit) ?? (s.key.startsWith('base:') && s.warn == null ? 'Ambang peringatan wajib diisi' : [s.warn, s.crit].some((v) => v != null && (!Number.isFinite(v) || v < row.min || v > row.max)) ? 'Nilai di luar rentang' : '');
    return [{ key: s.key, name: row.name, unit: row.unit, current: { warn: row.warn, crit: row.crit }, warn: s.warn, crit: s.crit, why: s.why, problem }];
  });
  return { proposals, model, withData, total: rows.length };
}
