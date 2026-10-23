import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { q } from '@/api/queries';
import { Loading } from '@/components/ui/Layout';
import { onUnauthorized } from '@/lib/api';
import { ForcedPasswordChange } from './ChangePassword';

/** Rute di dalamnya hanya tampil bila ada sesi. Sesi yang berakhir di tengah pemakaian (401) mengembalikan ke halaman masuk. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useQuery(q.me()), client = useQueryClient();
  useEffect(() => onUnauthorized(() => { void client.resetQueries({ queryKey: ['me'] }); }), [client]);
  if (me.isPending) return <Loading />;
  if (me.isError || !me.data) return <Navigate to="/login" replace />;
  if (me.data.mustChange) return <ForcedPasswordChange />;   // password awal: tidak ada halaman lain sebelum diganti
  return <>{children}</>;
}
