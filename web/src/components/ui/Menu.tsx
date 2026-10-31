import { useEffect, useId, useRef, useState } from 'react';
import type { IconType } from '../icons';
import { IconMore } from '../icons';

export interface MenuItem { label: string; icon?: IconType; danger?: boolean; hidden?: boolean; onSelect: () => unknown }

/** Tombol "aksi lain": membuka daftar aksi yang jarang dipakai. Tutup dengan Esc, klik di luar, atau memilih satu aksi. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false), box = useRef<HTMLDivElement>(null), id = useId(), shown = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!shown.length) return null;
  return (
    <div className="menu" ref={box}>
      <button type="button" aria-label={label} title="Aksi lain" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}><IconMore size={16} aria-hidden /></button>
      {open && (
        <div className="menu-list" role="menu" id={id}>
          {shown.map((i) => (
            <button type="button" role="menuitem" key={i.label} className={i.danger ? 'danger' : undefined} onClick={() => { setOpen(false); void i.onSelect(); }}>
              {i.icon && <i.icon size={16} aria-hidden />}{i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
