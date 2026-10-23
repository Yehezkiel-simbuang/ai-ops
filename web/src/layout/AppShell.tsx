import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { q } from '@/api/queries';
import { post } from '@/lib/api';
import {
  IconChart, IconFlame, IconFlask, IconBook, IconCloud, IconScale, IconGauge, IconGlobe, IconHome, IconLayers, IconLock, IconPulse, IconServer, IconSliders, IconWrench, type IconType
} from '@/components/icons';

interface NavItem { to: string; label: string; icon: IconType; badge?: 'pending' | 'incidents' | 'alerts' }

const NAV: NavItem[] = [
  { to: '/ringkasan', label: 'Ringkasan', icon: IconHome, badge: 'pending' },
  { to: '/insiden', label: 'Insiden', icon: IconFlame, badge: 'incidents' },
  { to: '/inventaris', label: 'Inventaris', icon: IconLayers },
  { to: '/server', label: 'Server', icon: IconServer },
  { to: '/layanan', label: 'Layanan', icon: IconGlobe },
  { to: '/arsitektur', label: 'Arsitektur', icon: IconFlask },
  { to: '/playground', label: 'Playground', icon: IconCloud },
  { to: '/uji-beban', label: 'Uji beban', icon: IconGauge },
  { to: '/setup', label: 'Setup', icon: IconWrench },
  { to: '/monitor', label: 'Monitor', icon: IconPulse, badge: 'alerts' },
  { to: '/standar', label: 'Standar', icon: IconScale },
  { to: '/token', label: 'Pemakaian token', icon: IconChart },
  { to: '/panduan', label: 'Panduan', icon: IconBook },
  { to: '/pengaturan', label: 'Pengaturan', icon: IconSliders }
];

function Count({ n, bad }: { n: number; bad?: boolean }) {
  return n > 0 ? <em className={`cnt${bad ? ' bad' : ''}`}>{n}</em> : null;
}

export function AppShell() {
  const overview = useQuery(q.overview()).data, client = useQueryClient(), navigate = useNavigate();
  const counts = { pending: overview?.pending.length ?? 0, incidents: overview?.incidents.length ?? 0, alerts: overview?.alerts.length ?? 0 };

  const logout = async () => {
    await post('/api/logout').catch(() => undefined);
    client.clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app">
      <nav className="side" aria-label="Navigasi utama">
        <div className="logo"><Logo size={24} title="" /><span>AI Ops Pribadi</span></div>
        {NAV.map(({ to, label, icon: Icon, badge }) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon size={16} aria-hidden /><span>{label}</span>{badge && <Count n={counts[badge]} bad={badge !== 'pending'} />}
          </NavLink>
        ))}
        <button type="button" className="navlink" onClick={logout}><IconLock size={16} aria-hidden /><span>Keluar</span></button>
      </nav>
      <main aria-live="polite"><Outlet /></main>
    </div>
  );
}
