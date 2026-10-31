import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { q } from '@/api/queries';
import type { Incident } from '@/api/types';
import { IncidentBadge, LevelBadge, RecStatusBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Empty, Item, List, Note, PageHead, Section } from '@/components/ui/Layout';
import { IconAlert, IconBook, IconFlame, IconHistory } from '@/components/icons';
import { ago } from '@/lib/format';

const PAGE = 15;

/** Terbuka: bergaris warna menurut tingkat dan tebal; pulih: diredam, dengan tingkat aslinya tetap terlihat. */
export function IncidentRow({ i }: { i: Incident & { has_notes?: boolean } }) {
  const open = i.status === 'open';
  return (
    <Item to={`/insiden/${i.id}`} accent={open ? (i.severity ?? 'critical') : 'done'} title={i.title}
      sub={[`${i.server_name} | ${i.detail} | ${open ? `terbuka ${ago(i.opened)}` : `pulih ${ago(i.resolved_at ?? i.opened)}`}${i.event_count > 1 ? ` | ${i.event_count} kejadian` : ''}`]}>
      {i.has_notes && <Badge tone="acc" icon={IconBook}>ada catatan</Badge>}
      {open && <RecStatusBadge status={i.rec_status} />}
      {open ? <IncidentBadge status="open" severity={i.severity} /> : <><LevelBadge level={i.severity ?? 'critical'} /><IncidentBadge status="resolved" /></>}
    </Item>
  );
}

function ResolvedList() {
  const [offset, setOffset] = useState(0), [text, setText] = useState(''), [search, setSearch] = useState('');
  useEffect(() => { const t = setTimeout(() => { setSearch(text.trim()); setOffset(0); }, 300); return () => clearTimeout(t); }, [text]);
  const query = useQuery(q.incidentsPage('resolved', offset, PAGE, search));
  return (
    <>
      <input type="search" aria-label="Cari insiden pulih" placeholder="Cari judul, server, penyebab, atau penyelesaian" value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', maxWidth: 420, marginBottom: 10 }} />
      <Async query={query}>{({ rows, total }) => rows.length ? (
        <>
          <List>{rows.map((i) => <IncidentRow key={i.id} i={i} />)}</List>
          <div className="pager">
            <span className="lbl">Menampilkan {offset + 1} sampai {offset + rows.length} dari {total}</span>
            <span className="row">
              <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Sebelumnya</Button>
              <Button disabled={offset + rows.length >= total} onClick={() => setOffset(offset + PAGE)}>Berikutnya</Button>
            </span>
          </div>
        </>
      ) : <Empty>{search ? 'Tidak ada yang cocok.' : 'Belum ada.'}</Empty>}</Async>
    </>
  );
}

export function IncidentsPage() {
  const open = useQuery(q.incidentsPage('open', 0, 100, ''));
  const n = open.data?.total;
  return (
    <>
      <PageHead title="Insiden" icon={IconFlame} />
      <Note>Agen mengirim kejadian menurut tingkatnya (Critical, Major, Minor, Info). Insiden Major dan Critical mendapat rekomendasi; tidak ada yang dijalankan sebelum Anda menyetujuinya.</Note>
      <h2 style={{ marginTop: 16 }}><IconAlert size={16} aria-hidden />Terbuka{n ? ` (${n})` : ''}</h2>
      <Async query={open}>{({ rows, total }) => rows.length ? (
        <>
          <List>{rows.map((i) => <IncidentRow key={i.id} i={i} />)}</List>
          {total > rows.length && <p className="lbl">Menampilkan {rows.length} yang paling parah dari {total} insiden terbuka.</p>}
        </>
      ) : <Empty>Tidak ada insiden terbuka. Semua tenang.</Empty>}</Async>
      <Section title="Sudah pulih" icon={IconHistory}><ResolvedList /></Section>
    </>
  );
}
