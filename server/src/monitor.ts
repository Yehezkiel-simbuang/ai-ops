// Mode monitoring: pemeriksaan baca-saja berkala lewat SSH, metrik disimpan di database, peringatan dengan ambang,
// pemeriksaan layanan di dalam server, dan analisis ringkas oleh model peran "monitor".
// Penjadwal hanya berjalan di satu instance pada satu waktu (kunci advisory PostgreSQL), sehingga aman bila ada lebih dari satu replika.
import pg from 'pg';
import { audit, bad, ctx, db, log, metaGet } from './context.js';
import * as Checks from './checks.js';
import * as Notify from './notify.js';
import * as Servers from './servers.js';
import { allPacks, customPacks, detectCustom } from './custom-packs.js';
import { rank, type Level } from './levels.js';
import { BASE_LIMITS, baseLimits, catalogMap, effective, loadOverrides, orderProblem, type Limits } from './standards.js';
import { forRole, type RoleChat } from './llm.js';

const dep: { llm: RoleChat } = { llm: forRole };
export function configure(o: { llm?: RoleChat }): void { if (o.llm) dep.llm = o.llm; }

// satu kali jalan SSH, semua baca-saja. Nama layanan sudah divalidasi di servers.ts.
export function script(server: { services: string }): string {
  const svc = (server.services ? server.services.split(',') : []).map((s) => `echo "svc.${s}=$(systemctl is-active ${s} 2>/dev/null || echo unknown)"`).join('; ');
  return ['echo "load=$(cut -d\' \' -f1-3 /proc/loadavg)"', 'echo "nproc=$(nproc)"',
    'awk \'/MemTotal/{t=$2}/MemAvailable/{a=$2}/SwapTotal/{st=$2}/SwapFree/{sf=$2}END{printf "mem_total_mb=%d\\nmem_avail_pct=%.1f\\nswap_used_mb=%d\\n", t/1024, (t>0?100*a/t:0), (st-sf)/1024}\' /proc/meminfo',
    'echo "disk_root_pct=$(df -P / | awk \'NR==2{gsub("%","",$5);print $5}\')"', 'echo "uptime_h=$(awk \'{printf "%.1f", $1/3600}\' /proc/uptime)"',
    'echo "io_psi10=$(grep some /proc/pressure/io 2>/dev/null | sed \'s/.*avg10=\\([0-9.]*\\).*/\\1/\')"', ...(svc ? [svc] : [])].join('; ');
}
export function parse(out: string): { metrics: Record<string, number>; services: Record<string, string> } {
  const metrics: Record<string, number> = {}, services: Record<string, string> = {};
  for (const l of String(out).split('\n')) {
    const k = l.match(/^([a-z0-9_.@-]+)=(.*)$/i); if (!k) continue; const key = k[1]!, val = k[2]!;
    if (key === 'load') { const p = val.trim().split(/\s+/).map(Number); if (p.length >= 3) { metrics.load1 = p[0]!; metrics.load5 = p[1]!; metrics.load15 = p[2]!; } }
    else if (key.startsWith('svc.')) services[key.slice(4)] = val.trim();
    else { const v = parseFloat(val); if (Number.isFinite(v)) metrics[key] = v; }
  }
  return { metrics, services };
}

