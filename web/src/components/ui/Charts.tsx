// Grafik ringan berbasis SVG/CSS (tanpa pustaka grafik).
import type { ReactNode } from 'react';
import type { SeriesPoint } from '@/api/types';

const W = 300, H = 56;

/** Kotak metrik dengan garis mini. `warnAt` ikut menentukan skala sumbu Y. */
export function Spark({ label, unit, series, warnAt = 0, format = String }: { label: string; unit: string; series: SeriesPoint[]; warnAt?: number; format?: (v: number) => string }) {
  const values = series.map((p) => p.value), last = values.length ? values[values.length - 1]! : null;
  const max = Math.max(1e-9, ...values, warnAt);
  const pts = series.map((p, i) => `${series.length > 1 ? (i / (series.length - 1)) * W : W / 2},${H - 3 - (p.value / max) * (H - 8)}`);
  return (
    <div className="spark">
      <div className="top"><span>{label}</span><b>{last == null ? '-' : `${format(last)}${unit}`}</b></div>
      {pts.length > 1 ? (
        <svg className="mini" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
          <polygon className="area" points={`0,${H} ${pts.join(' ')} ${W},${H}`} />
          <polyline points={pts.join(' ')} />
        </svg>
      ) : <div className="lbl" style={{ padding: '14px 0' }}>Belum cukup data</div>}
      <div className="lbl">{values.length ? `min ${Math.min(...values)} | maks ${Math.max(...values)} | ${values.length} sampel` : ''}</div>
    </div>
  );
}

export interface DayBar { day: string; input: number; output: number }

/** Batang harian bertumpuk: token masuk (bawah) dan keluar (atas). */
export function DayBars({ days, label }: { days: DayBar[]; label: string }) {
  const max = Math.max(1, ...days.map((d) => d.input + d.output));
  return (
    <div className="daybars" role="img" aria-label={label}>
      {days.map((d) => (
        <div key={d.day} className="col" title={`${d.day}: ${d.input} masuk, ${d.output} keluar`}>
          <i style={{ height: `${(d.output / max) * 100}%`, background: 'var(--c-out)' }} />
          <i style={{ height: `${(d.input / max) * 100}%`, background: 'var(--c-in)' }} />
        </div>
      ))}
    </div>
  );
}

export const Key = ({ color, children }: { color: string; children: ReactNode }) => <span className="key"><i style={{ background: color }} />{children}</span>;

/** Bilah progres tersegmentasi (selesai / berjalan / gagal) dari total. */
export function Progress({ total, done, running, failed }: { total: number; done: number; running: number; failed: number }) {
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div style={{ width: pct(done), background: 'var(--ok)' }} />
      <div style={{ width: pct(running), background: 'var(--accent)' }} />
      <div style={{ width: pct(failed), background: 'var(--bad)' }} />
    </div>
  );
}
