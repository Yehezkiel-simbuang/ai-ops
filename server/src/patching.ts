// Pembaruan sistem: agen MELAPORKAN fakta (jumlah pembaruan, reboot tertunda, versi OS), aplikasi yang MENILAI menurut halaman Standar.
// Hasilnya dua hal: peringatan per server (lewat syncAlerts) dan daftar "server mana yang perlu dipelihara" untuk halaman Pemeliharaan.
import { z } from 'zod';
import { bad, db, log } from './context.js';
import { RANK, type Level } from './levels.js';
import { syncAlerts, type Cond } from './monitor.js';
import { AGENT_LIMITS, loadOverrides, type Override } from './standards.js';
import * as Vulns from './vulns.js';

const DAY = 864e5;
const STALE_MS = 2 * DAY;   // agen melapor tiap 6 jam; lebih dari 2 hari tanpa laporan = datanya tidak bisa dipercaya

export const patchBody = z.object({
  manager: z.string().max(20).optional(), updates: z.number().int().min(0).max(100000).nullish(), security: z.number().int().min(0).max(100000).nullish(),
  reboot: z.boolean().optional(), reboot_since: z.number().int().min(0).optional(),
  os_id: z.string().max(40).optional(), os_version: z.string().max(40).optional(), os_name: z.string().max(100).optional(), kernel: z.string().max(80).optional(),
  packages: z.array(z.object({ name: z.string().max(100), source: z.string().max(100).optional(), old: z.string().max(100), new: z.string().max(100), sec: z.boolean(), official: z.boolean().optional() })).max(400).optional()
});
export type PatchFacts = z.infer<typeof patchBody>;

// ---------- akhir masa dukungan OS. Daftar ditulis tangan dan akan basi: periksa lagi tiap beberapa bulan. OS yang tidak ada di sini = tidak dinilai.
const END = (y: number, m: number): number => Date.UTC(y, m, 0);   // hari terakhir bulan m (1-12)
const EOL: Record<string, number> = {
  'ubuntu:16.04': END(2021, 4), 'ubuntu:18.04': END(2023, 5), 'ubuntu:20.04': END(2025, 5), 'ubuntu:22.04': END(2027, 6), 'ubuntu:24.04': END(2029, 6),
  'debian:9': END(2022, 6), 'debian:10': END(2024, 6), 'debian:11': END(2026, 8), 'debian:12': END(2028, 6), 'debian:13': END(2030, 6),
  'centos:7': END(2024, 6), 'centos:8': END(2021, 12), 'rhel:7': END(2024, 6), 'rhel:8': END(2029, 5), 'rhel:9': END(2032, 5),
  'rocky:8': END(2029, 5), 'rocky:9': END(2032, 5), 'almalinux:8': END(2029, 5), 'almalinux:9': END(2032, 5)
};
/** Ubuntu memakai versi penuh (22.04); distro lain versi utama saja (12, 8.9 -> 8). */
export function eolOf(osId: string | undefined, version: string | undefined): number | null {
  const id = (osId ?? '').toLowerCase(), v = version ?? '';
  return EOL[`${id}:${id === 'ubuntu' ? v : v.split('.')[0]}`] ?? null;
}

// ---------- batas dari halaman Standar (kunci agent:patch_*, agent:reboot_days, agent:eol_days)
type Lim = { minor: number | null; warn: number | null; crit: number | null };
const limitOf = (k: string, o: Map<string, Override>): Lim => { const b = AGENT_LIMITS[k]!, ov = o.get(`agent:${k}`); return ov ? { minor: ov.minor, warn: ov.warn, crit: ov.crit } : { minor: b.minor, warn: b.warn, crit: b.crit }; };
/** Sama dengan pemeriksaan lain: batas dilewati bila nilai LEBIH dari (gt) atau KURANG dari (lt) batas itu. */
const levelFor = (v: number, l: Lim, dir: 'gt' | 'lt'): Level | null => {
  const hit = (t: number | null) => t != null && (dir === 'lt' ? v < t : v > t);
  return hit(l.crit) ? 'critical' : hit(l.warn) ? 'major' : hit(l.minor) ? 'minor' : null;
};