export interface Cond { key: string; on: boolean; level: Level; title: string; detail: string }
export function evaluate(m: Record<string, number>, svc: Record<string, string>, limits: Limits = {}): Cond[] {
  const out: Cond[] = [], cpu = m.nproc || 1;
  const add = (key: string, on: boolean, level: Level, title: string, detail: string) => out.push({ key, on, level, title, detail });
  // ambang: bawaan di BASE_LIMITS, ditimpa pengaturan server. Beban dinyatakan sebagai kelipatan jumlah core.
  const L = (k: string) => ({ minor: limits[k] ? limits[k]!.minor : BASE_LIMITS[k]!.minor, warn: limits[k] ? limits[k]!.warn : BASE_LIMITS[k]!.warn, crit: limits[k] ? limits[k]!.crit : BASE_LIMITS[k]!.crit });
  const hit = (k: string, v: number, th: number | null) => th != null && (BASE_LIMITS[k]!.dir === 'lt' ? v < th : v > th);
  const eval_ = (k: string, v: number, scale = 1) => { const l = L(k), sc = (x: number | null) => (x == null ? null : x * scale); const lv: Level | null = hit(k, v, sc(l.crit)) ? 'critical' : hit(k, v, sc(l.warn)) ? 'major' : hit(k, v, sc(l.minor)) ? 'minor' : null; return { on: lv !== null, level: lv ?? 'major' }; };   // warn = batas major, crit = critical
  if (m.load5 != null) { const e = eval_('load', m.load5, cpu); add('load', e.on, e.level, 'Beban CPU tinggi', `load 5 menit ${m.load5} pada ${cpu} core`); }
  if (m.mem_avail_pct != null) { const e = eval_('mem', m.mem_avail_pct); add('mem', e.on, e.level, 'Memori tersedia menipis', `tersedia ${m.mem_avail_pct}% dari ${m.mem_total_mb} MB`); }
  if (m.swap_used_mb != null) { const e = eval_('swap', m.swap_used_mb); add('swap', e.on, e.level, 'Swap terpakai banyak', `${m.swap_used_mb} MB swap terpakai`); }
  if (m.disk_root_pct != null) { const e = eval_('disk', m.disk_root_pct); add('disk', e.on, e.level, 'Disk root hampir penuh', `${m.disk_root_pct}% terpakai`); }
  if (m.io_psi10 != null) { const e = eval_('io', m.io_psi10); add('io', e.on, e.level, 'Tekanan I/O disk tinggi', `PSI io (some) 10 dtk = ${m.io_psi10}%`); }
  for (const s of Object.keys(svc)) add(`svc:${s}`, svc[s] !== 'active', 'critical', `Layanan ${s} tidak aktif`, `status: ${svc[s]}`);
  return out;
}

// satu peringatan terbuka per (server, key): dijamin indeks unik parsial, jadi aman terhadap pemeriksaan bersamaan
/** `at` = jam kejadian (ms) bila berbeda dari sekarang, mis. kejadian agen yang tertunda di spool; bawaannya sekarang. */
export async function syncAlerts(serverId: number, conds: Array<Cond | { key: string; on: false }>, source: 'resource' | 'service' | 'agent' = 'resource', at: number = Date.now()): Promise<Cond[]> {
  const created: Cond[] = [], srv = await Servers.get(serverId), name = srv ? srv.name : String(serverId);
  for (const c of conds) {
    const open = await db().one('SELECT * FROM alerts WHERE server_id=$1 AND key=$2 AND NOT resolved', [serverId, c.key]);
    if (c.on && !open) {
      const x = c as Cond, row = await db().one('INSERT INTO alerts(server_id,ts,level,key,title,detail,source) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *', [serverId, at, x.level, x.key, x.title, x.detail, source]);
      if (row) { created.push(x); Notify.alertOpened(row as never, name); }
    } else if (c.on && open) {
      const x = c as Cond; await db().exec('UPDATE alerts SET level=$1, detail=$2 WHERE id=$3', [x.level, x.detail, open.id]);
      if (rank(x.level) > rank(open.level)) Notify.alertOpened({ ...open, level: x.level, detail: x.detail } as never, name);   // tingkat naik: kabari lagi sesuai aturan tingkat barunya
    } else if (!c.on && open) { await db().exec('UPDATE alerts SET resolved=true WHERE id=$1', [open.id]); Notify.alertResolved(open as never, name); }
  }
  return created;
}

