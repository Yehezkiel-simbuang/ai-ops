// Cek HTTP berkala: daftar target, hasil, penilaian (sehat/peringatan/kritis), dan notifikasi saat berubah keadaan.
// Penjadwalan ikut pemimpin penjadwal Monitor (onTick). Pemberitahuan hanya saat keadaan berubah, setelah `confirm` kali berturut-turut.
import { z } from 'zod';
import { audit, bad, db, log } from '../context.js';
import { open, seal } from '../crypto.js';
import { rank, RANK } from '../levels.js';
import * as Notify from '../notify.js';
import { parseTarget, probe, type ProbeResult } from './probe.js';
import * as Vercel from './vercel.js';

const DAY = 864e5, MAX_CHECKS = 100;
const dep: { probe: typeof probe; fetch: Vercel.Fetcher } = { probe, fetch: (url, init) => fetch(url, init) };
export function configure(o: { probe?: typeof probe; fetch?: Vercel.Fetcher }): void { if (o.probe) dep.probe = o.probe; if (o.fetch) dep.fetch = o.fetch; }

const vercelSchema = z.object({ token: z.string().trim().min(10).max(300), project: z.string().trim().min(1).max(200), teamId: z.string().trim().max(100).optional() });
export const createSchema = z.object({
  kind: z.enum(['http', 'vercel']).default('http'), vercel: vercelSchema.optional(),
  name: z.string().trim().min(1).max(80), url: z.string().trim().max(500).default(''),
  interval_s: z.number().int().min(30).max(3600).default(60), timeout_ms: z.number().int().min(1000).max(30000).default(10000),
  expect_status: z.number().int().refine((n) => n === 0 || (n >= 100 && n <= 599)).default(0), slow_ms: z.number().int().min(100).max(60000).default(2000),
  confirm: z.number().int().min(1).max(10).default(2), enabled: z.boolean().default(true)
});
// Skema ubah dibuat terpisah: .partial() pada skema buat tetap menerapkan nilai default dan akan mereset kolom yang tidak dikirim.
export const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(), url: z.string().trim().min(1).max(500).optional(), interval_s: z.number().int().min(30).max(3600).optional(), timeout_ms: z.number().int().min(1000).max(30000).optional(),
  expect_status: z.number().int().refine((n) => n === 0 || (n >= 100 && n <= 599)).optional(), slow_ms: z.number().int().min(100).max(60000).optional(),
  confirm: z.number().int().min(1).max(10).optional(), enabled: z.boolean().optional(), vercel: vercelSchema.partial().optional()
});
const MIN_INTERVAL: Record<string, number> = { http: 30, vercel: 300 };   // API pihak ketiga dibatasi lajunya: jangan terlalu sering

export interface Verdict { severity: 'critical' | 'major' | 'minor' | null; title: string; detail: string }
interface Rule { expect_status: number; slow_ms: number }

/** Menilai satu hasil pemeriksaan. Yang terburuk menang; null = sehat. */
export function judge(rule: Rule, r: ProbeResult, now = Date.now()): Verdict {
  if (r.code === null) return { severity: 'critical', title: 'Tidak bisa dijangkau', detail: r.error };
  const statusOk = rule.expect_status > 0 ? r.code === rule.expect_status : r.code >= 200 && r.code < 400;
  if (!statusOk) return { severity: 'critical', title: `Status ${r.code}`, detail: rule.expect_status > 0 ? `Diharapkan ${rule.expect_status}, dapat ${r.code}.` : `Status ${r.code} dianggap error.` };
  if (r.certExpires) {
    const days = Math.floor((r.certExpires - now) / DAY);
    if (days < 3) return { severity: 'critical', title: `Sertifikat HTTPS habis ${days < 0 ? 'sejak ' + -days + ' hari lalu' : 'dalam ' + days + ' hari'}`, detail: 'Pengunjung akan melihat peringatan tidak aman. Perpanjang sertifikat.' };
    if (days < 14) return { severity: 'major', title: `Sertifikat HTTPS habis dalam ${days} hari`, detail: 'Pastikan perpanjangan otomatis berjalan.' };
  }
  if (r.ms > rule.slow_ms) return { severity: 'minor', title: `Lambat (${r.ms} ms)`, detail: `Batas ${rule.slow_ms} ms.` };
  return { severity: null, title: 'Sehat', detail: `${r.code} dalam ${r.ms} ms` };
}

