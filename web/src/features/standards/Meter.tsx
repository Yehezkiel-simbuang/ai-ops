// Garis ukur: zona aman (hijau), peringatan (kuning), kritis (merah) menurut ambang, ditambah rentang nilai yang pernah terukur
// (min sampai maks, dengan penanda p95) dan nilai sekarang. Teks di bawahnya memuat angka yang sama untuk pembaca layar.
export interface Stat { count: number; min: number; max: number; avg: number; p95: number }

export const fmtNum = (n: number): string => (Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100));

/** Zona [mulai, akhir, warna] sepanjang 0..skala, menurut arah bahaya. */
export function zones(dir: 'gt' | 'lt', warn: number | null, crit: number | null, scale: number): Array<[number, number, 'ok' | 'warn' | 'bad']> {
  const clamp = (v: number) => Math.min(Math.max(v, 0), scale);
  if (warn == null && crit == null) return [[0, scale, 'ok']];
  if (dir === 'gt') {
    const w = clamp(warn ?? crit!), c = crit == null ? scale : clamp(crit);
    return [[0, w, 'ok'], [w, Math.max(w, c), 'warn'], [Math.max(w, c), scale, 'bad']];
  }
  const w = clamp(warn ?? crit!), c = crit == null ? 0 : clamp(crit);
  return [[0, Math.min(w, c), 'bad'], [Math.min(w, c), w, 'warn'], [w, scale, 'ok']];
}

/** Panjang skala yang memuat ambang, rentang terukur, dan nilai sekarang dengan sedikit ruang. */
export function scaleOf(warn: number | null, crit: number | null, stat: Stat | null, value: number | null): number {
  const top = Math.max(warn ?? 0, crit ?? 0, stat?.max ?? 0, value ?? 0);
  return top > 0 ? top * 1.15 : 1;
}

export function Meter({ dir, warn, crit, stat, value, unit }: { dir: 'gt' | 'lt'; warn: number | null; crit: number | null; stat: Stat | null; value: number | null; unit: string }) {
  const scale = scaleOf(warn, crit, stat, value), pct = (v: number) => `${Math.min(Math.max((v / scale) * 100, 0), 100)}%`;
  return (
    <div className="meter" role="group" aria-label="Posisi nilai terhadap ambang">
      <div className="meter-track">
        {zones(dir, warn, crit, scale).map(([a, b, tone], i) => b > a && <i key={i} className={`z ${tone}`} style={{ left: pct(a), width: `${((b - a) / scale) * 100}%` }} />)}
        {stat && <i className="range" style={{ left: pct(stat.min), width: `${Math.max(((stat.max - stat.min) / scale) * 100, 0.6)}%` }} title="rentang 7 hari" />}
        {stat && <i className="p95" style={{ left: pct(stat.p95) }} title={`p95 ${fmtNum(stat.p95)}`} />}
        {value !== null && <i className="now" style={{ left: pct(value) }} title={`sekarang ${fmtNum(value)}`} />}
      </div>
      <div className="lbl">
        {stat ? `7 hari: min ${fmtNum(stat.min)}, rata-rata ${fmtNum(stat.avg)}, p95 ${fmtNum(stat.p95)}, maks ${fmtNum(stat.max)} ${unit} (${stat.count} sampel)` : 'Belum ada data 7 hari'}
        {value !== null && ` | sekarang ${fmtNum(value)} ${unit}`}
      </div>
    </div>
  );
}
