// Semua rencana patch dengan statusnya: Draf (belum disetujui), Berjalan, Selesai, Gagal, Ditolak, Digantikan.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { q } from '@/api/queries';
import type { PatchPlanItem } from '@/api/types';
import { PlanStatusBadge } from '@/components/StatusBadges';
import { DataGrid, type Column } from '@/components/ui/DataGrid';
import { Fold } from '@/components/ui/Fold';
import { ago } from '@/lib/format';

const ORDER: Record<string, number> = { executing: 0, approved: 0, proposed: 1, failed: 2, done: 3, rejected: 4, superseded: 5 };
const progress = (p: PatchPlanItem): string => (p.status === 'proposed' || p.status === 'superseded' || p.status === 'rejected' ? '-' : `${p.steps_done} dari ${p.steps_total} langkah`);

const columns: Array<Column<PatchPlanItem>> = [
  { id: 'status', header: 'Status', sort: (p) => ORDER[p.status] ?? 9, cell: (p) => <PlanStatusBadge status={p.status} /> },
  { id: 'plan', header: 'Rencana', sort: (p) => p.id, cell: (p) => <><Link to={`/patch/${p.id}`}><strong>#{p.id} {p.title}</strong></Link>{p.summary && <div className="lbl">{p.summary}</div>}</> },
  { id: 'server', header: 'Server', sort: (p) => p.server_name, cell: (p) => p.server_name },
  { id: 'pkg', header: 'Paket', sort: (p) => p.packages ?? -1, cell: (p) => (p.packages == null ? '-' : `${p.packages}${p.security ? ` (${p.security} keamanan)` : ''}`) },
  { id: 'prog', header: 'Kemajuan', cell: (p) => <span className="lbl">{progress(p)}</span> },
  { id: 'when', header: 'Terakhir berubah', sort: (p) => p.updated, cell: (p) => <span className="lbl">{ago(p.updated)}{p.approved_by ? ` | disetujui ${p.approved_by}` : ''}</span> }
];

export function PatchPlansPanel() {
  const query = useQuery(q.patchPlans());
  if (!query.data?.length) return null;   // belum pernah ada rencana: bagian ini tidak perlu tampil
  const plans = query.data, count = (...s: string[]) => plans.filter((p) => s.includes(p.status)).length;
  const draft = count('proposed'), running = count('approved', 'executing'), failed = count('failed');
  const hint = [running ? `${running} berjalan` : '', draft ? `${draft} draf` : '', failed ? `${failed} gagal` : '', `${count('done')} selesai`].filter(Boolean).join(', ');
  return (
    <Fold title="Rencana patch" hint={hint} open={running > 0 || draft > 0 || failed > 0}>
      <DataGrid label="Rencana patch" rows={plans} columns={columns} rowKey={(p) => p.id} defaultSort={{ id: 'status', dir: 'asc' }} storageKey="aiops.patchplans.size" empty="" />
      <p className="lbl" style={{ marginTop: 8 }}>
        <b>Draf</b>: rencana sudah disusun tetapi belum Anda setujui, jadi belum ada yang dijalankan di server. <b>Berjalan</b>: sudah disetujui dan langkahnya sedang dikerjakan. <b>Selesai</b>, <b>Gagal</b> (berhenti di langkah yang gagal), <b>Ditolak</b>, dan <b>Digantikan</b> (diganti rencana yang lebih baru untuk server yang sama).
      </p>
    </Fold>
  );
}
