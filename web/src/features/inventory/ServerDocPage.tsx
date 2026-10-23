// Dokumentasi satu server: ringkasan/ubah, kredensial, pemeliharaan.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import type { FactsResult, ServerProfile } from '@/api/types';
import { EnvBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHead, Tabs, Note } from '@/components/ui/Layout';
import { IconLayers, IconPlus, IconRefresh, IconTimer, IconWrench } from '@/components/icons';
import { post } from '@/lib/api';
import { dateStr } from '@/lib/format';
import { toast } from '@/lib/toast';
import { CredentialDialog } from './CredentialDialog';
import { CredentialList } from './CredentialList';
import { NewTaskDialog, TaskList, TemplatePicker } from './MaintenanceList';
import { ProfileForm } from './ProfileForm';
import { ServerSummary } from './ServerSummary';

type Tab = 'ringkasan' | 'kredensial' | 'pemeliharaan';

function CredentialsTab({ id }: { id: number }) {
  const [creating, setCreating] = useState(false), query = useQuery(q.serverCredentials(id));
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <Note>Password terenkripsi AES-256-GCM. "Ungkap" butuh konfirmasi password akun dan tercatat di audit. Aplikasi tidak mengubah password di server; Anda yang menerapkannya.</Note>
        <div className="grow" />
        <Button primary icon={IconPlus} onClick={() => setCreating(true)}>Tambah kredensial</Button>
      </div>
      <Async query={query}>{(rows) => <CredentialList credentials={rows} empty="Belum ada kredensial untuk server ini." />}</Async>
      <CredentialDialog open={creating} onClose={() => setCreating(false)} serverId={id} />
    </>
  );
}

function MaintenanceTab({ id }: { id: number }) {
  const [adding, setAdding] = useState(false), tasks = useQuery(q.serverTasks(id)), log = useQuery(q.serverTaskLog(id));
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}><IconTimer size={16} aria-hidden />Jadwal</h2><div className="grow" /><Button primary icon={IconPlus} onClick={() => setAdding(true)}>Tambah tugas</Button></div>
      <Async query={tasks}>{(rows) => <TaskList tasks={rows} empty="Belum ada jadwal. Tambahkan dari templat standar di bawah." />}</Async>
      <TemplatePicker serverId={id} />
      <h2 className="mt"><IconLayers size={16} aria-hidden />Riwayat pemeliharaan</h2>
      <Async query={log}>{(rows) => rows.length
        ? <div className="list">{rows.slice(0, 20).map((l) => <div className="item" key={l.id}><div className="meta"><b>{l.title}</b><span>{dateStr(l.done_at)}{l.done_by ? ` oleh ${l.done_by}` : ''}{l.notes ? ` | ${l.notes}` : ''}</span></div></div>)}</div>
        : <div className="empty">Belum ada riwayat.</div>}
      </Async>
      <NewTaskDialog serverId={id} open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function Body({ id, p }: { id: number; p: ServerProfile }) {
  const [tab, setTab] = useState<Tab>('ringkasan'), [editing, setEditing] = useState(false), servers = useQuery(q.servers());
  const s = p.server;
  const facts = useAction(() => { toast('Membaca server lewat SSH...'); return post<FactsResult>(`/api/servers/${id}/facts`); }, {
    invalidate: [['servers', id, 'profile'], ['inventory']],
    success: (r) => `Fakta diperbarui${r.suggestions.addresses.length ? `; ada ${r.suggestions.addresses.length} IP baru yang bisa didokumentasikan` : ''}`
  });
  const overdue = p.counts.overdue ? `, ${p.counts.overdue} terlambat` : '';
  return (
    <>
      <PageHead title={s.name} icon={IconLayers}>
        <EnvBadge env={s.environment} />
        <Badge tone="acc" href={`/api/servers/${id}/export.md`} download={`${s.name}.md`}>Ekspor dokumen (.md, tanpa rahasia)</Badge>
        <Button icon={IconRefresh} onClick={() => facts.mutateAsync()}>Isi otomatis dari server</Button>
        <Button icon={IconWrench} onClick={() => setEditing((e) => !e)}>{editing ? 'Batal ubah' : 'Ubah dokumentasi'}</Button>
        <Badge tone="acc" to="/inventaris">Semua server</Badge>
      </PageHead>
      <div className="lbl" style={{ margin: '-8px 0 12px' }}>{s.purpose || 'Belum ada deskripsi fungsi.'}</div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'ringkasan', label: 'Ringkasan' }, { id: 'kredensial', label: `Kredensial (${p.counts.credentials})` }, { id: 'pemeliharaan', label: `Pemeliharaan (${p.counts.tasks}${overdue})` }
      ]} />
      {tab === 'ringkasan' && (editing && servers.data ? <ProfileForm profile={p} servers={servers.data} onSaved={() => setEditing(false)} /> : <ServerSummary p={p} />)}
      {tab === 'kredensial' && <CredentialsTab id={id} />}
      {tab === 'pemeliharaan' && <MaintenanceTab id={id} />}
    </>
  );
}

export function ServerDocPage() {
  const id = Number(useParams().id), query = useQuery(q.profile(id));
  return <Async query={query}>{(p) => <Body key={id} id={id} p={p} />}</Async>;
}

