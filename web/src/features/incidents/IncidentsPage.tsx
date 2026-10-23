import { useQuery } from '@tanstack/react-query';
import { q } from '@/api/queries';
import type { Incident } from '@/api/types';
import { IncidentBadge, RecStatusBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Empty, Item, List, Note, PageHead, Section } from '@/components/ui/Layout';
import { IconAlert, IconFlame, IconHistory } from '@/components/icons';
import { ago } from '@/lib/format';

export function IncidentRow({ i }: { i: Incident }) {
  return (
    <Item to={`/insiden/${i.id}`} title={i.title} sub={[`${i.server_name} | ${i.detail} | ${ago(i.opened)}${i.event_count > 1 ? ` | ${i.event_count} kejadian` : ''}`]}>
      <RecStatusBadge status={i.rec_status} />
      <IncidentBadge status={i.status} />
    </Item>
  );
}

export function IncidentsPage() {
  const open = useQuery(q.incidents('open')), resolved = useQuery(q.incidents('resolved'));
  return (
    <>
      <PageHead title="Insiden" icon={IconFlame} />
      <Note>Hanya kondisi kritis yang dikirim agen. Tiap insiden mendapat rekomendasi; tidak ada yang dijalankan sebelum Anda menyetujuinya.</Note>
      <h2 style={{ marginTop: 16 }}><IconAlert size={16} aria-hidden />Terbuka</h2>
      <Async query={open}>{(rows) => rows.length ? <List>{rows.map((i) => <IncidentRow key={i.id} i={i} />)}</List> : <Empty>Tidak ada insiden kritis. Semua tenang.</Empty>}</Async>
      <Section title="Sudah pulih (terbaru)" icon={IconHistory}>
        <Async query={resolved}>{(rows) => rows.length ? <List>{rows.slice(0, 15).map((i) => <IncidentRow key={i.id} i={i} />)}</List> : <Empty>Belum ada.</Empty>}</Async>
      </Section>
    </>
  );
}
