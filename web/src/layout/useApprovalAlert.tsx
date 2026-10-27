// Pemberitahuan di browser saat ada yang menunggu Anda (persetujuan atau perintah gagal), supaya tidak perlu memantau halaman terus.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconBell } from '@/components/icons';

const supported = () => typeof Notification !== 'undefined';

/** Judul tab memuat jumlah yang menunggu; notifikasi sistem muncul bila jumlahnya naik saat tab tidak sedang dilihat. */
export function useApprovalAlert(count: number): void {
  const base = useRef(typeof document === 'undefined' ? 'AI Ops' : document.title), prev = useRef(0);
  useEffect(() => {
    document.title = count > 0 ? `(${count}) Perlu tindakan | ${base.current}` : base.current;
    if (count > prev.current && document.hidden && supported() && Notification.permission === 'granted') {
      try { new Notification('AI Ops', { body: `${count} hal menunggu tindakan Anda (persetujuan atau perintah gagal).`, tag: 'aiops-approval' }); } catch { /* beberapa browser melarang konstruktor di sini */ }
    }
    prev.current = count;
  }, [count]);
  useEffect(() => () => { document.title = base.current; }, []);
}

/** Ajakan sekali untuk mengizinkan notifikasi; hilang setelah dijawab atau bila browser tidak mendukung. */
export function NotifyOptIn() {
  const [perm, setPerm] = useState<NotificationPermission | 'none'>(supported() ? Notification.permission : 'none');
  if (perm !== 'default') return null;
  const ask = async () => { setPerm(await Notification.requestPermission()); };
  return <Button icon={IconBell} onClick={ask}>Aktifkan notifikasi browser</Button>;
}
