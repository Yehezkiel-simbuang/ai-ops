// Logika murni tabel data: urutkan, potong per halaman, dan susun nomor halaman. Dipisah dari tampilan agar mudah diuji.
export type SortDir = 'asc' | 'desc';

/** Mengurutkan salinan: nilai kosong selalu di akhir; teks dibandingkan menurut aturan bahasa Indonesia dan angka alami. */
export function sortRows<T>(rows: T[], value: ((r: T) => string | number | null | undefined) | undefined, dir: SortDir): T[] {
  if (!value) return rows;
  const collator = new Intl.Collator('id', { numeric: true, sensitivity: 'base' }), sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a), y = value(b), xe = x == null || x === '', ye = y == null || y === '';
    if (xe || ye) return xe && ye ? 0 : xe ? 1 : -1;
    return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y)));
  });
}

export interface Page<T> { items: T[]; page: number; pages: number; total: number; from: number; to: number }

/** Halaman 1-berbasis. Halaman di luar rentang dirapikan ke rentang yang sah (mis. setelah filter mengurangi baris). */
export function paginate<T>(rows: T[], page: number, size: number): Page<T> {
  const total = rows.length, pages = Math.max(1, Math.ceil(total / size)), p = Math.min(Math.max(1, Math.floor(page) || 1), pages), start = (p - 1) * size;
  return { items: rows.slice(start, start + size), page: p, pages, total, from: total ? start + 1 : 0, to: Math.min(start + size, total) };
}

/** Nomor halaman yang ditampilkan: selalu halaman pertama dan terakhir, dua di sekitar halaman aktif, dan null sebagai pemisah "...". */
export function pageWindow(page: number, pages: number): Array<number | null> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages)), out: Array<number | null> = [];
  for (const n of [...keep].sort((a, b) => a - b)) { if (out.length && n - (out[out.length - 1] as number) > 1) out.push(null); out.push(n); }
  return out;
}