export async function check(serverId: number | string) {
  const s = await Servers.get(serverId); if (!s) throw bad('Server tidak ada');
  const now = Date.now(), r = await Servers.run(s, script(s), { timeoutMs: 25_000 });
  if (r.exitCode !== 0 && !r.stdout.trim()) {
    await db().exec('UPDATE servers SET last_status=$1 WHERE id=$2', ['tidak terjangkau', s.id]);
    const created = await syncAlerts(s.id, [{ key: 'unreachable', on: true, level: 'critical', title: 'Server tidak terjangkau', detail: (r.stderr || 'tanpa keluaran').trim().split('\n').slice(-1)[0]!.slice(0, 200) }], 'resource');
    return { ok: false as const, created };
  }
  const p = parse(r.stdout);
  await db().tx(async (t) => { for (const [k, v] of Object.entries(p.metrics)) await t.exec('INSERT INTO metrics(server_id,ts,name,value) VALUES($1,$2,$3,$4)', [s.id, now, k, v]); });
  const created = await syncAlerts(s.id, [...evaluate(p.metrics, p.services, await baseLimits()), { key: 'unreachable', on: false as const }], 'resource');
  const svc = await runChecks(s); created.push(...svc.created);
  const open = (await db().one<{ c: number }>("SELECT COUNT(*)::int AS c FROM alerts WHERE server_id=$1 AND NOT resolved AND level IN ('major','critical')", [s.id]))!.c;
  await db().exec('UPDATE servers SET last_seen=$1, last_status=$2 WHERE id=$3', [now, open ? 'peringatan' : 'ok', s.id]);
  if (created.length && (await metaGet('auto_report')) === '1') void maybeAutoReport(s.id).catch((e) => log().warn({ err: (e as Error).message }, 'laporan otomatis gagal'));
  return { ok: true as const, metrics: p.metrics, services: p.services, created, checks: svc.results };
}

export async function series(serverId: number | string, name: string, minutes = 60) { return db().query('SELECT ts, value FROM metrics WHERE server_id=$1 AND name=$2 AND ts>=$3 ORDER BY ts', [Number(serverId), name, Date.now() - minutes * 60_000]); }
export async function latest(serverId: number | string) {
  const o: Record<string, { value: number; ts: number }> = {};
  for (const r of await db().query('SELECT DISTINCT ON (name) name, value, ts FROM metrics WHERE server_id=$1 ORDER BY name, ts DESC', [Number(serverId)])) o[r.name] = { value: r.value, ts: r.ts };
  return o;
}
export async function alerts(serverId?: number | string | null, onlyOpen = false) {
  const where: string[] = [], args: unknown[] = [];
  if (serverId) { args.push(Number(serverId)); where.push(`a.server_id=$${args.length}`); }
  if (onlyOpen) where.push('NOT a.resolved');
  return db().query(`SELECT a.*, s.name AS server_name FROM alerts a JOIN servers s ON s.id=a.server_id${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY a.resolved, a.ts DESC LIMIT 100`, args);
}
export async function ackAlert(id: number | string): Promise<void> { await db().exec('UPDATE alerts SET acked=true WHERE id=$1', [Number(id)]); }

export async function analyze(serverId: number | string) {
  const s = await Servers.get(serverId); if (!s) throw bad('Server tidak ada');
  const lines: string[] = [];
  for (const n of ['load5', 'mem_avail_pct', 'swap_used_mb', 'disk_root_pct', 'io_psi10']) {
    const v = (await series(s.id, n, 120)).map((x) => x.value as number); if (!v.length) continue;
    lines.push(`${n}: terakhir ${v[v.length - 1]}, min ${Math.min(...v)}, maks ${Math.max(...v)}, rata-rata ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)} (${v.length} sampel / 2 jam)`);
  }
  if (!lines.length) throw bad('Belum ada data metrik. Aktifkan monitoring dan tunggu satu putaran pemeriksaan.');
  const al = (await alerts(s.id, true)).map((a) => `- [${a.level}] ${a.title}: ${a.detail}`);
  const prompt = `Server: ${s.name} (${s.os_info || 'OS belum diketahui'})\nMetrik 2 jam terakhir:\n${lines.join('\n')}\nPeringatan aktif:\n${al.join('\n') || '(tidak ada)'}\n\nTulis penilaian singkat dalam bahasa Indonesia (maks. 8 baris): apakah sehat, apa yang paling perlu perhatian dan buktinya dari angka di atas, dan satu langkah berikutnya yang konkret. Jangan mengarang data yang tidak ada.`;
  const r = await dep.llm('monitor', { system: 'Kamu asisten monitoring server yang teliti dan ringkas.', messages: [{ role: 'user', content: prompt }], maxTokens: 700 });
  await db().exec('INSERT INTO reports(server_id,ts,text) VALUES($1,$2,$3)', [s.id, Date.now(), r.text.trim()]); return { text: r.text.trim(), usage: r.usage };
}
async function maybeAutoReport(serverId: number): Promise<void> {
  const last = await db().one<{ ts: number | null }>('SELECT MAX(ts) AS ts FROM reports WHERE server_id=$1', [serverId]);
  if (last?.ts && Date.now() - last.ts < 30 * 60_000) return; await analyze(serverId);
}
export async function reports(serverId: number | string) { return db().query('SELECT * FROM reports WHERE server_id=$1 ORDER BY ts DESC LIMIT 5', [Number(serverId)]); }

