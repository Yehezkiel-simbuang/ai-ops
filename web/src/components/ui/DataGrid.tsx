// Tabel data umum: kolom yang bisa diurutkan dan penomoran halaman (ukuran halaman dipilih pengguna). Pencarian dan filter
// disediakan pemakainya (data sudah disaring sebelum masuk ke sini); tabel hanya mengurutkan dan membagi halaman.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Empty } from './Layout';
import { paginate, pageWindow, sortRows, type SortDir } from '@/lib/grid';
import { IconChevronDown, IconChevronUp } from '@/components/icons';

export interface Column<T> { id: string; header: string; cell: (row: T) => ReactNode; sort?: (row: T) => string | number | null | undefined; className?: string }

interface Props<T> {
  rows: T[]; columns: Array<Column<T>>; rowKey: (row: T) => string | number; empty: ReactNode;
  onRowClick?: (row: T) => void; pageSizes?: number[]; defaultSize?: number; defaultSort?: { id: string; dir: SortDir };
  /** Berubah bila saringan berubah; tabel kembali ke halaman 1. */
  resetKey?: string; storageKey?: string; label: string;
}

const readSize = (key: string | undefined, fallback: number, allowed: number[]): number => {
  try { const n = Number(key ? localStorage.getItem(key) : null); return allowed.includes(n) ? n : fallback; } catch { return fallback; }
};

export function DataGrid<T>({ rows, columns, rowKey, empty, onRowClick, pageSizes = [10, 25, 50, 100], defaultSize = 10, defaultSort, resetKey = '', storageKey, label }: Props<T>) {
  const [sort, setSort] = useState<{ id: string; dir: SortDir } | null>(defaultSort ?? null), [page, setPage] = useState(1), [size, setSize] = useState(() => readSize(storageKey, defaultSize, pageSizes));
  useEffect(() => { setPage(1); }, [resetKey, size, sort]);
  const col = columns.find((c) => c.id === sort?.id), sorted = useMemo(() => sortRows(rows, col?.sort, sort?.dir ?? 'asc'), [rows, col, sort]), view = paginate(sorted, page, size);
  const toggle = (c: Column<T>) => { if (!c.sort) return; setSort((s) => (s?.id === c.id ? (s.dir === 'asc' ? { id: c.id, dir: 'desc' } : null) : { id: c.id, dir: 'asc' })); };
  const changeSize = (n: number) => { setSize(n); try { if (storageKey) localStorage.setItem(storageKey, String(n)); } catch { /* penyimpanan tidak tersedia: abaikan */ } };
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="grid">
      <div className="tbl-wrap">
        <table className="tbl" aria-label={label}>
          <thead><tr>{columns.map((c) => {
            const active = sort?.id === c.id, aria = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sort ? 'none' : undefined;
            return (
              <th key={c.id} className={c.className} aria-sort={aria}>
                {c.sort ? <button type="button" className="th-sort" onClick={() => toggle(c)} aria-label={`Urutkan menurut ${c.header}`}>{c.header}{active && (sort!.dir === 'asc' ? <IconChevronUp size={13} aria-hidden /> : <IconChevronDown size={13} aria-hidden />)}</button> : c.header}
              </th>
            );
          })}</tr></thead>
          <tbody>{view.items.map((r) => (
            <tr key={rowKey(r)} className={onRowClick ? 'click' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => <td key={c.id} className={c.className}>{c.cell(r)}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <nav className="pager" aria-label={`Halaman ${label}`}>
        <span className="lbl" aria-live="polite">Menampilkan {view.from} sampai {view.to} dari {view.total}</span>
        <span className="grow" />
        <label className="lbl">Per halaman <select aria-label="Baris per halaman" value={size} onChange={(e) => changeSize(Number(e.target.value))}>{pageSizes.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <button type="button" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)} aria-label="Halaman sebelumnya">Sebelumnya</button>
        {pageWindow(view.page, view.pages).map((n, i) => n === null
          ? <span key={`e${i}`} className="lbl" aria-hidden>...</span>
          : <button key={n} type="button" className={n === view.page ? 'primary' : undefined} aria-current={n === view.page ? 'page' : undefined} aria-label={`Halaman ${n}`} onClick={() => setPage(n)}>{n}</button>)}
        <button type="button" disabled={view.page >= view.pages} onClick={() => setPage(view.page + 1)} aria-label="Halaman berikutnya">Berikutnya</button>
      </nav>
    </div>
  );
}
