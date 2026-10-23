import type { ReactNode } from 'react';
import { Empty } from './Layout';

interface DataTableProps {
  heads: string[];
  rows: ReactNode[][];
  empty: string;
  /** Jumlah kolom kiri bertipe teks; sisanya rata kanan (angka). Bawaan 1. */
  textCols?: number;
}

export function DataTable({ heads, rows, empty, textCols = 1 }: DataTableProps) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  const cls = (i: number) => (i >= textCols ? 'num' : undefined);
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr>{heads.map((h, i) => <th key={i} className={cls(i)}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className={cls(ci)}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
