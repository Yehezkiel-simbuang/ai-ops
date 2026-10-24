// Standar pemantauan GLOBAL: batas minor, major (kolom warn), dan critical (kolom crit) dan jumlah konfirmasi untuk tiap pemeriksaan, dipakai semua server.
// Urutan nilai: standar yang diatur pengguna (tabel global_limits) -> bawaan di kode (BASE_LIMITS dan PACKS).
// Server MEMAKAI standar saat pemeriksaan berjalan (tidak menyalin), jadi mengubahnya langsung berlaku di semua server.
// Pemeriksaan kustom (bukan dari paket) tetap memakai nilainya sendiri.
import { z } from 'zod';
import { analystRole } from './ai.js';
import * as Checks from './checks.js';
import { createHash } from 'node:crypto';
import { audit, bad, db } from './context.js';
import { isLevel, type Level } from './levels.js';
import { allPacks, customPacks } from './custom-packs.js';
import { forRole, type RoleChat } from './llm.js';

const dep: { llm: RoleChat } = { llm: forRole };
export function configure(o: { llm?: RoleChat }): void { if (o.llm) dep.llm = o.llm; }

export interface BaseLimit { label: string; description: string; metric: string; unit: string; dir: 'gt' | 'lt'; minor: number | null; warn: number | null; crit: number | null; min: number; max: number }
/** Bawaan pemeriksaan dasar. "load" dinyatakan sebagai kelipatan jumlah core (1,5 = 1,5 kali jumlah core). */
export const BASE_LIMITS: Record<string, BaseLimit> = {
  load: { label: 'Beban CPU', description: 'Rata-rata antrean proses 5 menit, dibanding jumlah core. 1 berarti tepat penuh.', metric: 'load5', unit: 'x core', dir: 'gt', minor: 1, warn: 1.5, crit: 3, min: 0.1, max: 100 },
  mem: { label: 'Memori tersedia', description: 'Persen memori yang masih bisa dipakai. Makin kecil makin berbahaya.', metric: 'mem_avail_pct', unit: '%', dir: 'lt', minor: 20, warn: 10, crit: 5, min: 0, max: 100 },
  swap: { label: 'Swap terpakai', description: 'Memori yang dipindah ke disk. Banyak swap biasanya tanda RAM kurang.', metric: 'swap_used_mb', unit: 'MB', dir: 'gt', minor: 512, warn: 1024, crit: null, min: 0, max: 1_000_000 },
  disk: { label: 'Disk root terpakai', description: 'Persen ruang disk di "/" yang terisi.', metric: 'disk_root_pct', unit: '%', dir: 'gt', minor: 75, warn: 85, crit: 95, min: 0, max: 100 },
  io: { label: 'Tekanan I/O disk', description: 'Persen waktu proses menunggu disk (PSI, 10 detik). Tinggi berarti disk macet.', metric: 'io_psi10', unit: '%', dir: 'gt', minor: 10, warn: 20, crit: 50, min: 0, max: 100 }
};

