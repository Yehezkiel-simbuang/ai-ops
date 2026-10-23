import { useToast } from '@/lib/toast';

export function Toaster() {
  const t = useToast();
  if (!t) return null;
  return <div className={`toast${t.bad ? ' bad' : ''}`} role="status" key={t.id}>{t.message}</div>;
}
