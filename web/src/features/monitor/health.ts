// Ringkasan kondisi satu server untuk halaman Monitor: satu vonis, dan masalah yang dikelompokkan menurut tingkatnya.
// Critical dan Major = perlu ditangani; Minor = lihat kalau sempat; Info = hanya jejak. Murni dan bisa diuji.
import type { Alert, Check, Level, MonitorView } from '@/api/types';
import type { Verdict } from '@/components/VerdictBanner';
import { RANK, isLevel, levelOfStatus } from '@/lib/levels';

export type { Verdict };

export interface Problem {
  id: string; kind: 'down' | 'alert' | 'check'; level: Level; title: string; detail: string; ts: number | null;
  /** Hanya untuk peringatan: id yang dipakai tombol "Tandai dilihat" bila belum dilihat. */
  alertId?: number; acked?: boolean;
  /** Pemeriksaan yang sudah gagal tetapi belum melewati konfirmasi, jadi belum jadi peringatan. */
  unconfirmed?: boolean;
}

export interface Summary {
  verdict: Verdict; headline: string; detail: string;
  /** Critical dan Major, paling parah dulu. */
  urgent: Problem[]; minor: Problem[]; info: Problem[];
  counts: { crit: number; major: number; minor: number; ok: number; off: number };
  /** Peringatan yang sudah selesai, untuk riwayat. */
  history: Alert[];
}

const order = (a: Problem, b: Problem): number => RANK[b.level] - RANK[a.level] || Number(!!a.unconfirmed) - Number(!!b.unconfirmed) || Number(!!a.acked) - Number(!!b.acked) || (b.ts ?? 0) - (a.ts ?? 0);

export function summarize(d: MonitorView): Summary {
  const s = d.server, down = s.last_status === 'tidak terjangkau', active = d.alerts.filter((a) => !a.resolved), history = d.alerts.filter((a) => a.resolved);
  const all: Problem[] = [];
  if (down) all.push({ id: 'down', kind: 'down', level: 'critical', title: 'Server tidak terjangkau', detail: 'Aplikasi tidak bisa masuk lewat SSH pada pemeriksaan terakhir. Metrik di bawah bisa sudah lama.', ts: s.last_seen });
  for (const a of active) all.push({ id: `a${a.id}`, kind: 'alert', level: isLevel(a.level) ? a.level : 'major', title: a.title, detail: a.detail, ts: a.ts, alertId: a.id, acked: a.acked });
  const covered = new Set(active.map((a) => a.title));
  for (const c of d.checks) {
    const level = c.enabled ? levelOfStatus(c.last_status) : null;
    if (!level || covered.has(c.name)) continue;   // yang sudah jadi peringatan tidak ditampilkan dua kali
    all.push({ id: `c${c.id}`, kind: 'check', level, title: c.name, detail: c.last_detail || 'tidak terbaca', ts: c.last_run, unconfirmed: true });
  }
  const urgent = all.filter((p) => RANK[p.level] >= RANK.major).sort(order), minor = all.filter((p) => p.level === 'minor').sort(order), info = all.filter((p) => p.level === 'info').sort(order);

  const enabled = d.checks.filter((c: Check) => c.enabled), count = (st: string) => enabled.filter((c) => c.last_status === st).length;
  const counts = { crit: count('crit'), major: count('warn'), minor: count('minor') + count('unknown'), ok: count('ok'), off: d.checks.length - enabled.length };
  const critical = urgent.filter((p) => p.level === 'critical').length, major = urgent.length - critical, hasData = d.series.load5.length > 0 || enabled.some((c) => c.last_run);

  let verdict: Verdict = 'ok', headline = 'Sehat', detail = minor.length ? `Tidak ada yang mendesak. ${minor.length} Minor bisa dilihat kalau sempat.` : 'Tidak ada peringatan aktif dan semua pemeriksaan normal.';
  if (down) { verdict = 'down'; headline = 'Tidak terjangkau'; detail = 'Server tidak menjawab SSH. Periksa jaringan, firewall, atau apakah server menyala.'; }
  else if (critical > 0) { verdict = 'crit'; headline = 'Critical'; detail = `${critical} Critical${major ? ` dan ${major} Major` : ''} perlu ditangani.`; }
  else if (major > 0) { verdict = 'warn'; headline = 'Perlu perhatian'; detail = `${major} Major hari ini, belum ada yang Critical.`; }
  else if (!hasData) { verdict = 'nodata'; headline = 'Belum ada data'; detail = 'Aktifkan pemantauan lalu tekan "Periksa sekarang", atau tunggu satu putaran pemeriksaan.'; }
  return { verdict, headline, detail, urgent, minor, info, counts, history };
}

/** Pemeriksaan yang sedang tidak normal (Critical, Major, Minor, atau tidak terbaca). */
export const isProblem = (c: Pick<Check, 'enabled' | 'last_status'>): boolean => c.enabled && levelOfStatus(c.last_status) !== null;
