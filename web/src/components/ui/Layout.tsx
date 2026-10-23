// Potongan tata letak halaman yang dipakai berulang.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { IconType } from '../icons';
import { IconBulb } from '../icons';

export function PageHead({ title, icon: Icon, children }: { title: ReactNode; icon?: IconType; children?: ReactNode }) {
  return (
    <div className="pagehead">
      <h1>{Icon && <Icon size={18} aria-hidden />}{title}</h1>
      <div className="grow" />
      {children}
    </div>
  );
}

export function Section({ title, icon: Icon, children, className = '' }: { title?: ReactNode; icon?: IconType; children: ReactNode; className?: string }) {
  return (
    <section className={`sec ${className}`.trim()}>
      {title && <h2>{Icon && <Icon size={16} aria-hidden />}{title}</h2>}
      {children}
    </section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Hint({ icon: Icon = IconBulb, children }: { icon?: IconType; children: ReactNode }) {
  return <div className="hint"><Icon size={16} aria-hidden /><div>{children}</div></div>;
}

export const Loading = () => <div className="empty">Memuat...</div>;

export const Note = ({ children, className = '' }: { children: ReactNode; className?: string }) => <p className={`note ${className}`.trim()}>{children}</p>;

/** Daftar baris bergaya kartu; tiap anak biasanya <Item>. */
export const List = ({ children }: { children: ReactNode }) => <div className="list">{children}</div>;

interface ItemProps { title: ReactNode; sub?: ReactNode[]; to?: string; children?: ReactNode; off?: boolean; top?: boolean }
/** Satu baris daftar: judul + baris keterangan kecil di kiri, aksi/label di kanan. Dengan `to` seluruh baris menjadi tautan. */
export function Item({ title, sub = [], to, children, off, top }: ItemProps) {
  const cls = ['item', to ? 'click' : '', off ? 'off' : '', top ? 'top' : ''].filter(Boolean).join(' ');
  const body = (
    <>
      <div className="meta">
        <b>{title}</b>
        {sub.filter(Boolean).map((line, i) => <span key={i}>{line}</span>)}
      </div>
      {children && <div className="row">{children}</div>}
    </>
  );
  return to ? <Link className={cls} to={to}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function Tile({ value, label }: { value: ReactNode; label: string }) {
  return <div className="tile"><b>{value}</b><span>{label}</span></div>;
}
export const Tiles = ({ children }: { children: ReactNode }) => <div className="tiles">{children}</div>;

interface Tab<T extends string> { id: T; label: ReactNode }
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<Tab<T>>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) { return <Link to={to}>{children}</Link>; }
