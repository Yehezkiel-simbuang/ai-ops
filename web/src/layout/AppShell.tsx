import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { q } from '@/api/queries';
import { post } from '@/lib/api';
import { useApprovalAlert } from './useApprovalAlert';
import {
  IconChart, IconFlame, IconFlask, IconBook, IconCloud, IconScale, IconGauge, IconGlobe, IconHome, IconLayers, IconLock, IconMenu, IconPulse, IconServer, IconSliders, IconWrench, IconClose, type IconType
} from '@/components/icons';

interface NavItem { to: string; label: string; icon: IconType; badge?: 'pending' | 'incidents' | 'alerts' | 'setup' }
interface NavGroup { title: string; items: NavItem[] }

/** Menu dikelompokkan menurut tujuan: yang dilihat tiap hari di atas, yang jarang dipakai di bawah. */
const GROUPS: NavGroup[] = [
  { title: 'Pantau', items: [
    { to: '/ringkasan', label: 'Ringkasan', icon: IconHome, badge: 'pending' },
    { to: '/monitor', label: 'Monitor', icon: IconPulse, badge: 'alerts' },
    { to: '/insiden', label: 'Insiden', icon: IconFlame, badge: 'incidents' },
    { to: '/server', label: 'Server', icon: IconServer },
    { to: '/layanan', label: 'Layanan', icon: IconGlobe }
  ] },
  { title: 'Kelola', items: [
    { to: '/inventaris', label: 'Inventaris', icon: IconLayers },
    { to: '/setup', label: 'Setup', icon: IconWrench, badge: 'setup' },
    { to: '/standar', label: 'Standar', icon: IconScale }
  ] },
  { title: 'Uji', items: [
    { to: '/arsitektur', label: 'Arsitektur', icon: IconFlask },
    { to: '/playground', label: 'Playground', icon: IconCloud },
    { to: '/uji-beban', label: 'Uji beban', icon: IconGauge }
  ] },
  { title: 'Lainnya', items: [
    { to: '/token', label: 'Pemakaian token', icon: IconChart },
    { to: '/panduan', label: 'Panduan', icon: IconBook },
    { to: '/pengaturan', label: 'Pengaturan', icon: IconSliders }
  ] }
];
const ALL = GROUPS.flatMap((g) => g.items);

function Count({ n, bad }: { n: number; bad?: boolean }) {
  return n > 0 ? <em className={`cnt${bad ? ' bad' : ''}`}>{n}</em> : null;
}

/** Nama halaman yang sedang dibuka, untuk bilah atas di layar kecil. */
export const pageTitle = (path: string): string => ALL.find((i) => path === i.to || path.startsWith(`${i.to}/`))?.label ?? 'AI Ops';

export function AppShell() {
  const overview = useQuery(q.overview()).data, client = useQueryClient(), navigate = useNavigate(), { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const stuck = overview?.runs.filter((r) => r.status === 'needs_attention').length ?? 0;   // proses Setup yang berhenti karena perintah gagal
  const counts = { pending: overview?.pending.length ?? 0, incidents: overview?.incidents.length ?? 0, alerts: overview?.alerts.length ?? 0, setup: (overview?.pending.length ?? 0) + stuck };
  const attention = counts.pending + counts.incidents + counts.alerts + stuck;
  useApprovalAlert(counts.setup);

  useEffect(() => { setOpen(false); }, [pathname]);   // pindah halaman menutup menu
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const logout = async () => {
    await post('/api/logout').catch(() => undefined);
    client.clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="menu-btn" aria-label={open ? 'Tutup menu' : 'Buka menu'} aria-expanded={open} aria-controls="menu-utama" onClick={() => setOpen(!open)}>
          {open ? <IconClose size={20} aria-hidden /> : <IconMenu size={20} aria-hidden />}
          {!open && attention > 0 && <em className="cnt bad dot">{attention}</em>}
        </button>
        <Logo size={20} title="" /><strong>{pageTitle(pathname)}</strong>
      </header>
      <nav id="menu-utama" className={`side${open ? ' open' : ''}`} aria-label="Navigasi utama">
        <div className="logo"><Logo size={24} title="" /><span>AI Ops Pribadi</span></div>
        {GROUPS.map((g) => (
          <div key={g.title} className="navgroup" role="group" aria-label={g.title}>
            <div className="navhead" aria-hidden>{g.title}</div>
            {g.items.map(({ to, label, icon: Icon, badge }) => (
              <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
                <Icon size={16} aria-hidden /><span>{label}</span>{badge && <Count n={counts[badge]} bad={badge !== 'pending'} />}
              </NavLink>
            ))}
          </div>
        ))}
        <button type="button" className="navlink exit" onClick={logout}><IconLock size={16} aria-hidden /><span>Keluar</span></button>
      </nav>
      {open && <div className="scrim" aria-hidden onClick={() => setOpen(false)} />}
      <main aria-live="polite"><Outlet /></main>
    </div>
  );
}
