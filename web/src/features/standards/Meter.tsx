// Garis ukur: zona aman (hijau), Minor (oranye), Major (kuning), Critical (merah) menurut batas, ditambah rentang nilai yang pernah terukur
// (min sampai maks, dengan penanda p95) dan nilai sekarang. Teks di bawahnya memuat angka yang sama untuk pembaca layar.
export interface Stat { count: number; min: number; max: number; avg: number; p95: number }

export const fmtNum = (n: number): string => (Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100));

export type Zone = [number, number, 'ok' | 'minor' | 'warn' | 'bad'];

/** Zona [mulai, akhir, warna] sepanjang 0..skala, menurut arah bahaya. `warn` = batas Major, `crit` = Critical; `minor` opsional. */
export function zones(dir: 'gt' | 'lt', warn: number | null, crit: number | null, scale: number, minor: number | null = null): Zone[] {
  const clamp = (v: number) => Math.min(Math.max(v, 0), scale);
  if (warn == null && crit == null && minor == null) return [[0, scale, 'ok']];
  const first = warn ?? crit ?? minor!;
  if (dir === 'gt') {
    const m = minor == null ? null : clamp(minor), w = clamp(first), c = crit == null ? scale : clamp(crit), top = Math.max(w, c);
    return [...(m != null && m < w ? [[0, m, 'ok'], [m, w, 'minor']] as Zone[] : [[0, w, 'ok']] as Zone[]), [w, top, 'warn'], [top, scale, 'bad']];
  }
  const m = minor == null ? null : clamp(minor), w = clamp(first), c = crit == null ? 0 : clamp(crit), low = Math.min(w, c);
  return [[0, low, 'bad'], [low, w, 'warn'], ...(m != null && m > w ? [[w, m, 'minor'], [m, scale, 'ok']] as Zone[] : [[w, scale, 'ok']] as Zone[])];
}

/** Panjang skala yang memuat batas, rentang terukur, dan nilai sekarang dengan sedikit ruang. */
export function scaleOf(warn: number | null, crit: number | null, stat: Stat | null, value: number | null, minor: number | null = null): number {
  const top = Math.max(minor ?? 0, warn ?? 0, crit ?? 0, stat?.max ?? 0, value ?? 0);
  return top > 0 ? top * 1.15 : 1;
}

export function Meter({ dir, minor = null, warn, crit, stat, value, unit }: { dir: 'gt' | 'lt'; minor?: number | null; warn: number | null; crit: number | null; stat: Stat | null; value: number | null; unit: string }) {
  const scale = scaleOf(warn, crit, stat, value, minor), pct = (v: number) => `${Math.min(Math.max((v / scale) * 100, 0), 100)}%`;
  return (
    <div className="meter" role="group" aria-label="Posisi nilai terhadap batas">
      <div className="meter-track">
        {zones(dir, warn, crit, scale, minor).map(([a, b, tone], i) => b > a && <i key={i} className={`z ${tone}`} style={{ left: pct(a), width: `${((b - a) / scale) * 100}%` }} />)}
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
