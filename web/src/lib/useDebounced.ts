import { useEffect, useState } from 'react';

/** Nilai yang baru ikut berubah setelah `ms` tanpa perubahan lagi (mengurangi permintaan saat mengetik atau menggeser slider). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