/** Batas angka yang dihitung agen di server (bukan lewat SSH). Disimpan di global_limits dengan kunci "agent:<nama>". */
export const AGENT_LIMITS: Record<string, BaseLimit> = {
  ssh_fail: { label: 'Login SSH gagal', description: 'Jumlah login SSH gagal dalam jendela waktu (bawaan 10 menit), dihitung oleh agen di server. Tinggi berarti ada yang menebak password.', metric: '', unit: 'kali', dir: 'gt', minor: 5, warn: 15, crit: 30, min: 0, max: 100000 },
  // Fakta pembaruan dilaporkan agen tetapi DINILAI aplikasi (patching.ts), jadi tidak ikut dikirim ke agen (lihat SERVER_SIDE).
  patch_security: { label: 'Pembaruan keamanan tertunda', description: 'Jumlah paket yang punya pembaruan keamanan dan belum dipasang. Satu saja sudah layak dijadwalkan; menumpuk berarti server rawan.', metric: '', unit: 'paket', dir: 'gt', minor: 0, warn: 10, crit: 30, min: 0, max: 100000 },
  patch_updates: { label: 'Pembaruan paket tertunda', description: 'Jumlah semua paket yang bisa diperbarui, termasuk yang bukan keamanan.', metric: '', unit: 'paket', dir: 'gt', minor: 25, warn: 60, crit: 200, min: 0, max: 100000 },
  reboot_days: { label: 'Reboot tertunda', description: 'Berapa hari server menunggu reboot setelah kernel atau pustaka diperbarui. Selama belum reboot, perbaikan keamanannya belum dipakai.', metric: '', unit: 'hari', dir: 'gt', minor: 3, warn: 14, crit: 45, min: 0, max: 3650 },
  eol_days: { label: 'Sisa masa dukungan OS', description: 'Berapa hari lagi OS masih menerima pembaruan keamanan (dari daftar versi yang dikenal aplikasi). Nol atau minus berarti dukungannya sudah berakhir.', metric: '', unit: 'hari', dir: 'lt', minor: 180, warn: 60, crit: 0, min: -3650, max: 3650 }
};
/** Batas agent:* yang dihitung aplikasi, bukan agen. */
export const SERVER_SIDE = new Set(['patch_security', 'patch_updates', 'reboot_days', 'eol_days']);
export interface AgentEvent { label: string; description: string; level: Level }
/** Kejadian perubahan dari agen: tingkatnya ditetapkan menurut jenisnya (bukan batas angka) dan bisa diubah di halaman Standar. */
export const AGENT_EVENTS: Record<string, AgentEvent> = {
  'sec:users': { label: 'Akun baru yang bisa login', description: 'Ada akun baru yang bisa login, atau UID/shell akun berubah. Akun baru adalah pintu masuk baru.', level: 'critical' },
  'sec:keys': { label: 'Kunci SSH (authorized_keys) berubah', description: 'Ada kunci SSH yang ditambah atau diganti. Kunci tak dikenal berarti ada pintu masuk baru.', level: 'critical' },
  'sec:sudoers': { label: 'Aturan sudo berubah', description: 'sudoers atau sudoers.d berubah. NOPASSWD untuk akun biasa memberi akses root tanpa sandi.', level: 'critical' },
  'sec:sshd': { label: 'Konfigurasi sshd berubah', description: 'sshd_config atau sshd_config.d berubah; periksa PermitRootLogin dan PasswordAuthentication.', level: 'major' },
  'sec:ports': { label: 'Port baru mendengarkan dari luar', description: 'Ada port TCP baru yang terbuka selain di loopback.', level: 'major' },
  'sec:root_login': { label: 'Login root lewat SSH berhasil', description: 'Hanya dipantau bila root_login_crit menyala di agen. Banyak server memang memakainya.', level: 'major' }
};

export interface Override { minor: number | null; warn: number | null; crit: number | null; confirm: number | null }
/** warn = batas MAJOR, crit = batas CRITICAL; minor opsional. */
export type Limits = Record<string, { minor: number | null; warn: number | null; crit: number | null }>;

const baseKey = (k: string) => `base:${k}`;
const agentKey = (k: string) => `agent:${k}`;
/** Kunci tipe dasar (base:*) atau batas agen (agent:*): bentuknya sama, batas minor, major (warn), critical (crit). */
const limitDef = (key: string): BaseLimit | undefined => (key.startsWith('base:') ? BASE_LIMITS[key.slice(5)] : key.startsWith('agent:') ? AGENT_LIMITS[key.slice(6)] : undefined);
export const packKey = (pack: string, name: string) => `pack:${pack}:${name}`;

export async function loadOverrides(): Promise<Map<string, Override>> {
  const rows = await db().query<{ key: string; minor: number | null; warn: number | null; crit: number | null; confirm: number | null }>('SELECT key, minor, warn, crit, confirm FROM global_limits');
  return new Map(rows.map((r) => [r.key, { minor: r.minor, warn: r.warn, crit: r.crit, confirm: r.confirm }]));
}

