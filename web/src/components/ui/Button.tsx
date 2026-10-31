import { useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { toast } from '@/lib/toast';
import { IconArrowRight, type IconType } from '../icons';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  icon?: IconType;
  primary?: boolean;
  /** Boleh async: tombol terkunci selama janji berjalan (mencegah klik ganda). */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
}

export function Button({ icon: Icon, primary, onClick, children, className, disabled, type = 'button', ...rest }: ButtonProps) {
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const click = async (e: MouseEvent<HTMLButtonElement>) => {
    if (!onClick) return;
    setPending(true);
    try { await onClick(e); }
    catch (err) { toast((err as Error).message || 'Aksi gagal', true); }   // galat aksi selalu tampil ke pengguna dan tidak menjadi unhandled rejection
    finally { if (alive.current) setPending(false); }
  };
  const cls = [primary ? 'primary' : '', className ?? ''].filter(Boolean).join(' ') || undefined;
  return (
    <button type={type} className={cls} disabled={disabled || pending} onClick={click} {...rest}>
      {Icon && <Icon size={16} aria-hidden />}
      {children}
    </button>
  );
}

/** Tautan ke halaman lain yang tampil seperti tombol, dengan panah di ujung supaya jelas berbeda dari aksi. */
export function LinkButton({ to, icon: Icon, children }: { to: string; icon?: IconType; children: string }) {
  return <Link className="btn-link" to={to}>{Icon && <Icon size={16} aria-hidden />}{children}<IconArrowRight size={14} aria-hidden /></Link>;
}
