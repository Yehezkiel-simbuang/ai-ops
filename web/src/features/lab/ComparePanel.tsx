// Perbandingan kondisi awal vs eksperimen: kesimpulan, tabel metrik dengan selisih, rincian per jenis request, dan pemakaian tiap node.
import { DataTable } from '@/components/ui/DataTable';
import type { LabRun } from './types';
import { compareRuns, verdictOf } from './verdict';

const sign = (n: number, digits: number) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
const nodeLabel = (run: LabRun, id: string) => run.arch.nodes.find((n) => n.id === id)?.label ?? id;

export function ComparePanel({ base, exp, hasChanges }: { base: LabRun; exp: LabRun; hasChanges: boolean }) {
  const v = verdictOf(base, exp, hasChanges), withFailure = !!exp.failure && !exp.failure.skipped, rows = compareRuns(base.summary, exp.summary, withFailure);
  const perIds = Object.keys(exp.summary.per);
  const busy = Object.entries(exp.nodes).sort((a, b) => b[1].avgU - a[1].avgU).slice(0, 6);
  return (
    <div className="stack">
      <div className={`verdict ${v.tone}`} role="status"><b>{v.title}</b><p>{v.text}</p></div>
      <DataTable textCols={1} heads={['Metrik', 'Awal', 'Eksperimen', 'Selisih']} empty="" rows={rows.map((r) => [
        r.label, `${r.base.toFixed(r.digits)}${r.unit}`, `${r.exp.toFixed(r.digits)}${r.unit}`,
        <span key={r.key} className={`delta ${r.verdict}`}>{sign(r.delta, r.digits)}{r.unit}</span>
      ])} />
      <details>
        <summary>Per jenis request</summary>
        <div className="body">
          <DataTable textCols={1} heads={['Request', '≤ 2 dtk awal', '≤ 2 dtk eksp.', 'p95 awal', 'p95 eksp.']} empty="Tidak ada."
            rows={perIds.map((id) => { const b = base.summary.per[id], e = exp.summary.per[id]!; return [e.label ?? id, b ? `${b.fastPct.toFixed(0)}%` : '-', `${e.fastPct.toFixed(0)}%`, b ? `${b.p95.toFixed(2)}` : '-', e.p95.toFixed(2)]; })} />
        </div>
      </details>
      <details>
        <summary>Pemakaian tiap komponen (rata-rata setelah pemanasan)</summary>
        <div className="body">
          <DataTable textCols={1} heads={['Komponen', 'Rata-rata', 'Puncak', 'Antrean maks.']} empty="Tidak ada."
            rows={busy.map(([id, n]) => [nodeLabel(exp, id), `${Math.round(n.avgU * 100)}%`, `${Math.round(n.maxU * 100)}%`, String(n.maxQ)])} />
        </div>
      </details>
    </div>
  );
}
