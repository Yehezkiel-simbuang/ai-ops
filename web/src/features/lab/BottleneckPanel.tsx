// Potensi bottleneck: temuan dari kode/konfigurasi (dengan bukti) dan urutan komponen yang jenuh lebih dulu.
// Sengaja TIDAK meramal angka request/detik: yang ditampilkan adalah LOKASI leher botol dan seberapa konsisten ia muncul saat asumsi divariasikan.
import { useAction } from '@/api/queries';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Empty, Hint, Note } from '@/components/ui/Layout';
import { IconAlert, IconBolt, IconInfo } from '@/components/icons';
import { post } from '@/lib/api';
import { totalRps } from './scenario';
import type { BottleneckAnalysis, LabBottlenecks, LabProject, LabRec, Scenario } from './types';

const SEVERITY: Record<LabRec['severity'], Tone> = { tinggi: 'bad', sedang: 'warn', rendah: 'mute' };

export const analysisKey = (s: Scenario): string => JSON.stringify([s.actions, s.estimates ?? [], s.load]);

/** node -> peringkat (1 = jenuh paling dulu), untuk penanda di diagram. */
export const ranksOf = (a: BottleneckAnalysis | undefined): Record<string, number> => Object.fromEntries((a?.ranking ?? []).slice(0, 3).map((r, i) => [r.node, i + 1]));

function Findings({ recs }: { recs: LabRec[] }) {
  if (!recs.length) return <Empty>Tidak ada temuan dari kode atau konfigurasi untuk arsitektur ini.</Empty>;
  return (
    <div className="stack">
      {recs.map((r) => (
        <details key={r.id}>
          <summary>{r.title} <Badge tone={SEVERITY[r.severity]}>{r.severity}</Badge>{r.optional && <> <Badge>opsional</Badge></>}</summary>
          <div className="body">
            {r.why.length > 0 && <ul className="lbl" style={{ margin: 0, paddingLeft: '1.1em' }}>{r.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}
            {r.expected && <p className="note"><b>Dampak:</b> {r.expected}</p>}
          </div>
        </details>
      ))}
    </div>
  );
}

function Ranking({ title, a, base }: { title: string; a: BottleneckAnalysis; base: number }) {
  return (
    <div className="rank-col">
      <h3>{title}</h3>
      {a.ranking.length === 0 ? (
        <Empty>Tidak ada yang jenuh sampai {a.multiples[a.multiples.length - 1]}× beban dasar ({a.variations} variasi asumsi).</Empty>
      ) : a.ranking.map((r, i) => (
        <div className="rank" key={r.node}>
          <div className="row"><b>#{i + 1} {r.label}</b><div className="grow" /><span className="lbl">{r.count} dari {a.variations} variasi</span></div>
          <div className="rankbar" role="img" aria-label={`${Math.round(r.share * 100)}% variasi`}><i style={{ width: `${r.share * 100}%` }} /></div>
          <div className="lbl">Mulai jenuh sekitar <b>{r.medianMultiple}×</b> beban dasar (≈ {Math.round(base * r.medianMultiple)} req/dtk bila beban dasar benar)</div>
          <div className="lbl"><b>{r.title.replace(/^Bottleneck: /, '')}.</b> {r.text}</div>
        </div>
      ))}
      {!a.complete && <Note>Dihentikan lebih awal oleh batas waktu: {a.variations} dari {a.planned} variasi.</Note>}
    </div>
  );
}

interface Props { project: LabProject; scenario: Scenario; analysis: { key: string; data: LabBottlenecks } | null; onResult: (key: string, data: LabBottlenecks) => void }

export function BottleneckPanel({ project, scenario, analysis, onResult }: Props) {
  const key = analysisKey(scenario), current = analysis?.key === key ? analysis.data : null, stale = !!analysis && !current;
  const run = useAction(() => post<LabBottlenecks>('/api/lab/bottlenecks', { project: project.id, actions: scenario.actions, estimates: scenario.estimates ?? [], load: scenario.load }), { onSuccess: (data) => onResult(key, data) });
  const base = totalRps(scenario.load);
  return (
    <div className="stack">
      <Note>Bukan ramalan RPM. Beban dinaikkan bertahap dari beban dasar (2×, 4×, 8×, ...) dan dicatat <b>komponen mana yang jenuh lebih dulu</b>. Karena lama tiap panggilan dan CPU per request biasanya hanya perkiraan, analisis diulang dengan nilai itu divariasikan 0,5× sampai 2×; makin sering sebuah komponen muncul pertama, makin bisa dipercaya.</Note>
      <h3>Temuan dari kode dan konfigurasi</h3>
      <Findings recs={project.recs} />
      <div className="row" style={{ marginTop: 6 }}>
        <h3>Urutan kejenuhan</h3><div className="grow" />
        <Button primary icon={IconBolt} onClick={() => run.mutateAsync()}>{current ? 'Hitung ulang' : 'Cari leher botol'}</Button>
      </div>
      {stale && <Hint icon={IconAlert}>Skenario atau beban berubah sejak analisis terakhir. Jalankan lagi agar hasilnya sesuai.</Hint>}
      {current && (
        <>
          <div className="rank-grid"><Ranking title="Kondisi sekarang" a={current.baseline} base={base} /><Ranking title="Eksperimen" a={current.experiment} base={base} /></div>
          <Hint icon={IconInfo}><span>Beban dasar = beban yang sedang disetel (≈ {Math.round(base)} req/dtk, <b>bukan hasil ukur</b>). Yang divariasikan: {current.experiment.varied.join('; ')}. Nilai yang terukur tidak diubah. Tanpa gangguan; lihat gangguan di simulasi di atas.</span></Hint>
        </>
      )}
    </div>
  );
}