/** Ambang dasar yang dipakai pemeriksaan resource (menggantikan nilai tetap di kode). */
export async function baseLimits(): Promise<Limits> {
  const o = await loadOverrides();
  return Object.fromEntries(Object.keys(BASE_LIMITS).filter((k) => o.has(baseKey(k))).map((k) => [k, { minor: o.get(baseKey(k))!.minor, warn: o.get(baseKey(k))!.warn, crit: o.get(baseKey(k))!.crit }]));
}

interface PackCheck { key: string; pack: string; packLabel: string; category: 'umum' | 'aplikasi'; name: string; type: string; typeLabel: string; numeric: boolean; dir: 'gt' | 'lt'; unit: string; default: { minor: number | null; warn: number | null; crit: number | null; confirm: number } }
const unitOf = (name: string, type: string): string => (/pct|%/.test(`${type} ${name}`) ? '%' : /\(ms\)/.test(name) ? 'ms' : /\(MB\)/.test(name) ? 'MB' : 'nilai');

/** Katalog pemeriksaan standar, dibangun dari definisi paket di kode. */
export async function packCatalog(): Promise<PackCheck[]> {
  const out: PackCheck[] = [];
  for (const [pack, P] of Object.entries(await allPacks())) {
    let defs: Checks.CheckDef[] = []; try { defs = P.make(Object.fromEntries(P.fields.map((f) => [f.k, f.def])), false); } catch { continue; }
    for (const d of defs) {
      const T = Checks.TYPES[d.type]; if (!T) continue;
      out.push({ key: packKey(pack, d.name), pack, packLabel: P.label, category: P.category ?? 'umum', name: d.name, type: d.type, typeLabel: T.label, numeric: T.kind === 'number' || T.kind === 'http' || T.kind === 'fpm', dir: d.dir ?? 'gt', unit: unitOf(d.name, d.type), default: { minor: d.minor ?? null, warn: d.warn ?? null, crit: d.crit ?? null, confirm: d.confirm ?? 2 } });
    }
  }
  return out;
}

/** Nilai yang berlaku untuk satu baris pemeriksaan: standar bila pemeriksaan berasal dari paket, kalau tidak nilainya sendiri. */
export function effective<T extends { pack?: string | null; name: string; warn?: number | null; crit?: number | null; confirm?: number | null }>(c: T, overrides: Map<string, Override>, catalog: Map<string, PackCheck>): { minor: number | null; warn: number | null; crit: number | null; confirm: number; source: 'global' | 'bawaan' | 'sendiri' } {
  const own = { minor: null as number | null, warn: c.warn ?? null, crit: c.crit ?? null, confirm: c.confirm ?? 2 };
  if (!c.pack) return { ...own, source: 'sendiri' };
  const key = packKey(c.pack, c.name), def = catalog.get(key);
  if (!def) return { ...own, source: 'sendiri' };
  const o = overrides.get(key);
  if (o) return { minor: o.minor, warn: o.warn, crit: o.crit, confirm: o.confirm ?? def.default.confirm, source: 'global' };
  return { ...def.default, source: 'bawaan' };
}
export const catalogMap = async (): Promise<Map<string, PackCheck>> => new Map((await packCatalog()).map((p) => [p.key, p]));

export const orderProblem = Checks.orderProblem;

export const standardBody = z.object({ key: z.string().min(1).max(200), minor: z.number().nullable().optional(), warn: z.number().nullable().optional(), crit: z.number().nullable().optional(), confirm: z.number().int().min(1).max(10).nullable().optional(), reset: z.boolean().optional() });