export interface Transition { bad_count: number; alert_level: '' | 'minor' | 'major' | 'critical'; notify: 'baru' | 'naik' | 'pulih' | null }
/** Mesin keadaan notifikasi: butuh `confirm` pemeriksaan buruk berturut-turut; pulih memberi tahu sekali. */
export function transition(prev: { bad_count: number; alert_level: string }, v: Verdict, confirm: number): Transition {
  if (!v.severity) return { bad_count: 0, alert_level: '', notify: prev.alert_level ? 'pulih' : null };
  const bad_count = prev.bad_count + 1, was = prev.alert_level as '' | 'minor' | 'major' | 'critical';
  if (bad_count < confirm) return { bad_count, alert_level: was, notify: null };
  if (!was) return { bad_count, alert_level: v.severity, notify: 'baru' };
  if (rank(v.severity) > rank(was)) return { bad_count, alert_level: v.severity, notify: 'naik' };
  return { bad_count, alert_level: v.severity, notify: null };   // sama atau turun: perbarui tanpa berisik
}

/** Baris untuk klien: kredensial penyedia tidak pernah keluar, hanya penanda bahwa ada. */
function view(row: Record<string, any>) {
  const { provider_enc, ...rest } = row;
  return { ...rest, has_token: !!provider_enc };
}

export async function list() {
  const since = Date.now() - DAY;
  const stats = await db().query<{ check_id: number; n: string; good: string; avg_ms: number | null }>(
    'SELECT check_id, count(*) AS n, count(*) FILTER (WHERE ok) AS good, avg(ms) FILTER (WHERE ok) AS avg_ms FROM web_results WHERE ts>$1 GROUP BY check_id', [since]);
  const by = new Map(stats.map((s) => [s.check_id, s]));
  return (await db().query('SELECT * FROM web_checks ORDER BY name, id')).map((c) => {
    const s = by.get(c.id), n = s ? Number(s.n) : 0;
    return { ...view(c), uptime24h: n ? Math.round((Number(s!.good) / n) * 1000) / 10 : null, avgMs24h: s?.avg_ms != null ? Math.round(s.avg_ms) : null, samples24h: n };
  });
}

