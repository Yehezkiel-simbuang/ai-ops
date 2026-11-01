// Inventaris: daftar server terdokumentasi, vault kredensial, dan jadwal pemeliharaan.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q } from '@/api/queries';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Note, PageHead, Tabs } from '@/components/ui/Layout';
import { IconLayers, IconPlus } from '@/components/icons';
import { useDebounced } from '@/lib/useDebounced';
import { CredentialDialog } from './CredentialDialog';
import { VaultGrid } from './InventoryGrids';
import { MaintenanceBody } from './MaintenancePage';
import { ServerGrid } from './ServerGrid';

type Tab = 'server' | 'vault' | 'maint';

function VaultTab({ search }: { search: string }) {
  const [creating, setCreating] = useState(false), query = useQuery(q.vault(search));
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <Note>Semua kredensial dari semua server. Password terenkripsi; melihatnya butuh konfirmasi password akun dan tercatat di audit.</Note>
        <div className="grow" />
        <Button primary icon={IconPlus} onClick={() => setCreating(true)}>Kredensial umum baru</Button>
      </div>
      <Async query={query}>{(rows) => <VaultGrid rows={rows} searching={!!search} />}</Async>
      <CredentialDialog open={creating} onClose={() => setCreating(false)} serverId={null} />
    </>
  );
}

export function InventoryPage() {
  const [tab, setTab] = useState<Tab>('server'), [search, setSearch] = useState('');
  const ov = useQuery(q.overview()).data, due = { overdue: ov?.maintenance.overdue ?? 0, rotation: ov?.rotationDue ?? 0 };
  const term = useDebounced(search), servers = useQuery(q.inventory({ q: term, env: '' }));   // pencarian teks di server; filter lanjutan, urutan, dan halaman di tabel
  return (
    <>
      <PageHead title="Inventaris" icon={IconLayers}><Badge tone="acc" href="/api/inventory.csv" download="inventaris-server.csv">Ekspor CSV</Badge></PageHead>
      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" aria-label="Cari" placeholder="Cari: nama, IP, username, fungsi, port, tag, pemilik..." style={{ maxWidth: 420, width: '100%' }} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'server', label: 'Server' }, { id: 'vault', label: due.rotation ? `Vault kredensial (${due.rotation})` : 'Vault kredensial' }, { id: 'maint', label: due.overdue ? `Pemeliharaan (${due.overdue} terlambat)` : 'Pemeliharaan' }]} />
      {tab === 'server' && <Async query={servers}>{(rows) => <ServerGrid rows={rows} searching={!!term} />}</Async>}
      {tab === 'vault' && <VaultTab search={term} />}
      {tab === 'maint' && <MaintenanceBody search={term} />}
    </>
  );
}