async function meta(key: string): Promise<{ dir: 'gt' | 'lt'; min: number; max: number; unit: string; label: string; numeric: boolean }> {
  if (key.startsWith('base:') || key.startsWith('agent:')) { const b = limitDef(key); if (!b) throw bad('Standar tidak dikenal'); return { dir: b.dir, min: b.min, max: b.max, unit: b.unit, label: b.label, numeric: true }; }
  const p = (await packCatalog()).find((x) => x.key === key); if (!p) throw bad('Standar tidak dikenal');
  return { dir: p.dir, min: -1_000_000, max: 1_000_000_000, unit: p.unit, label: p.name, numeric: p.numeric };
}

export async function setStandard(b: z.infer<typeof standardBody>, actor: string) {
  const m = await meta(b.key);
  if (b.reset) { await db().exec('DELETE FROM global_limits WHERE key=$1', [b.key]); await audit(actor, 'standar.pulihkan', m.label); return getStandards(); }
  if (!m.numeric) throw bad('Pemeriksaan ini hanya hidup atau mati dan tidak punya ambang');
  const minor = b.minor ?? null, warn = b.warn ?? null, crit = b.crit ?? null;
  if (limitDef(b.key) && warn == null) throw bad('Batas major wajib diisi');
  for (const v of [minor, warn, crit]) if (v != null && (!Number.isFinite(v) || v < m.min || v > m.max)) throw bad(`Nilai harus antara ${m.min} dan ${m.max} ${m.unit}`);
  const p = orderProblem(m.dir, warn, crit, minor); if (p) throw bad(p);
  await db().exec('INSERT INTO global_limits(key,minor,warn,crit,confirm,updated) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO UPDATE SET minor=$2, warn=$3, crit=$4, confirm=$5, updated=$6', [b.key, minor, warn, crit, b.confirm ?? null, Date.now()]);
  await audit(actor, 'standar.ubah', `${m.label} ${minor ?? '-'}/${warn ?? '-'}/${crit ?? '-'}`);
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
    return { key: baseKey(k), label: b.label, description: b.description, unit: b.unit, dir: b.dir, min: b.min, max: b.max, numeric: true, minor: ov ? ov.minor : b.minor, warn: ov ? ov.warn : b.warn, crit: ov ? ov.crit : b.crit, confirm: null as number | null, default: { minor: b.minor, warn: b.warn, crit: b.crit, confirm: null as number | null }, custom: !!ov, stats: base.get(k) ?? null, servers: base.get(k)?.servers ?? 0 };
  });
  const customs = new Map((await customPacks()).map((c) => [c.id, c])), groups = new Map<string, { id: string; label: string; category: 'umum' | 'aplikasi'; custom: boolean; unit: string | null; checks: unknown[] }>();
  for (const p of await packCatalog()) {
    const ov = o.get(p.key), g = groups.get(p.pack) ?? { id: p.pack, label: p.packLabel, category: customs.has(p.pack) ? 'aplikasi' as const : p.category, custom: customs.has(p.pack), unit: customs.get(p.pack)?.unit ?? null, checks: [] };
    g.checks.push({ key: p.key, name: p.name, typeLabel: p.typeLabel, numeric: p.numeric, dir: p.dir, unit: p.unit, minor: ov ? ov.minor : p.default.minor, warn: ov ? ov.warn : p.default.warn, crit: ov ? ov.crit : p.default.crit, confirm: ov?.confirm ?? p.default.confirm, default: p.default, custom: !!ov, stats: packs.get(p.key) ?? null, servers: using.get(p.key) ?? 0 });
    groups.set(p.pack, g);
  }
  const agentRows = Object.entries(AGENT_LIMITS).map(([k, b]) => {
    const ov = o.get(agentKey(k));
    return { key: agentKey(k), label: b.label, description: b.description, unit: b.unit, dir: b.dir, min: b.min, max: b.max, numeric: true, minor: ov ? ov.minor : b.minor, warn: ov ? ov.warn : b.warn, crit: ov ? ov.crit : b.crit, confirm: null as number | null, default: { minor: b.minor, warn: b.warn, crit: b.crit, confirm: null as number | null }, custom: !!ov, stats: null, servers: 0 };
  });
  const lv = await eventLevels(), custom = new Set((await db().query<{ key: string }>('SELECT key FROM global_events')).map((r) => r.key));
  const events = Object.entries(AGENT_EVENTS).map(([key, e]) => ({ key, label: e.label, description: e.description, level: lv[key]!, default: e.level, custom: custom.has(key) }));
  return { base: baseRows, agent: agentRows, events, packs: [...groups.values()] };
}

