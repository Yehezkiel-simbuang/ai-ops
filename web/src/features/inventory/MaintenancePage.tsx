// Pemeliharaan: tugas berulang yang harus dikerjakan (jadwal, pembaruan sistem, rencana patch). Dipakai sebagai halaman sendiri dan sebagai tab Inventaris.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q } from '@/api/queries';
import { Async } from '@/components/ui/Async';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Empty, Note, PageHead, Tile, Tiles } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconPlus, IconTimer } from '@/components/icons';
import { MaintenanceGrid } from './InventoryGrids';
import { TaskForm, TemplatePicker } from './MaintenanceList';
import { PatchingPanel } from './PatchingPanel';
import { PatchPlansPanel } from './PatchPlansPanel';

/** Tugas baru dari mana saja: pilih server dulu, lalu isi tugas sendiri atau ambil dari templat standar. */
export function NewTaskAnywhere({ open, onClose }: { open: boolean; onClose: () => void }) {
  const servers = useQuery(q.servers()), [picked, setPicked] = useState(''), list = servers.data ?? [], serverId = Number(picked || list[0]?.id || 0);
  return (
    <Modal open={open} onClose={onClose}>
      {!serverId ? <Empty>Belum ada server. Tambahkan server dulu di halaman Server.</Empty> : (
        <>
          <Field label="Untuk server"><select value={serverId} onChange={(e) => setPicked(e.target.value)} aria-label="Untuk server">{list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <TaskForm key={serverId} serverId={serverId} onClose={onClose} />
          <TemplatePicker serverId={serverId} />
        </>
      )}
    </Modal>
  );
}

export function MaintenanceBody({ search = '' }: { search?: string }) {
  const query = useQuery(q.maintenance()), needle = search.toLowerCase(), [creating, setCreating] = useState(false);
  return (
    <>
      <Async query={query}>{(all) => {
        const n = (s: string) => all.filter((t) => t.status === s).length;
        return (
          <>
            <Tiles><Tile value={n('terlambat')} label="Terlambat" /><Tile value={n('segera')} label="Segera (7 hari)" /><Tile value={n('ok')} label="Aman" /></Tiles>
            <div className="row" style={{ margin: '10px 0' }}><Button primary icon={IconPlus} onClick={() => setCreating(true)}>Tugas baru</Button></div>
            {!all.length && <Empty>Belum ada tugas pemeliharaan. Tekan <b>Tugas baru</b>, lalu pilih server dan ambil dari templat standar (mis. cek backup, rotasi log, pembaruan sistem) atau isi sendiri.</Empty>}
          </>
        );
      }}</Async>
      <PatchingPanel />
      <PatchPlansPanel />
      <Async query={query}>{(rows) => rows.length ? <MaintenanceGrid rows={rows.filter((t) => !needle || `${t.title} ${t.server_name ?? ''}`.toLowerCase().includes(needle))} searching={!!needle} /> : null}</Async>
      <NewTaskAnywhere open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function MaintenancePage() {
  return (
    <>
      <PageHead title="Pemeliharaan" icon={IconTimer} />
      <Note>Tugas berulang yang harus Anda kerjakan: jadwal perawatan, pembaruan sistem, dan rencana patch. Yang terlambat dihitung di menu dan di judul tab.</Note>
      <MaintenanceBody />
    </>
  );
}