// ---------- pemeriksaan layanan (di dalam server)
export async function listChecks(serverId: number | string) {
  const rows = await db().query('SELECT * FROM checks WHERE server_id=$1 ORDER BY pack, id', [Number(serverId)]), overrides = await loadOverrides(), catalog = await catalogMap();
  return rows.map((c: any) => { const e = effective(c, overrides, catalog); return { ...c, warn: e.warn, crit: e.crit, confirm: e.confirm, std_source: e.source }; });   // nilai yang BERLAKU, bukan salinan lama di baris
}
function validateDef(d: Checks.CheckDef & { params?: Record<string, unknown> }) {
  if (!Checks.TYPES[d.type]) throw bad('Tipe pemeriksaan tidak dikenal');
  const name = String(d.name || '').trim(); if (!name || name.length > 100) throw bad('Nama pemeriksaan wajib (maks. 100 karakter)');
  try { Checks.buildCommand({ type: d.type, params: d.params ?? {} }); } catch (e) { throw bad((e as Error).message); }   // parameter tidak valid atau perintah kustom tidak baca-saja
  const n = (v: unknown): number | null => (v === '' || v == null ? null : Number(v));
  const o = { name, type: d.type, params: d.params ?? {}, warn: n(d.warn), crit: n(d.crit), dir: d.dir === 'lt' ? 'lt' : 'gt', delta: !!d.delta, confirm: Math.min(10, Math.max(1, Number(d.confirm) || 2)), pack: String(d.pack || '') };
  if ((o.warn != null && !Number.isFinite(o.warn)) || (o.crit != null && !Number.isFinite(o.crit))) throw bad('Ambang harus angka');
  const order = orderProblem(o.dir, o.warn, o.crit); if (order) throw bad(order);
  return o;
}
export async function addChecks(serverId: number | string, defs: Checks.CheckDef[]): Promise<string[]> {
  const s = await Servers.get(serverId); if (!s) throw bad('Server tidak ada'); const added: string[] = [];
  await db().tx(async (t) => {
    for (const d of defs) {
      const o = validateDef(d); const r = await t.exec('INSERT INTO checks(server_id,name,type,params,warn,crit,dir,delta,confirm,pack,created) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (server_id,name) DO NOTHING', [s.id, o.name, o.type, JSON.stringify(o.params), o.warn, o.crit, o.dir, o.delta, o.confirm, o.pack, Date.now()]);
      if (r) added.push(o.name);
    }
  });
  await audit('pengguna', 'check.tambah', `${s.name}: ${added.length} pemeriksaan`); return added;
}
export async function applyPack(serverId: number | string, pack: string, opts: Record<string, unknown> = {}): Promise<string[]> {
  const s = await Servers.get(serverId), P = (await allPacks())[pack]; if (!s) throw bad('Server tidak ada'); if (!P) throw bad('Paket tidak dikenal');
  return addChecks(serverId, P.make(opts, !!s.use_sudo).map((d) => ({ ...d, pack })));
}
export async function updateCheck(id: number | string, b: Record<string, unknown>) {
  const c = await db().one('SELECT * FROM checks WHERE id=$1', [Number(id)]); if (!c) throw bad('Pemeriksaan tidak ada');
  if (c.pack && (await catalogMap()).has(`pack:${c.pack}:${c.name}`) && (b.warn !== undefined || b.crit !== undefined || b.confirm !== undefined || b.dir !== undefined || b.delta !== undefined)) throw bad('Ambang pemeriksaan dari paket diatur di halaman Standar pemantauan (berlaku untuk semua server)');
  const next: any = { ...c, params: b.params ?? c.params }; for (const k of ['name', 'warn', 'crit', 'dir', 'delta', 'confirm']) if (b[k] !== undefined) next[k] = b[k];
  const o = validateDef(next), en = b.enabled === undefined ? c.enabled : !!b.enabled;
  await db().exec('UPDATE checks SET name=$1, params=$2::jsonb, warn=$3, crit=$4, dir=$5, delta=$6, confirm=$7, enabled=$8, fail_count=0 WHERE id=$9', [o.name, JSON.stringify(o.params), o.warn, o.crit, o.dir, o.delta, o.confirm, en, c.id]);
  if (!en) await resolveCheckAlert(c.server_id, c.id); await audit('pengguna', 'check.ubah', c.name); return listChecks(c.server_id);
}
async function resolveCheckAlert(serverId: number, checkId: number): Promise<void> { await db().exec('UPDATE alerts SET resolved=true WHERE server_id=$1 AND key=$2 AND NOT resolved', [serverId, `chk:${checkId}`]); }
export async function deleteCheck(id: number | string): Promise<void> {
  const c = await db().one('SELECT * FROM checks WHERE id=$1', [Number(id)]); if (!c) return;
  await resolveCheckAlert(c.server_id, c.id); await db().exec('DELETE FROM metrics WHERE server_id=$1 AND name=$2', [c.server_id, `chk:${c.id}`]); await db().exec('DELETE FROM checks WHERE id=$1', [c.id]); await audit('pengguna', 'check.hapus', c.name);
}