// ---------- tingkat kejadian dari agen (jenis kejadian -> tingkat) dan konfigurasi yang dikirim ke agen
export async function eventLevels(): Promise<Record<string, Level>> {
  const out: Record<string, Level> = Object.fromEntries(Object.entries(AGENT_EVENTS).map(([k, e]) => [k, e.level]));
  for (const r of await db().query<{ key: string; level: string }>('SELECT key, level FROM global_events')) if (AGENT_EVENTS[r.key] && isLevel(r.level)) out[r.key] = r.level;
  return out;
}

export const eventBody = z.object({ key: z.string().min(1).max(60), level: z.string().max(20).optional(), reset: z.boolean().optional() });
export async function setEventLevel(b: z.infer<typeof eventBody>, actor: string) {
  const def = AGENT_EVENTS[b.key]; if (!def) throw bad('Kejadian tidak dikenal');
  if (b.reset) { await db().exec('DELETE FROM global_events WHERE key=$1', [b.key]); await audit(actor, 'standar.kejadian.pulihkan', def.label); return getStandards(); }
  if (!isLevel(b.level)) throw bad('Tingkat harus info, minor, major, atau critical');
  await db().exec('INSERT INTO global_events(key,level,updated) VALUES($1,$2,$3) ON CONFLICT (key) DO UPDATE SET level=$2, updated=$3', [b.key, b.level, Date.now()]);
  await audit(actor, 'standar.kejadian.ubah', `${def.label}: ${b.level}`);
  return getStandards();
}

/** Yang dikirim ke agen: batas tiga tingkat untuk pemeriksaan dasar dan login SSH gagal, dan tingkat tiap jenis kejadian. version berubah bila isinya berubah. */
export async function agentConfig() {
  const o = await loadOverrides(), limits: Record<string, { minor: number | null; major: number | null; critical: number | null }> = {};
  const add = (name: string, key: string, b: BaseLimit) => { const ov = o.get(key); limits[name] = { minor: ov ? ov.minor : b.minor, major: ov ? ov.warn : b.warn, critical: ov ? ov.crit : b.crit }; };
  for (const k of ['load', 'mem', 'disk', 'io']) add(k, baseKey(k), BASE_LIMITS[k]!);
  for (const [k, b] of Object.entries(AGENT_LIMITS)) if (!SERVER_SIDE.has(k)) add(k, agentKey(k), b);
  const events = await eventLevels(), version = createHash('sha256').update(JSON.stringify({ limits, events })).digest('hex').slice(0, 12);
  return { version, limits, events };
}

// ---------- usulan AI dari data nyata (bukan tebakan murni)
const suggestSchema = z.object({ suggestions: z.array(z.object({ key: z.string().max(200), minor: z.number().nullable().optional(), warn: z.number().nullable(), crit: z.number().nullable(), why: z.string().max(300).default('') })).max(80) });
export interface Proposal { key: string; name: string; unit: string; current: { minor: number | null; warn: number | null; crit: number | null }; minor: number | null; warn: number | null; crit: number | null; why: string; problem: string }
type SugRow = { key: string; name: string; unit: string; dir: 'gt' | 'lt'; minor: number | null; warn: number | null; crit: number | null; stats: Stat | null; min: number; max: number };

