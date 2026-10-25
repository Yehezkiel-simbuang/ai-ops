import { useEffect, useRef, type ReactNode } from 'react';

/** Dialog modal memakai elemen <dialog> bawaan peramban (fokus terkunci, Esc menutup). Isi hanya dipasang saat terbuka sehingga formulir selalu segar. */
export function Modal({ open, onClose, children, wide = false }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? 'dlg wide' : 'dlg'} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {open && children}
    </dialog>
  );
}