export interface Finding { key: string; level: Level; title: string; detail: string }
/** Semua temuan dari satu laporan fakta. Kunci tetap ada walau tidak bermasalah (level null) supaya peringatan lama bisa ditutup. */
export function assess(f: PatchFacts, o: Map<string, Override>, now = Date.now(), vulns: Vulns.VulnReport | null = null): Array<Finding | { key: string; level: null }> {
  const out: Array<Finding | { key: string; level: null }> = [];
  const put = (key: string, level: Level | null, title: string, detail: string) => out.push(level ? { key, level, title, detail } : { key, level: null });
  if (f.security != null) put('patch:security', levelFor(f.security, limitOf('patch_security', o), 'gt'), 'Pembaruan keamanan belum dipasang', `${f.security} paket dengan pembaruan keamanan menunggu`);
  if (f.updates != null) put('patch:updates', levelFor(f.updates, limitOf('patch_updates', o), 'gt'), 'Pembaruan paket menumpuk', `${f.updates} paket bisa diperbarui`);
  if (f.reboot) {
    const days = f.reboot_since ? Math.floor((now - f.reboot_since * 1000) / DAY) : 0;
    put('patch:reboot', levelFor(days, limitOf('reboot_days', o), 'gt'), 'Server menunggu reboot', `reboot diminta ${days <= 0 ? 'hari ini' : `${days} hari lalu`} (kernel atau pustaka sudah diperbarui, belum dipakai)`);
  } else put('patch:reboot', null, '', '');
  const hot = (vulns?.pkgs ?? []).filter((p) => p.exploited.length);
  if (hot.length) put('patch:exploited', 'critical', 'Patch untuk kerentanan yang sedang dieksploitasi', `${[...new Set(hot.flatMap((p) => p.exploited))].length} CVE di daftar CISA KEV akan ditutup patch ini: ${hot.slice(0, 4).map((p) => `${p.name} (${p.exploited.slice(0, 3).join(', ')})`).join('; ')}${hot.length > 4 ? ` dan ${hot.length - 4} paket lain` : ''}`);
  else put('patch:exploited', null, '', '');
  const eol = eolOf(f.os_id, f.os_version);
  if (eol != null) {
    const days = Math.floor((eol - now) / DAY);
    put('patch:eol', levelFor(days, limitOf('eol_days', o), 'lt'), 'Masa dukungan OS', days < 0 ? `${f.os_name || f.os_id} sudah berakhir dukungannya ${-days} hari lalu; tidak ada lagi pembaruan keamanan` : `dukungan ${f.os_name || f.os_id} berakhir ${days} hari lagi`);
  } else put('patch:eol', null, '', '');   // OS tidak dikenal (atau diganti): tutup peringatan lama
  return out;
}

/** Simpan laporan agen dan sesuaikan peringatannya. */
export async function report(serverId: number, f: PatchFacts, now = Date.now()): Promise<void> {
  await db().exec('UPDATE agents SET patch=$1::jsonb, patch_ts=$2 WHERE server_id=$3', [JSON.stringify(f), now, serverId]);
  const prev = await db().one<{ patch_vulns: Vulns.VulnReport | null }>('SELECT patch_vulns FROM agents WHERE server_id=$1', [serverId]);
  const conds: Array<Cond | { key: string; on: false }> = assess(f, await loadOverrides(), now, prev?.patch_vulns ?? null).map((x) => (x.level ? { key: x.key, on: true, level: x.level, title: x.title, detail: x.detail } : { key: x.key, on: false }));
  await syncAlerts(serverId, conds, 'agent');
  enrichLater(serverId, now);
}

