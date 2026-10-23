// Tabel Vault kredensial dan Pemeliharaan pada Inventaris: urutkan per kolom, penomoran halaman, dan satu filter status.
import { useMemo, useState } from 'react';
import type { Credential, MaintenanceTask } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { DataGrid, type Column } from '@/components/ui/DataGrid';
import { ago, dateStr } from '@/lib/format';
import { CredentialActions, credentialBadges } from './CredentialList';
import { TaskActions, taskBadges, taskWhen } from './MaintenanceList';

export type CredStatus = '' | 'ganti' | 'kedaluwarsa' | 'sehat';
export type TaskStatus = '' | MaintenanceTask['status'];

export const credStatus = (c: Credential): Exclude<CredStatus, ''> => (c.expired ? 'kedaluwarsa' : c.rotation_overdue ? 'ganti' : 'sehat');

function StatusFilter<T extends string>({ label, value, onChange, options, shown, total }: { label: string; value: T; onChange: (v: T) => void; options: Array<[T, string]>; shown: number; total: number }) {
  return (
    <div className="row" style={{ marginBottom: 8 }}>
      <label className="lbl">{label} <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}><option value="">Semua</option>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <span className="lbl" aria-live="polite">{shown} dari {total}</span>
    </div>
  );
}

export function VaultGrid({ rows, searching }: { rows: Credential[]; searching: boolean }) {
  const [status, setStatus] = useState<CredStatus>('');
  const shown = useMemo(() => rows.filter((c) => !status || credStatus(c) === status), [rows, status]);
  const columns: Array<Column<Credential>> = [
    { id: 'label', header: 'Kredensial', sort: (c) => `${c.server_name ?? ''} ${c.label}`, cell: (c) => <><strong>{c.label}</strong><div className="lbl">{c.server_name || 'umum'}</div>{c.notes && <div className="lbl">{c.notes}</div>}</> },
    { id: 'kind', header: 'Jenis', sort: (c) => c.kind, cell: (c) => <Badge>{c.kind}</Badge> },
    { id: 'user', header: 'Pengguna / alamat', sort: (c) => c.username, cell: (c) => <>{c.username ? <span className="mono">{c.username}</span> : <span className="lbl">tanpa pengguna</span>}<div className="lbl">{c.url}{c.port ? `:${c.port}` : ''}</div></> },
    { id: 'rotated', header: 'Diganti', sort: (c) => c.rotated_at, cell: (c) => <>{dateStr(c.rotated_at)}<div className="lbl">{c.age_days} hari lalu{c.last_revealed ? ` | dilihat ${ago(c.last_revealed)}` : ''}</div></> },
    { id: 'status', header: 'Status', sort: (c) => ({ kedaluwarsa: 0, ganti: 1, sehat: 2 })[credStatus(c)], cell: (c) => credentialBadges(c) },
    { id: 'act', header: 'Aksi', cell: (c) => <div className="row"><CredentialActions c={c} /></div> }
  ];
  return (
    <>
      <StatusFilter label="Status" value={status} onChange={setStatus} total={rows.length} shown={shown.length}
        options={[['ganti', 'Perlu diganti'], ['kedaluwarsa', 'Kedaluwarsa'], ['sehat', 'Normal']]} />
      <DataGrid label="Daftar kredensial" rows={shown} columns={columns} rowKey={(c) => c.id} storageKey="aiops.vault.size" defaultSort={{ id: 'label', dir: 'asc' }} resetKey={status + String(rows.length)}
        empty={searching || status ? 'Tidak ada kredensial yang cocok dengan pencarian atau filter.' : 'Belum ada kredensial.'} />
    </>
  );
}

const STATUS_ORDER: Record<MaintenanceTask['status'], number> = { terlambat: 0, segera: 1, ok: 2, nonaktif: 3 };

export function MaintenanceGrid({ rows, searching }: { rows: MaintenanceTask[]; searching: boolean }) {
  const [status, setStatus] = useState<TaskStatus>('');
  const shown = useMemo(() => rows.filter((t) => !status || t.status === status), [rows, status]);
  const columns: Array<Column<MaintenanceTask>> = [
    { id: 'title', header: 'Tugas', sort: (t) => t.title, cell: (t) => <><strong>{t.title}</strong>{t.description && <div className="lbl">{t.description}</div>}</> },
    { id: 'server', header: 'Server', sort: (t) => t.server_name, cell: (t) => t.server_name || '-' },
    { id: 'when', header: 'Jadwal', sort: (t) => t.every_days ?? Number.MAX_SAFE_INTEGER, cell: (t) => <span className="lbl">{taskWhen(t)}</span> },
    { id: 'due', header: 'Jatuh tempo', sort: (t) => t.due_at, cell: (t) => <>{taskBadges(t)}</> },
    { id: 'status', header: 'Status', sort: (t) => STATUS_ORDER[t.status] ?? 9, cell: (t) => t.status },
    { id: 'act', header: 'Aksi', cell: (t) => <div className="row"><TaskActions t={t} /></div> }
  ];
  return (
    <>
      <StatusFilter label="Status" value={status} onChange={setStatus} total={rows.length} shown={shown.length}
        options={[['terlambat', 'Terlambat'], ['segera', 'Segera'], ['ok', 'Aman'], ['nonaktif', 'Nonaktif']]} />
      <DataGrid label="Daftar pemeliharaan" rows={shown} columns={columns} rowKey={(t) => t.id} storageKey="aiops.maint.size" defaultSort={{ id: 'due', dir: 'asc' }} resetKey={status + String(rows.length)}
        empty={searching || status ? 'Tidak ada tugas yang cocok dengan pencarian atau filter.' : 'Belum ada tugas pemeliharaan. Tambahkan dari halaman tiap server (ada templat standar).'} />
    </>
  );
}
