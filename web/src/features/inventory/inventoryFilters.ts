// Saringan lanjutan untuk tabel inventaris server. Murni dan bisa diuji; pencarian teks tetap dikerjakan server (mencakup port dan layanan).
import type { InventoryRow } from '@/api/types';

export type MaintFilter = '' | 'terlambat' | 'terjadwal' | 'tanpa';
export type CredFilter = '' | 'punya' | 'tanpa' | 'ganti';

export interface Filters { env: string[]; tags: string[]; owner: string; maint: MaintFilter; cred: CredFilter }
export const NO_FILTERS: Filters = { env: [], tags: [], owner: '', maint: '', cred: '' };

export const MAINT_LABELS: Record<Exclude<MaintFilter, ''>, string> = { terlambat: 'Ada yang terlambat', terjadwal: 'Terjadwal, belum terlambat', tanpa: 'Belum ada jadwal' };
export const CRED_LABELS: Record<Exclude<CredFilter, ''>, string> = { punya: 'Punya kredensial', tanpa: 'Tanpa kredensial', ganti: 'Ada password yang perlu diganti' };

/** Semua kondisi harus terpenuhi (AND); dalam satu kelompok pilihan ganda (lingkungan, tag) cukup salah satu (OR). */
export function matches(r: InventoryRow, f: Filters): boolean {
  if (f.env.length && !f.env.includes(r.environment)) return false;
  if (f.tags.length && !f.tags.some((t) => (r.tags ?? []).includes(t))) return false;
  if (f.owner && r.owner !== f.owner) return false;
  if (f.maint === 'terlambat' && !(r.overdue > 0)) return false;
  if (f.maint === 'terjadwal' && !(r.overdue === 0 && r.next_due)) return false;
  if (f.maint === 'tanpa' && (r.overdue > 0 || r.next_due)) return false;
  if (f.cred === 'punya' && !(r.credentials > 0)) return false;
  if (f.cred === 'tanpa' && r.credentials > 0) return false;
  if (f.cred === 'ganti' && !(r.rotation_due > 0)) return false;
  return true;
}

export const applyFilters = (rows: InventoryRow[], f: Filters): InventoryRow[] => rows.filter((r) => matches(r, f));

/** Jumlah saringan yang aktif (satu per kelompok yang terisi). */
export const activeCount = (f: Filters): number => [f.env.length > 0, f.tags.length > 0, !!f.owner, !!f.maint, !!f.cred].filter(Boolean).length;

/** Pilihan yang tersedia, diambil dari data supaya tidak menawarkan nilai yang tidak ada. */
export function options(rows: InventoryRow[]): { env: string[]; tags: string[]; owners: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
  return { env: ['prod', 'staging', 'dev', 'lab'], tags: uniq(rows.flatMap((r) => r.tags ?? [])), owners: uniq(rows.map((r) => r.owner)) };
}

/** Ringkasan saringan aktif untuk ditampilkan sebagai label yang bisa dihapus satu per satu. */
export function chips(f: Filters): Array<{ id: string; label: string }> {
  return [
    ...f.env.map((e) => ({ id: `env:${e}`, label: `Lingkungan: ${e}` })), ...f.tags.map((t) => ({ id: `tag:${t}`, label: `Tag: ${t}` })),
    ...(f.owner ? [{ id: 'owner', label: `PIC: ${f.owner}` }] : []), ...(f.maint ? [{ id: 'maint', label: `Pemeliharaan: ${MAINT_LABELS[f.maint]}` }] : []), ...(f.cred ? [{ id: 'cred', label: `Kredensial: ${CRED_LABELS[f.cred]}` }] : [])
  ];
}

export function removeChip(f: Filters, id: string): Filters {
  if (id.startsWith('env:')) return { ...f, env: f.env.filter((e) => e !== id.slice(4)) };
  if (id.startsWith('tag:')) return { ...f, tags: f.tags.filter((t) => t !== id.slice(4)) };
  return { ...f, [id]: '' } as Filters;
}