export async function discover(serverId: number | string) {
  const s = await Servers.get(serverId); if (!s) throw bad('Server tidak ada');
  const r = await Servers.run(s, Checks.DISCOVER, { timeoutMs: 25_000 });
  if (r.exitCode !== 0 && !r.stdout.trim()) throw bad('Gagal membaca server: ' + (r.stderr || 'tanpa keluaran').trim().split('\n').slice(-1)[0]!.slice(0, 200));
  const found = Checks.suggest(r.stdout), out: Record<string, unknown> = {};
  for (const k of Object.keys(found)) out[k] = { label: Checks.PACKS[k]!.label, opts: found[k], fields: Checks.PACKS[k]!.fields, hint: Checks.PACKS[k]!.hint };
  for (const p of detectCustom(r.stdout, await customPacks())) out[p.id] = { label: p.label, opts: {}, fields: [], hint: `Standar buatan sendiri untuk unit ${p.unit}` };
  return out;
}

export async function runChecks(s: Servers.ServerRow): Promise<{ created: Cond[]; results: Array<{ id: number; name: string; status: string; value: number | null; detail: string }> }> {
  const checks = await db().query('SELECT * FROM checks WHERE server_id=$1 AND enabled ORDER BY id', [s.id]), out = { created: [] as Cond[], results: [] as Array<{ id: number; name: string; status: string; value: number | null; detail: string }> };
  if (!checks.length) return out;
  const r = await Servers.run(s, Checks.batchScript(checks as never), { timeoutMs: 20_000 + checks.length * 15_000 });
  if (r.exitCode === 255 && !r.stdout.trim()) return out;   // server tidak terjangkau: sudah ditangani pemeriksaan resource
  const parsed = Checks.parseBatch(r.stdout), now = Date.now(), conds: Cond[] = [], overrides = await loadOverrides(), catalog = await catalogMap();
  for (const raw of checks as any[]) {
    const eff = effective(raw, overrides, catalog), c: any = { ...raw, minor: eff.minor, warn: eff.warn, crit: eff.crit, confirm: eff.confirm };   // ambang dan konfirmasi dari standar global bila pemeriksaan berasal dari paket
    const res = parsed[String(c.id)] ?? { exitCode: 255, stdout: '', stderr: 'tidak ada hasil (skrip terpotong?)', timedOut: false }, ev = Checks.evaluate(c as never, res);
    const bad_ = ev.status !== 'ok', fails = bad_ ? c.fail_count + 1 : 0, level: Level = ev.status === 'crit' ? 'critical' : ev.status === 'warn' ? 'major' : 'minor', on = bad_ && fails >= (c.confirm || 1);
    await db().exec('UPDATE checks SET last_status=$1, last_value=$2, last_raw=COALESCE($3, last_raw), last_detail=$4, last_run=$5, fail_count=$6 WHERE id=$7', [ev.status, ev.value, ev.raw, ev.detail || '', now, fails, c.id]);
    if (ev.value != null) await db().exec('INSERT INTO metrics(server_id,ts,name,value) VALUES($1,$2,$3,$4)', [s.id, now, `chk:${c.id}`, ev.value]);
    conds.push({ key: `chk:${c.id}`, on, level, title: c.name, detail: ev.detail || ev.status });
    out.results.push({ id: c.id, name: c.name, status: ev.status, value: ev.value, detail: ev.detail });
  }
  out.created = await syncAlerts(s.id, conds, 'service'); return out;
}

