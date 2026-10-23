// Tabel server pada Inventaris: urutkan per kolom, penomoran halaman, dan filter lanjutan (lingkungan, tag, PIC, pemeliharaan, kredensial).
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { InventoryRow } from '@/api/types';
import { EnvBadge } from '@/components/StatusBadges';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type Column } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Hint } from '@/components/ui/Layout';
import { IconBell, IconClose, IconFilter } from '@/components/icons';
import { dateStr } from '@/lib/format';
import { CRED_LABELS, MAINT_LABELS, NO_FILTERS, activeCount, applyFilters, chips, options, removeChip, type CredFilter, type Filters, type MaintFilter } from './inventoryFilters';

const ENV_ORDER: Record<string, number> = { prod: 0, staging: 1, dev: 2, lab: 3 };

function FilterPanel({ rows, value, onChange }: { rows: InventoryRow[]; value: Filters; onChange: (f: Filters) => void }) {
  const o = useMemo(() => options(rows), [rows]);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <fieldset className="filters" aria-label="Filter lanjutan">
      <div className="filter-col">
        <legend>Lingkungan</legend>
        {o.env.map((e) => <label key={e} className="checkline"><input type="checkbox" checked={value.env.includes(e)} onChange={() => onChange({ ...value, env: toggle(value.env, e) })} /><span>{e}</span></label>)}
      </div>
      <div className="filter-col">
        <legend>Tag</legend>
        {o.tags.length ? o.tags.slice(0, 12).map((t) => <label key={t} className="checkline"><input type="checkbox" checked={value.tags.includes(t)} onChange={() => onChange({ ...value, tags: toggle(value.tags, t) })} /><span>{t}</span></label>) : <span className="lbl">Belum ada tag</span>}
      </div>
      <div className="filter-col">
        <Field label="PIC (pemilik)"><select aria-label="PIC" value={value.owner} onChange={(e) => onChange({ ...value, owner: e.target.value })}><option value="">Semua</option>{o.owners.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Pemeliharaan"><select aria-label="Pemeliharaan" value={value.maint} onChange={(e) => onChange({ ...value, maint: e.target.value as MaintFilter })}><option value="">Semua</option>{Object.entries(MAINT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Kredensial"><select aria-label="Kredensial" value={value.cred} onChange={(e) => onChange({ ...value, cred: e.target.value as CredFilter })}><option value="">Semua</option>{Object.entries(CRED_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
    </fieldset>
  );
}

export function ServerGrid({ rows, searching }: { rows: InventoryRow[]; searching: boolean }) {
  const navigate = useNavigate(), [filters, setFilters] = useState<Filters>(NO_FILTERS), [open, setOpen] = useState(false);
  const shown = useMemo(() => applyFilters(rows, filters), [rows, filters]), n = activeCount(filters), tags = chips(filters);
  const attention = shown.filter((r) => r.overdue > 0).length, rotation = shown.filter((r) => r.rotation_due > 0).length;
  const columns: Array<Column<InventoryRow>> = [
    { id: 'name', header: 'Server', sort: (r) => r.name, cell: (r) => <><Link to={`/inventaris/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link><div className="lbl">{(r.os_info || '').slice(0, 40)}</div></> },
    { id: 'ip', header: 'IP / akses', sort: (r) => r.primary_address || r.host, cell: (r) => <><span className="mono">{r.primary_address || r.host}</span><div className="lbl">{r.username}@{r.host}:{r.port}</div></> },
    { id: 'purpose', header: 'Fungsi', sort: (r) => r.purpose, cell: (r) => <div style={{ maxWidth: 280 }}><div>{r.purpose || '-'}</div>{r.tags?.length > 0 && <div className="lbl">{r.tags.join(', ')}</div>}{r.owner && <div className="lbl">PIC: {r.owner}</div>}</div> },
    { id: 'env', header: 'Lingkungan', sort: (r) => ENV_ORDER[r.environment] ?? 9, cell: (r) => <EnvBadge env={r.environment} /> },
    { id: 'maint', header: 'Pemeliharaan', sort: (r) => (r.overdue > 0 ? -r.overdue : r.next_due ?? Number.MAX_SAFE_INTEGER), cell: (r) => (r.overdue ? <Badge tone="bad">{r.overdue} terlambat</Badge> : r.next_due ? <Badge>berikutnya {dateStr(r.next_due)}</Badge> : <span className="lbl">belum ada jadwal</span>) },
    { id: 'cred', header: 'Kredensial', sort: (r) => r.credentials, cell: (r) => <>{r.credentials} {r.rotation_due > 0 && <Badge tone="warn">ganti password</Badge>}</> }
  ];
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <Button icon={IconFilter} aria-expanded={open} onClick={() => setOpen(!open)}>Filter lanjutan{n ? ` (${n})` : ''}</Button>
        {n > 0 && <Button icon={IconClose} onClick={() => setFilters(NO_FILTERS)}>Hapus semua filter</Button>}
        <span className="lbl" aria-live="polite">{shown.length} dari {rows.length} server</span>
      </div>
      {open && <FilterPanel rows={rows} value={filters} onChange={setFilters} />}
      {tags.length > 0 && <div className="chips" style={{ margin: '6px 0 10px' }}>{tags.map((c) => <button key={c.id} type="button" aria-label={`Hapus filter ${c.label}`} onClick={() => setFilters(removeChip(filters, c.id))}>{c.label} <IconClose size={11} aria-hidden /></button>)}</div>}
      {(attention > 0 || rotation > 0) && <Hint icon={IconBell}>{attention > 0 && `${attention} server punya pemeliharaan terlambat. `}{rotation > 0 && `${rotation} server punya password yang sudah waktunya diganti.`}</Hint>}
      <DataGrid label="Daftar server" rows={shown} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/inventaris/${r.id}`)} storageKey="aiops.inventaris.size" defaultSort={{ id: 'name', dir: 'asc' }} resetKey={JSON.stringify(filters) + String(rows.length)}
        empty={searching || n > 0 ? 'Tidak ada server yang cocok dengan pencarian atau filter.' : 'Belum ada server. Tambahkan di halaman Server.'} />
    </>
  );
}