// ---------- kerentanan (OSV.dev dan CISA KEV): berjalan di latar belakang karena bisa memakan waktu dan tidak boleh menahan agen
const pending = new Set<Promise<void>>();
function enrichLater(serverId: number, now: number): void {
  const p: Promise<void> = enrich(serverId, now).catch((e) => log().warn({ err: (e as Error).message, serverId }, 'pencocokan kerentanan gagal')).finally(() => { pending.delete(p); });
  pending.add(p);
}
/** Untuk uji: tunggu semua pencocokan latar belakang selesai. */
export const settled = async (): Promise<void> => { while (pending.size) await Promise.all([...pending]); };

/** Cocokkan paket yang akan naik ke OSV dan KEV, simpan hasilnya, lalu sesuaikan peringatan "dieksploitasi". */
export async function enrich(serverId: number, now = Date.now()): Promise<void> {
  const row = await db().one<{ patch: PatchFacts | null }>('SELECT patch FROM agents WHERE server_id=$1', [serverId]), f = row?.patch;
  if (!f) return;
  const rep = await Vulns.assessPackages(f.os_id, f.os_version, f.packages ?? [], now);
  await db().exec('UPDATE agents SET patch_vulns=$1::jsonb, patch_vulns_ts=$2 WHERE server_id=$3', [JSON.stringify(rep), now, serverId]);
  const hot = assess(f, await loadOverrides(), now, rep).find((x) => x.key === 'patch:exploited')!;
  await syncAlerts(serverId, [hot.level ? { key: hot.key, on: true, level: hot.level, title: (hot as Finding).title, detail: (hot as Finding).detail } : { key: hot.key, on: false }], 'agent');
}

// ---------- daftar untuk halaman Pemeliharaan
export interface PatchRow {
  server_id: number; name: string; os: string; kernel: string; reported: number | null; stale: boolean;
  updates: number | null; security: number | null; reboot: boolean; reboot_days: number | null; eol_days: number | null;
  /** CVE unik yang ditutup patch (null = belum dicocokkan atau distro belum didukung), berapa yang sedang dieksploitasi, dan paket yang sumbernya tidak terjangkau. */
  cves: number | null; exploited: number; vuln_unknown: number;
  /** Waktu patch terakhir selesai diterapkan bila LEBIH BARU daripada laporan agen: daftar ini belum mencerminkannya. */
  patched_at: number | null;
  level: Level | null; reasons: Array<{ level: Level; text: string }>;
}
/** Server yang agennya melapor, yang paling perlu perhatian di atas. Dihitung dari fakta tersimpan dan batas Standar saat ini. */
export async function overview(now = Date.now()): Promise<{ rows: PatchRow[]; without_agent: number }> {
  const o = await loadOverrides();
  const all = await db().query<{ server_id: number; name: string; patch: PatchFacts | null; patch_ts: number | null; patch_vulns: Vulns.VulnReport | null }>('SELECT s.id AS server_id, s.name, a.patch, a.patch_ts, a.patch_vulns FROM servers s LEFT JOIN agents a ON a.server_id=s.id ORDER BY s.name');
  const patched = new Map((await db().query<{ server_id: number; t: number }>("SELECT server_id, max(updated) AS t FROM recommendations WHERE kind='patch' AND status='done' GROUP BY server_id")).map((x) => [x.server_id, Number(x.t)]));
  const rows: PatchRow[] = [];
  for (const r of all) {
    if (!r.patch) continue;
    const f = r.patch, stale = !r.patch_ts || now - r.patch_ts > STALE_MS, vr = r.patch_vulns && r.patch_vulns.pkgs.length ? r.patch_vulns : null, found = assess(f, o, now, r.patch_vulns).filter((x): x is Finding => x.level !== null);
    const eol = eolOf(f.os_id, f.os_version);
    rows.push({
      patched_at: (patched.get(r.server_id) ?? 0) > (r.patch_ts ?? 0) ? patched.get(r.server_id)! : null, server_id: r.server_id, name: r.name, os: f.os_name || [f.os_id, f.os_version].filter(Boolean).join(' '), kernel: f.kernel ?? '', reported: r.patch_ts, stale,
      updates: f.updates ?? null, security: f.security ?? null, reboot: !!f.reboot, reboot_days: f.reboot && f.reboot_since ? Math.floor((now - f.reboot_since * 1000) / DAY) : null, eol_days: eol == null ? null : Math.floor((eol - now) / DAY),
      cves: vr ? new Set(vr.pkgs.flatMap((p) => p.cves)).size : null, exploited: vr ? new Set(vr.pkgs.flatMap((p) => p.exploited)).size : 0, vuln_unknown: vr ? vr.pkgs.filter((p) => p.unknown || p.external).length : 0,
      level: found.reduce<Level | null>((m, x) => (m === null || RANK[x.level] > RANK[m] ? x.level : m), null), reasons: found.sort((a, b) => RANK[b.level] - RANK[a.level]).map((x) => ({ level: x.level, text: x.detail }))
    });
  }
  rows.sort((a, b) => (b.level ? RANK[b.level] : 0) - (a.level ? RANK[a.level] : 0) || (b.security ?? 0) - (a.security ?? 0) || a.name.localeCompare(b.name));
  return { rows, without_agent: all.filter((r) => !r.patch).length };
}

