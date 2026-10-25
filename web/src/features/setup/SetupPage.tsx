import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q } from '@/api/queries';
import type { Run } from '@/api/types';
import { RunStatusBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Button } from '@/components/ui/Button';
import { Empty, Item, List, PageHead } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconHistory, IconPlus, IconWrench } from '@/components/icons';
import { ago, fmt } from '@/lib/format';
import { NewRunForm } from './NewRunDialog';

function RunList({ runs }: { runs: Run[] }) {
  if (!runs.length) return <Empty>Belum ada proses.</Empty>;
  return (
    <List>{runs.map((r) => {
      const done = r.steps.filter((s) => s.status === 'done').length;
      return <Item key={r.id} to={`/setup/${r.id}`} title={r.name} sub={[`${r.server_name ?? 'tanpa server'} | ${ago(r.updated)} | ${fmt(r.tokens)} token${r.steps.length ? ` | langkah ${done}/${r.steps.length}` : ''}`]}><RunStatusBadge status={r.status} /></Item>;
    })}</List>
  );
}

export function SetupPage() {
  const runs = useQuery(q.runs()), servers = useQuery(q.servers()), templates = useQuery(q.runTemplates()), [open, setOpen] = useState(false);
  return (
    <>
      <PageHead title="Setup server" icon={IconWrench}><Button primary icon={IconPlus} onClick={() => setOpen(true)}>Proses baru</Button></PageHead>
      <h2><IconHistory size={16} aria-hidden />Riwayat</h2>
      <Async query={runs}>{(r) => <RunList runs={r} />}</Async>
      <Modal wide open={open} onClose={() => setOpen(false)}>
        {servers.data && templates.data ? <NewRunForm servers={servers.data} templates={templates.data} onClose={() => setOpen(false)} /> : <Empty>Memuat...</Empty>}
      </Modal>
    </>
  );
}