export async function create(b: z.infer<typeof createSchema>, actor: string) {
  if (b.interval_s < MIN_INTERVAL[b.kind]!) throw bad(`Interval minimal ${MIN_INTERVAL[b.kind]} detik untuk jenis ini`);
  let url: string, enc = '';
  if (b.kind === 'vercel') { if (!b.vercel?.token || !b.vercel.project) throw bad('Token dan proyek Vercel wajib'); url = `vercel:${b.vercel.project}`; enc = seal(JSON.stringify(b.vercel)); }
  else url = parseTarget(b.url);
  if (Number((await db().one<{ n: string }>('SELECT count(*) AS n FROM web_checks'))!.n) >= MAX_CHECKS) throw bad(`Maksimal ${MAX_CHECKS} cek HTTP`);
  const row = await db().one('INSERT INTO web_checks(name,url,interval_s,timeout_ms,expect_status,slow_ms,confirm,enabled,created,kind,provider_enc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [b.name, url, b.interval_s, b.timeout_ms, b.expect_status, b.slow_ms, b.confirm, b.enabled, Date.now(), b.kind, enc]);
  await audit(actor, 'webcheck.tambah', `${b.name} ${url}`);
  return view(row!);
}

export async function update(id: number, b: z.infer<typeof patchSchema>, actor: string) {
  const cur = await db().one('SELECT * FROM web_checks WHERE id=$1', [id]); if (!cur) throw bad('Cek tidak ada');
  const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as typeof cur;
  if (cur.kind === 'http' && b.url !== undefined) next.url = parseTarget(b.url);
  if (cur.kind === 'vercel') next.url = cur.url;   // URL tidak berlaku untuk jenis ini
  if (next.interval_s < MIN_INTERVAL[cur.kind]!) throw bad(`Interval minimal ${MIN_INTERVAL[cur.kind]} detik untuk jenis ini`);
  let enc: string = cur.provider_enc;
  if (cur.kind === 'vercel' && b.vercel) { const merged = { ...JSON.parse(open(cur.provider_enc) || '{}'), ...Object.fromEntries(Object.entries(b.vercel).filter(([, v]) => v !== undefined && v !== '')) }; next.url = `vercel:${merged.project}`; enc = seal(JSON.stringify(merged)); }
  const reset = b.url !== undefined || b.vercel !== undefined || b.expect_status !== undefined || b.enabled === false;   // aturan berubah: mulai bersih
  const row = await db().one(`UPDATE web_checks SET name=$2,url=$3,interval_s=$4,timeout_ms=$5,expect_status=$6,slow_ms=$7,confirm=$8,enabled=$9,provider_enc=$10${reset ? ",bad_count=0,alert_level='',alert_title='',last_status='belum',last_title='',last_detail=''" : ''} WHERE id=$1 RETURNING *`,
    [id, next.name, next.url, next.interval_s, next.timeout_ms, next.expect_status, next.slow_ms, next.confirm, next.enabled, enc]);
  await audit(actor, 'webcheck.ubah', `${next.name}`);
  return view(row!);
}

export async function remove(id: number, actor: string): Promise<void> {
  const cur = await db().one<{ name: string }>('DELETE FROM web_checks WHERE id=$1 RETURNING name', [id]); if (!cur) throw bad('Cek tidak ada');
  await audit(actor, 'webcheck.hapus', cur.name);
}

export async function results(id: number, hours = 24) {
  const h = Math.min(Math.max(hours, 1), 24 * 14);
  return db().query('SELECT ts, ok, code, ms, error FROM web_results WHERE check_id=$1 AND ts>$2 ORDER BY ts', [id, Date.now() - h * 3600e3]);
}

const notifyFor = (c: { name: string; alert_title: string }, v: Verdict, t: Transition, prevLevel: string): void => {
  const lvl = t.alert_level, title = `Layanan ${c.name}: ${t.notify === 'pulih' ? c.alert_title : v.title}`;
  const m: Notify.Message = t.notify === 'pulih'
    ? { kind: 'web', level: 'resolved', importance: rank(prevLevel) || RANK.major, title, text: 'Kembali normal.' }
    : { kind: 'web', level: lvl === '' ? 'major' : lvl, importance: rank(lvl) || RANK.major, title, text: v.detail };
  Notify.dispatch(m).catch((e) => log().warn({ err: (e as Error).message }, 'notifikasi cek HTTP gagal'));
};

/** Menjalankan satu cek, menyimpan hasil, dan memberi tahu bila keadaan berubah. */
export async function runOne(id: number) {
  const c = await db().one('SELECT * FROM web_checks WHERE id=$1', [id]); if (!c) throw bad('Cek tidak ada');
  let r: ProbeResult, v: Verdict, reachedOk: boolean;
  if (c.kind === 'vercel') {
    const out = await Vercel.check(JSON.parse(open(c.provider_enc)) as Vercel.VercelCfg, dep.fetch);
    v = out.verdict; r = { ok: v.severity !== 'critical', code: null, ms: out.ms, error: v.severity === 'critical' ? v.title : '', certExpires: null }; reachedOk = v.severity !== 'critical';
  } else {
    r = await dep.probe(c.url, c.timeout_ms); v = judge(c as Rule, r);
    reachedOk = r.code !== null && (c.expect_status > 0 ? r.code === c.expect_status : r.code >= 200 && r.code < 400);
  }
  const t = transition(c as never, v, c.confirm), now = Date.now();
  await db().exec('INSERT INTO web_results(check_id,ts,ok,code,ms,error) VALUES($1,$2,$3,$4,$5,$6)', [id, now, reachedOk, r.code, r.ms, r.error.slice(0, 300)]);
  const alertTitle = t.notify === 'baru' || t.notify === 'naik' ? v.title : t.alert_level ? c.alert_title : '';
  await db().exec('UPDATE web_checks SET last_status=$2,last_title=$3,last_detail=$4,last_code=$5,last_ms=$6,last_run=$7,cert_expires=$8,bad_count=$9,alert_level=$10,alert_title=$11 WHERE id=$1',
    [id, v.severity ?? 'sehat', v.title, v.detail.slice(0, 300), r.code, r.ms, now, r.certExpires, t.bad_count, t.alert_level, alertTitle]);
  if (t.notify) notifyFor(c as never, v, t, c.alert_level);
  return { verdict: v, code: r.code, ms: r.ms };
}

let lastPurge = 0;
/** Dipanggil tiap tick penjadwal: klaim atomik cek yang jatuh tempo (aman bila ada dua pemimpin), jalankan paling banyak 5 sekaligus. */
export async function runDue(): Promise<void> {
  const now = Date.now();
  const due = await db().query<{ id: number }>(
    `UPDATE web_checks SET last_run=$1 WHERE id IN (SELECT id FROM web_checks WHERE enabled AND (last_run IS NULL OR last_run + interval_s*1000 <= $1) ORDER BY last_run NULLS FIRST LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING id`, [now]);
  for (let i = 0; i < due.length; i += 5) {
    await Promise.all(due.slice(i, i + 5).map((d) => runOne(d.id).catch((e) => log().warn({ err: (e as Error).message, id: d.id }, 'cek HTTP gagal dijalankan'))));
  }
  if (now - lastPurge > 3600e3) { lastPurge = now; await db().exec('DELETE FROM web_results WHERE ts<$1', [now - 14 * DAY]); }
}
