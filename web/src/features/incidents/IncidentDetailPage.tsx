import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { q } from '@/api/queries';
import type { IncidentDetail } from '@/api/types';
import { IncidentBadge, RecStatusBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Empty, Item, List, PageHead } from '@/components/ui/Layout';
import { IconFlame } from '@/components/icons';
import { ago } from '@/lib/format';
import { RecommendationView } from './RecommendationView';

function Body({ d }: { d: IncidentDetail }) {
  const inc = d.incident, [rec, ...older] = d.recommendations;
  return (
    <>
      <div className="lbl" style={{ margin: '-8px 0 14px' }}>
        {inc.server_name} | {inc.detail} | dibuka {ago(inc.opened)}{inc.resolved_at ? ` | pulih ${ago(inc.resolved_at)}` : ''} | {inc.event_count} kejadian dari agen
      </div>
      {!!inc.diag?.length && (
        <details style={{ marginBottom: 16 }}>
          <summary>Data diagnostik dari agen saat insiden mulai ({inc.diag.length} bagian, sudah disamarkan)</summary>
          <div className="body">{inc.diag.map((x) => <div key={x.name}><div className="lbl">{x.name}</div><pre className="out">{x.out}</pre></div>)}</div>
        </details>
      )}
      {rec ? <RecommendationView key={rec.id} incident={inc} rec={rec} path={d.path} /> : <Empty>Menyusun rekomendasi...</Empty>}
      {older.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary>Rekomendasi sebelumnya ({older.length})</summary>
          <div className="body"><List>{older.map((r) => (
            <Item key={r.id} title={`#${r.id} (${r.source === 'llm' ? 'model' : 'playbook'})`} sub={[r.diagnosis.slice(0, 160)]}><RecStatusBadge status={r.status} /></Item>
          ))}</List></div>
        </details>
      )}
    </>
  );
}

export function IncidentDetailPage() {
  const id = Number(useParams().id), query = useQuery(q.incident(id));
  const inc = query.data?.incident;
  return (
    <>
      <PageHead title={inc?.title ?? 'Insiden'} icon={IconFlame}>
        {inc && <IncidentBadge status={inc.status} severity={inc.severity} />}
        <Badge tone="acc" to="/insiden">Semua insiden</Badge>
      </PageHead>
      <Async query={query}>{(d) => <Body d={d} />}</Async>
    </>
  );
}
