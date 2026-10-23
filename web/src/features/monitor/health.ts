// Ringkasan kondisi satu server untuk halaman Monitor: satu vonis, dan daftar masalah yang diurutkan dari yang paling mendesak.
// Murni dan bisa diuji; tampilan hanya menampilkan hasilnya.
import type { Alert, Check, MonitorView } from '@/api/types';
import type { Verdict } from '@/components/VerdictBanner';

export type { Verdict };

export interface Problem {
  id: string; kind: 'down' | 'alert' | 'check'; level: 'kritis' | 'peringatan'; title: string; detail: string; ts: number | null;
  /** Hanya untuk peringatan: id yang dipakai tombol "Tandai dilihat" bila belum dilihat. */
  alertId?: number; acked?: boolean;
  /** Pemeriksaan yang sudah gagal tetapi belum melewati konfirmasi, jadi belum jadi peringatan. */
  unconfirmed?: boolean;
}

export interface Summary {
  verdict: Verdict; headline: string; detail: string;
  problems: Problem[]; counts: { crit: number; warn: number; ok: number; off: number };
  /** Peringatan yang sudah selesai atau lama, untuk riwayat. */
  history: Alert[];
}

const RANK = { kritis: 0, peringatan: 1 } as const;

export function summarize(d: MonitorView): Summary {
  const s = d.server, down = s.last_status === 'tidak terjangkau', active = d.alerts.filter((a) => !a.resolved), history = d.alerts.filter((a) => a.resolved);
  const problems: Problem[] = [];
  if (down) problems.push({ id: 'down', kind: 'down', level: 'kritis', title: 'Server tidak terjangkau', detail: 'Aplikasi tidak bisa masuk lewat SSH pada pemeriksaan terakhir. Metrik di bawah bisa sudah lama.', ts: s.last_seen });
  for (const a of active) problems.push({ id: `a${a.id}`, kind: 'alert', level: a.level, title: a.title, detail: a.detail, ts: a.ts, alertId: a.id, acked: a.acked });
  const covered = new Set(active.map((a) => a.title));
  for (const c of d.checks) {
    const bad = c.enabled && (c.last_status === 'crit' || c.last_status === 'warn' || c.last_status === 'unknown');
    if (!bad || covered.has(c.name)) continue;   // yang sudah jadi peringatan tidak ditampilkan dua kali
    problems.push({ id: `c${c.id}`, kind: 'check', level: c.last_status === 'crit' ? 'kritis' : 'peringatan', title: c.name, detail: c.last_detail || 'tidak terbaca', ts: c.last_run, unconfirmed: true });
  }
  problems.sort((a, b) => RANK[a.level] - RANK[b.level] || Number(!!a.unconfirmed) - Number(!!b.unconfirmed) || Number(!!a.acked) - Number(!!b.acked) || (b.ts ?? 0) - (a.ts ?? 0));

  const enabled = d.checks.filter((c: Check) => c.enabled), count = (st: string) => enabled.filter((c) => c.last_status === st).length;
  const counts = { crit: count('crit'), warn: count('warn') + count('unknown'), ok: count('ok'), off: d.checks.length - enabled.length };
  const crit = problems.filter((p) => p.level === 'kritis').length, warn = problems.length - crit, hasData = d.series.load5.length > 0 || enabled.some((c) => c.last_run);

  let verdict: Verdict = 'ok', headline = 'Sehat', detail = 'Tidak ada peringatan aktif dan semua pemeriksaan normal.';
  if (down) { verdict = 'down'; headline = 'Tidak terjangkau'; detail = 'Server tidak menjawab SSH. Periksa jaringan, firewall, atau apakah server menyala.'; }
  else if (crit > 0) { verdict = 'crit'; headline = 'Kritis'; detail = `${crit} masalah kritis${warn ? ` dan ${warn} peringatan` : ''} perlu ditangani.`; }
  else if (warn > 0) { verdict = 'warn'; headline = 'Perlu perhatian'; detail = `${warn} peringatan, belum ada yang kritis.`; }
  else if (!hasData) { verdict = 'nodata'; headline = 'Belum ada data'; detail = 'Aktifkan pemantauan lalu tekan "Periksa sekarang", atau tunggu satu putaran pemeriksaan.'; }
  return { verdict, headline, detail, problems, counts, history };
}

/** Jumlah masalah per kelompok pemeriksaan, untuk menandai kelompok mana yang perlu dibuka. */
export const isProblem = (c: Pick<Check, 'enabled' | 'last_status'>): boolean => c.enabled && (c.last_status === 'crit' || c.last_status === 'warn' || c.last_status === 'unknown');
