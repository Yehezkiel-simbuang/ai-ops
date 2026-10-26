// Di mana bottleneck-nya: kesimpulan, temuan berperingkat dengan bukti dan saran, dan pemakaian tiap komponen per tahap.
import { Badge, type Tone } from '@/components/ui/Badge';
import { Hint } from '@/components/ui/Layout';
import { IconAlert } from '@/components/icons';
import { ROLE_LABEL } from './ArchitectureView';
import type { BottleneckReport, Confidence, UsageRow } from './types';

const CONF: Record<Confidence, [Tone, string]> = { terukur: ['bad', 'Terukur'], kuat: ['warn', 'Kuat'], dugaan: ['mute', 'Dugaan'] };
const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`);
const heat = (v: number | null): string => (v === null ? 'heat' : v >= 0.85 ? 'heat bad' : v >= 0.6 ? 'heat warn' : 'heat ok');
const roleName = (u: UsageRow): string => (u.role === 'host' ? 'Server uji (keseluruhan)' : ROLE_LABEL[u.role]);

function UsageTable({ usage }: { usage: UsageRow[] }) {
  if (!usage.length) return null;
  const stages = usage[0]!.stages;
  return (
    <div className="tbl-wrap"><table className="tbl cards" aria-label="Pemakaian per komponen">
      <thead><tr><th>Komponen</th>{stages.map((s) => <th key={s.idx}>Tahap {s.idx + 1} <span className="lbl">({s.vus})</span></th>)}</tr></thead>
      <tbody>{usage.map((u) => (
        <tr key={u.service}>
          <td data-label="Komponen"><strong>{u.service === '_host' ? 'server uji' : u.service}</strong><div className="lbl">{roleName(u)}</div></td>
          {u.stages.map((s) => { const top = s.cpu === null && s.mem === null ? null : Math.max(s.cpu ?? 0, s.mem ?? 0); return (
            <td key={s.idx} data-label={`Tahap ${s.idx + 1} (${s.vus} pengguna)`} className={heat(top)} title={`CPU ${pct(s.cpu)}, memori ${pct(s.mem)}`}>{pct(top)}</td>); })}
        </tr>))}</tbody>
    </table></div>
  );
}

export function BottleneckPanel({ report }: { report: BottleneckReport }) {
  const worst = report.findings[0]?.confidence, tone = !report.findings.length ? 'ok' : worst === 'terukur' ? 'bad' : 'warn';
  return (
    <div className="stack">
      <div className={`verdict ${tone}`} role="status">
        <b>{report.headline}</b>
        <p><Badge tone={report.basis === 'terukur' ? 'ok' : 'mute'}>{report.basis === 'terukur' ? 'berdasar pemakaian terukur per komponen' : 'perkiraan dari kurva hasil'}</Badge>{report.stageIdx !== null && <span className="lbl"> dianalisis pada tahap {report.stageIdx + 1}</span>}</p>
      </div>
      {report.cautions.map((c) => <Hint key={c} icon={IconAlert}><span>{c}</span></Hint>)}
      {report.findings.map((f, i) => { const [ctone, clabel] = CONF[f.confidence]; return (
        <article key={`${f.component}-${i}`} className="finding">
          <div className="row"><b>{i + 1}. {f.title}</b><Badge tone={ctone}>{clabel}</Badge>{f.role !== 'tidak diketahui' && f.role !== 'generator' && f.role !== 'host' && <Badge tone="mute">{ROLE_LABEL[f.role]}</Badge>}</div>
          <ul className="lbl">{f.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
          {f.advice.length > 0 && <div><span className="lbl">Yang bisa dilakukan:</span><ul>{f.advice.map((a) => <li key={a}>{a}</li>)}</ul></div>}
        </article>); })}
      {report.usage.length > 0 && <><h3>Pemakaian per komponen</h3><p className="lbl" style={{ margin: 0 }}>Angka tertinggi antara CPU dan memori terhadap batas komponen (atau kapasitas server bila tanpa batas). Merah mulai 85%, kuning mulai 60%.</p><UsageTable usage={report.usage} /></>}
      {report.basis === 'perkiraan' && <p className="lbl">Pemakaian per komponen hanya dicatat untuk uji yang dijalankan dari susunan Playground.</p>}
    </div>
  );
}