// ---------- penjadwal (satu pemimpin saja lewat kunci advisory): pekerjaan di dalam aplikasi saja (pengingat, ringkasan, pengawas agen, cek HTTP), tanpa menghubungi server
const LEADER_KEY = 727_002;
let timer: NodeJS.Timeout | null = null, leader: pg.Client | null = null, lastPurge = 0, ticking = false;

async function becomeLeader(): Promise<boolean> {
  if (leader) return true;
  const c = new pg.Client({ connectionString: ctx().cfg.DATABASE_URL, application_name: 'aiops-leader', ssl: ctx().cfg.DB_SSL === 'require' ? { rejectUnauthorized: true } : undefined });
  try {
    c.on('error', () => { if (leader === c) leader = null; });
    await c.connect(); const r = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_KEY]);
    if (r.rows[0]?.ok) { leader = c; log().info('instance ini menjadi pemimpin penjadwal'); return true; }
    await c.end(); return false;
  } catch { try { await c.end(); } catch { /* abaikan */ } return false; }
}
async function tick(): Promise<void> {
  if (ticking) return; ticking = true;
  try {
    if (!(await becomeLeader())) return;
    const now = Date.now();   // tidak ada pengambilan data berkala ke server; kondisi datang dari agen dan dari pemeriksaan manual
    await Notify.reminders(); await Notify.releaseDeferred();
    for (const h of hooks) { try { await h(); } catch (e) { log().warn({ err: (e as Error).message }, 'hook penjadwal gagal'); } }
    if (now - lastPurge > 6 * 3600e3) { lastPurge = now; await maintenance(now); }
  } catch (e) { log().error({ err: (e as Error).message }, 'tick penjadwal gagal'); } finally { ticking = false; }
}
async function maintenance(now: number): Promise<void> {
  await db().exec('DELETE FROM metrics WHERE ts<$1', [now - 14 * 864e5]); await db().exec('DELETE FROM notifications WHERE ts<$1', [now - 90 * 864e5]);
  await db().exec('DELETE FROM audit WHERE ts<$1', [now - 365 * 864e5]); await db().exec('DELETE FROM sessions WHERE expires_at<$1', [now]);
  await db().exec('DELETE FROM alerts WHERE resolved AND ts<$1', [now - 90 * 864e5]);
}
const hooks: Array<() => Promise<void>> = [];
/** daftarkan pekerjaan berkala tambahan (dipanggil tiap 10 detik oleh pemimpin penjadwal) */
export function onTick(fn: () => Promise<void>): void { hooks.push(fn); }
export function start(): void { if (!timer) { timer = setInterval(() => void tick(), 10_000); timer.unref(); setTimeout(() => void tick(), 1500).unref(); } }
export async function stop(): Promise<void> { if (timer) { clearInterval(timer); timer = null; } if (leader) { const c = leader; leader = null; try { await c.end(); } catch { /* abaikan */ } } }
