import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { IconType } from '../icons';

export type Tone = 'ok' | 'warn' | 'bad' | 'mute' | 'acc';

interface BadgeProps { tone?: Tone; icon?: IconType; to?: string; href?: string; download?: string; children: ReactNode }

/** Label status kecil. Dengan `to` menjadi tautan rute, dengan `href` tautan biasa (mis. unduhan). */
export function Badge({ tone = 'mute', icon: Icon, to, href, download, children }: BadgeProps) {
  const content = <>{Icon && <Icon size={12} aria-hidden />}{children}</>;
  const cls = `badge ${tone}`;
  if (to) return <Link className={cls} to={to}>{content}</Link>;
  if (href) return <a className={cls} href={href} download={download}>{content}</a>;
  return <span className={cls}>{content}</span>;
}
