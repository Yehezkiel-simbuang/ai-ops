// Penilaian hasil eksperimen terhadap kondisi awal, dalam kalimat yang bisa langsung dibaca.
import type { LabRun, LabSummary } from './types';

type Key = 'fastPct' | 'okPct' | 'e504' | 'eConn' | 'p95' | 'throughput' | 'outageSeconds' | 'degradedSeconds';

export type Better = 'higher' | 'lower';
export interface MetricRow { key: keyof LabSummary; label: string; better: Better; unit: string; digits: number; base: number; exp: number; delta: number; verdict: 'better' | 'worse' | 'same' }

const METRICS: Array<{ key: Key; label: string; better: Better; unit: string; digits: number; onlyWithFailure?: boolean }> = [
  { key: 'fastPct', label: 'Selesai dalam 2 detik', better: 'higher', unit: '%', digits: 1 },
  { key: 'okPct', label: 'Berhasil', better: 'higher', unit: '%', digits: 1 },
  { key: 'e504', label: 'Error 504 (timeout)', better: 'lower', unit: '', digits: 0 },
  { key: 'eConn', label: 'Error koneksi database', better: 'lower', unit: '', digits: 0 },
  { key: 'p95', label: 'Waktu respons p95', better: 'lower', unit: ' dtk', digits: 2 },
  { key: 'throughput', label: 'Request sampai ke server', better: 'higher', unit: '/dtk', digits: 1 },
  { key: 'outageSeconds', label: 'Detik layanan mati total', better: 'lower', unit: ' dtk', digits: 0, onlyWithFailure: true },
  { key: 'degradedSeconds', label: 'Detik layanan terganggu', better: 'lower', unit: ' dtk', digits: 0, onlyWithFailure: true }
];

export function compareRuns(base: LabSummary, exp: LabSummary, withFailure = false): MetricRow[] {
  return METRICS.filter((m) => withFailure || !m.onlyWithFailure).map((m) => {
    const b = base[m.key], e = exp[m.key], delta = e - b, tol = m.key === 'p95' ? 0.05 : m.key === 'throughput' ? Math.max(1, b * 0.05) : m.digits === 0 ? 0 : 0.2;
    const good = m.better === 'higher' ? delta : -delta;
    return { ...m, base: b, exp: e, delta, verdict: Math.abs(delta) <= tol ? 'same' : good > 0 ? 'better' : 'worse' };
  });
}

export interface Verdict { tone: 'ok' | 'warn' | 'bad' | 'mute'; title: string; text: string }

/** Dengan skenario kegagalan, yang dinilai adalah ketahanan: berapa lama layanan mati dan data yang berisiko hilang. */
function resilienceVerdict(base: LabRun, exp: LabRun, hasChanges: boolean): Verdict | null {
  if (!exp.failure || exp.failure.skipped) return null;
  const b = base.summary, e = exp.summary, gained = b.outageSeconds - e.outageSeconds;
  const ha = e.ha[0], risk = ha ? (ha.sync ? ' Replikasi sinkron: tidak ada transaksi yang hilang.' : ` Replikasi asinkron: sekitar ${ha.rpoTx} transaksi terakhir berisiko hilang saat failover.`) : '';
  const facts = `Layanan mati ${e.outageSeconds} dtk dan terganggu ${e.degradedSeconds} dtk (sebelumnya ${b.outageSeconds} dtk dan ${b.degradedSeconds} dtk); ketersediaan ${e.okPct.toFixed(1)}% (sebelumnya ${b.okPct.toFixed(1)}%).${risk}`;
  if (gained >= 5) return { tone: 'ok', title: `Lebih tahan: mati ${gained} dtk lebih singkat`, text: facts };
  if (-gained >= 5) return { tone: 'bad', title: `Lebih rentan: mati ${-gained} dtk lebih lama`, text: facts };
  if (!hasChanges) return { tone: 'warn', title: `${exp.failure.label} mati: layanan terganggu ${b.outageSeconds} dtk`, text: 'Tanpa cadangan, komponen itu adalah titik kegagalan tunggal. Tambahkan load balancer (untuk aplikasi) atau Database HA (untuk database) lalu bandingkan.' };
  return { tone: 'warn', title: 'Ketahanan tidak berubah', text: 'Komponen yang dimatikan belum punya cadangan. ' + facts };
}

/** Kesimpulan satu kalimat + saran. Dengan skenario kegagalan yang dinilai adalah ketahanan; selain itu metrik utama (request cepat), lalu peringatan bila ada leher botol baru. */
export function verdictOf(base: LabRun, exp: LabRun, hasChanges: boolean): Verdict {
  const resilience = resilienceVerdict(base, exp, hasChanges);
  if (resilience) return resilience;
  if (!hasChanges) return { tone: 'mute', title: 'Belum ada perubahan', text: 'Tambahkan komponen atau terapkan rekomendasi untuk melihat bedanya dengan kondisi sekarang.' };
  const d = exp.summary.fastPct - base.summary.fastPct, e504 = exp.summary.e504 - base.summary.e504;
  const last = exp.frames.length ? exp.diags[exp.frames[exp.frames.length - 1]!.diag] : undefined;
  const tail = last && last.lv >= 2 ? ` Leher botol berikutnya: ${last.title.replace(/^Bottleneck: /, '')}.` : '';
  if (d >= 5) return { tone: 'ok', title: `Lebih baik: +${d.toFixed(1)} poin request cepat`, text: `Dari ${base.summary.fastPct.toFixed(1)}% menjadi ${exp.summary.fastPct.toFixed(1)}%, error 504 ${e504 <= 0 ? 'turun' : 'naik'} ${Math.abs(e504)}.${tail}` };
  if (d <= -5) return { tone: 'bad', title: `Lebih buruk: ${d.toFixed(1)} poin request cepat`, text: `Perubahan ini justru membuat sistem lebih lambat pada beban ini.${tail}` };
  const sameAndHealthy = base.summary.fastPct >= 95;
  return { tone: 'warn', title: 'Hampir tidak ada bedanya', text: sameAndHealthy ? 'Kondisi awal sudah sehat pada beban ini. Naikkan beban atau aktifkan gangguan untuk melihat nilai perubahannya.' : `Perubahan ini tidak menyentuh leher botolnya.${tail}` };
}
