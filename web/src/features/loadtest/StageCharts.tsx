// Grafik hasil per tahap: waktu respons p95 (dengan garis batas kriteria) dan throughput, sumbu X = jumlah pengguna tiap tahap.
import type { LoadCriteria, StageResult } from './types';

const W = 360, H = 150, L = 44, R = 10, T = 12, B = 28;

interface Props { stages: StageResult[]; criteria: LoadCriteria; kneeVus?: number | null }

function scaleX(n: number) { return (i: number) => L + (n <= 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R)); }

export function P95Chart({ stages, criteria, kneeVus }: Props) {
  const x = scaleX(stages.length), max = Math.max(criteria.p95Ms * 1.4, ...stages.map((s) => s.p95), 1);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const pts = stages.map((s, i) => `${x(i).toFixed(1)},${y(s.p95).toFixed(1)}`).join(' ');
  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Waktu respons p95 per tahap" style={{ height: 150 }}>
      <line className="grid" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
      <line x1={L} x2={W - R} y1={y(criteria.p95Ms)} y2={y(criteria.p95Ms)} stroke="var(--bad)" strokeDasharray="4 3" strokeWidth={1} />
      <text x={2} y={y(criteria.p95Ms) + 3} fill="var(--bad)">{criteria.p95Ms}ms</text><text x={2} y={y(0)}>0</text><text x={2} y={T + 8}>{Math.round(max)}</text>
      {stages.length > 1 && <polyline className="s-exp" points={pts} />}
      {stages.map((s, i) => <g key={s.idx}><circle cx={x(i)} cy={y(s.p95)} r={3.5} fill={s.p95 > criteria.p95Ms ? 'var(--bad)' : 'var(--accent)'} /><text x={x(i)} y={H - 10} textAnchor="middle">{s.vus}</text></g>)}
      {kneeVus != null && stages.findIndex((s) => s.vus === kneeVus) >= 0 && <line className="cursor" x1={x(stages.findIndex((s) => s.vus === kneeVus))} x2={x(stages.findIndex((s) => s.vus === kneeVus))} y1={T} y2={H - B} />}
    </svg>
  );
}

export function ThroughputChart({ stages }: { stages: StageResult[] }) {
  const n = Math.max(stages.length, 1), max = Math.max(...stages.map((s) => s.rps), 1), bw = Math.min(46, (W - L - R) / n - 8);
  const x = (i: number) => L + ((i + 0.5) / n) * (W - L - R), y = (v: number) => T + (1 - v / max) * (H - T - B);
  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Throughput per tahap" style={{ height: 150 }}>
      <line className="grid" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
      <text x={2} y={y(0)}>0</text><text x={2} y={T + 8}>{Math.round(max)}/dtk</text>
      {stages.map((s, i) => <g key={s.idx}><rect x={x(i) - bw / 2} y={y(s.rps)} width={bw} height={Math.max(1, y(0) - y(s.rps))} fill={s.valid ? 'var(--c-in)' : 'var(--line-strong)'} rx={2} /><text x={x(i)} y={H - 10} textAnchor="middle">{s.vus}</text></g>)}
    </svg>
  );
}