export async function suggest(): Promise<{ proposals: Proposal[]; model: string; withData: number; total: number }> {
  const { role, model } = await analystRole();
  const st = await getStandards();
  const rows: SugRow[] = [
    ...st.base.map((b) => ({ key: b.key, name: b.label, unit: b.unit, dir: b.dir, minor: b.minor, warn: b.warn, crit: b.crit, stats: b.stats, min: b.min, max: b.max })),
    ...st.packs.flatMap((g) => (g.checks as Array<{ key: string; name: string; unit: string; dir: 'gt' | 'lt'; minor: number | null; warn: number | null; crit: number | null; numeric: boolean; stats: Stat | null }>).filter((c) => c.numeric).map((c) => ({ key: c.key, name: c.name, unit: c.unit, dir: c.dir, minor: c.minor, warn: c.warn, crit: c.crit, stats: c.stats, min: -1_000_000, max: 1_000_000_000 })))
  ];
  const withData = rows.filter((r) => r.stats && r.stats.count >= 30).length;
  const lines = rows.map((r) => `- ${r.key} | ${r.name} (${r.unit}, bahaya bila ${r.dir === 'gt' ? 'NAIK' : 'TURUN'}) | sekarang minor=${r.minor ?? '-'} warn=${r.warn ?? '-'} crit=${r.crit ?? '-'} | data 7 hari: ${r.stats ? `${r.stats.count} sampel dari ${r.stats.servers} server, min ${r.stats.min.toFixed(2)}, rata-rata ${r.stats.avg.toFixed(2)}, p95 ${r.stats.p95.toFixed(2)}, maks ${r.stats.max.toFixed(2)}` : 'belum ada'}`).join('\n');
  const r = await dep.llm(role, {
    system: 'Kamu SRE. Tetapkan tiga batas untuk standar pemantauan GLOBAL: minor (lihat kalau sempat), warn (= MAJOR, tindak hari ini), dan crit (= CRITICAL, tindak sekarang). Aturan ketat: gunakan data 7 hari bila ada dan jangan menebak bila datanya kurang: bila tidak ada data atau kurang dari 30 sampel, kembalikan nilai sekarang apa adanya. Untuk bahaya NAIK: minor <= warn <= crit, dan minor sedikit di atas p95 agar kebiasaan normal tidak berbunyi. Untuk bahaya TURUN: minor >= warn >= crit. Jawab HANYA JSON, tulis alasan singkat yang menyebut angka dari data.',
    messages: [{ role: 'user', content: `Daftar standar (kunci | nama | arah | nilai sekarang | data):\n${lines}\n\nBalas JSON: {"suggestions":[{"key":"kunci persis dari daftar","minor":angka atau null,"warn":angka atau null,"crit":angka atau null,"why":"alasan singkat"}]}` }],
    maxTokens: 4000
  });
  let parsed; try { const t = r.text, a = t.indexOf('{'), z2 = t.lastIndexOf('}'); parsed = suggestSchema.parse(JSON.parse(t.slice(a, z2 + 1))); } catch { throw bad('Jawaban model tidak bisa dibaca; coba lagi'); }
  const byKey = new Map(rows.map((x) => [x.key, x]));
  const proposals: Proposal[] = parsed.suggestions.flatMap((s) => {
    const row = byKey.get(s.key), minor = s.minor ?? null; if (!row || (s.warn === row.warn && s.crit === row.crit && minor === row.minor)) return [];
    const problem = orderProblem(row.dir, s.warn, s.crit, minor) ?? (limitDef(s.key) && s.warn == null ? 'Batas major wajib diisi' : [minor, s.warn, s.crit].some((v) => v != null && (!Number.isFinite(v) || v < row.min || v > row.max)) ? 'Nilai di luar rentang' : '');
    return [{ key: s.key, name: row.name, unit: row.unit, current: { minor: row.minor, warn: row.warn, crit: row.crit }, minor, warn: s.warn, crit: s.crit, why: s.why, problem }];
  });
  return { proposals, model, withData, total: rows.length };
}