/** Rincian satu server: paket yang akan naik beserta CVE yang ditutup (bila sudah dicocokkan). */
export async function detail(serverId: number) {
  const r = await db().one<{ name: string; patch: PatchFacts | null; patch_ts: number | null; patch_vulns: Vulns.VulnReport | null; patch_vulns_ts: number | null }>('SELECT s.name, a.patch, a.patch_ts, a.patch_vulns, a.patch_vulns_ts FROM servers s LEFT JOIN agents a ON a.server_id=s.id WHERE s.id=$1', [serverId]);
  if (!r) throw bad('Server tidak ada');
  const f = r.patch, matched = r.patch_vulns, eco = f ? Vulns.ecosystemOf(f.os_id, f.os_version) : null;
  const byName = new Map((matched?.pkgs ?? []).map((p) => [p.name, p]));
  const pkgs = (f?.packages ?? []).map((p) => byName.get(p.name) ?? { ...p, cves: [], ids: [], exploited: [], unknown: false, external: p.official === false });
  pkgs.sort((a, b) => b.exploited.length - a.exploited.length || Number(b.sec) - Number(a.sec) || b.cves.length - a.cves.length || a.name.localeCompare(b.name));
  const plan = await db().one<{ id: number; status: string; created: number }>("SELECT id, status, created FROM recommendations WHERE kind='patch' AND server_id=$1 AND status IN ('proposed','approved','executing','failed') ORDER BY id DESC LIMIT 1", [serverId]);   // rencana terakhir yang masih relevan, supaya pengguna tidak membuat yang kembar
  const done = await db().one<{ t: number | null }>("SELECT max(updated) AS t FROM recommendations WHERE kind='patch' AND status='done' AND server_id=$1", [serverId]);
  return { patched_at: done?.t && Number(done.t) > (r.patch_ts ?? 0) ? Number(done.t) : null, plan: plan ?? null, name: r.name, os: f ? f.os_name || [f.os_id, f.os_version].filter(Boolean).join(' ') : '', reported: r.patch_ts, ecosystem: eco, supported: eco !== null, matched_at: r.patch_vulns_ts, kev_at: matched?.kev_at ?? null, total: f?.packages?.length ?? 0, packages: pkgs };
}

/** Minta agen melapor fakta pembaruan pada detak jantung berikutnya. Agen versi lama mengabaikan permintaan ini; perbarui agennya. */
export async function requestRefresh(serverId: number): Promise<{ ok: true; online: boolean }> {
  const a = await db().one<{ online: boolean }>('SELECT online FROM agents WHERE server_id=$1', [serverId]);
  if (!a) throw bad('Server ini belum punya agen');
  await db().exec("INSERT INTO meta(key,value) VALUES($1,'1') ON CONFLICT(key) DO UPDATE SET value='1'", [`patch_refresh_${serverId}`]);
  return { ok: true, online: !!a.online };
}
