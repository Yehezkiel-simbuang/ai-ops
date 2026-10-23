// Ringkasan seluruh server untuk halaman Ringkasan: satu vonis dan urutan server dari yang paling bermasalah. Murni dan bisa diuji.
import type { Alert, Overview } from '@/api/types';
import type { Verdict } from '@/components/VerdictBanner';

type OverviewServer = Overview['servers'][number];

const STATUS_RANK: Record<string, number> = { 'tidak terjangkau': 0, peringatan: 1, belum: 2, ok: 3 };

export const serverRank = (s: Pick<OverviewServer, 'status' | 'open_alerts'>): number => (s.status === 'ok' && s.open_alerts > 0 ? 1 : STATUS_RANK[s.status] ?? 2);

/** Yang paling bermasalah di atas; sama berat: peringatan terbanyak, lalu nama. */
export const sortServers = (servers: OverviewServer[]): OverviewServer[] =>
  [...servers].sort((a, b) => serverRank(a) - serverRank(b) || b.open_alerts - a.open_alerts || a.name.localeCompare(b.name, 'id', { numeric: true }));

/** Kritis dulu, lalu yang terbaru. */
export const sortAlerts = (alerts: Alert[]): Alert[] => [...alerts].sort((a, b) => Number(b.level === 'kritis') - Number(a.level === 'kritis') || b.ts - a.ts);

export interface Fleet { verdict: Verdict; headline: string; detail: string; counts: { sehat: number; peringatan: number; down: number; belum: number }; needsYou: number }

export function fleet(o: Overview): Fleet {
  const counts = { sehat: 0, peringatan: 0, down: 0, belum: 0 };
  for (const s of o.servers) { const r = serverRank(s); if (r === 0) counts.down++; else if (r === 1) counts.peringatan++; else if (r === 2) counts.belum++; else counts.sehat++; }
  const crit = o.alerts.filter((a) => a.level === 'kritis').length + o.incidents.length, needsYou = o.pending.length + o.incidents.length + (o.maintenance.overdue > 0 ? 1 : 0);
  const parts = [counts.sehat && `${counts.sehat} sehat`, counts.peringatan && `${counts.peringatan} perlu perhatian`, counts.down && `${counts.down} tidak terjangkau`, counts.belum && `${counts.belum} belum ada data`].filter(Boolean).join(', ');
  const more = o.pending.length ? ` ${o.pending.length} perintah menunggu persetujuan Anda.` : '';
  if (!o.servers.length) return { verdict: 'nodata', headline: 'Belum ada server', detail: 'Tambahkan server pertama untuk mulai memantau.', counts, needsYou };
  if (counts.down) return { verdict: 'down', headline: `${counts.down} server tidak terjangkau`, detail: `${parts}.${more}`, counts, needsYou };
  if (crit) return { verdict: 'crit', headline: 'Ada masalah kritis', detail: `${parts}.${more}`, counts, needsYou };
  if (counts.peringatan || o.alerts.length) return { verdict: 'warn', headline: 'Perlu perhatian', detail: `${parts}.${more}`, counts, needsYou };
  if (counts.belum === o.servers.length) return { verdict: 'nodata', headline: 'Belum ada data', detail: `Server belum diperiksa. Buka Monitor lalu tekan "Periksa sekarang".${more}`, counts, needsYou };
  return { verdict: 'ok', headline: 'Semua server sehat', detail: `${parts}.${more}`, counts, needsYou };
}
