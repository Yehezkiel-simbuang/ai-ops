import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Empty, Loading } from './Layout';

/** Menampilkan keadaan memuat/galat sebuah query, lalu isi bila data tersedia. Data lama tetap tampil saat penyegaran latar. */
export function Async<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <Empty>Gagal memuat: {(query.error as Error).message}</Empty>;
  return <Loading />;
}
