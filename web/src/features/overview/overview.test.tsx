import { screen, within } from '@testing-library/react';
import type { Alert, Overview } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { OverviewPage } from './OverviewPage';
import { fleet, sortAlerts, sortServers } from './summary';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
type S = Overview['servers'][number];
const srv = (id: number, over: Partial<S> = {}): S => ({ id, name: `srv-${id}`, host: `10.0.0.${id}`, last_seen: NOW, open_alerts: 0, status: 'ok', ...over });
const alert = (id: number, over: Partial<Alert> = {}): Alert => ({ id, title: `alert-${id}`, detail: 'rinci', level: 'major', ts: NOW, resolved: false, acked: false, server_name: 'srv-1', ...over });
const overview = (over: Partial<Overview> = {}): Overview => ({
  servers: [srv(1)], pending: [], incidents: [], recsWaiting: 0, maintenance: { overdue: 0, soon: 0 }, rotationDue: 0, runs: [], usage: { input: 10, output: 5, calls: 1, cost: 0, costKnown: true },
  alerts: [], setupReady: true, monitorReady: true, ...over
});

describe('ringkasan seluruh server (logika murni)', () => {
  it('server terburuk di atas: tidak terjangkau, peringatan, belum ada data, lalu sehat; sama berat diurut menurut peringatan lalu nama', () => {
    const list = sortServers([srv(1), srv(2, { status: 'peringatan', open_alerts: 1 }), srv(3, { status: 'tidak terjangkau' }), srv(4, { status: 'belum' }), srv(5, { status: 'peringatan', open_alerts: 3 }), srv(10), srv(6, { open_alerts: 2 })]);
    expect(list.map((s) => s.id)).toEqual([3, 5, 6, 2, 4, 1, 10]);   // server sehat dengan peringatan terbuka (6) dihitung sebagai peringatan
  });
  it('peringatan: tingkat paling parah dulu (Critical, Major, Minor, Info), lalu yang terbaru', () => {
    expect(sortAlerts([alert(1, { ts: 5 }), alert(2, { level: 'critical', ts: 1 }), alert(3, { ts: 9 }), alert(4, { level: 'minor', ts: 99 }), alert(5, { level: 'info', ts: 100 })]).map((a) => a.id)).toEqual([2, 3, 1, 4, 5]);
  });
  it('vonis: tanpa server, tidak terjangkau, Critical (peringatan atau insiden), Major = perlu perhatian, Minor dan Info tidak mengubah vonis, belum ada data, sehat', () => {
    expect(fleet(overview({ servers: [] })).verdict).toBe('nodata');
    expect(fleet(overview({ servers: [srv(1), srv(2, { status: 'tidak terjangkau' })], alerts: [alert(1, { level: 'critical' })] }))).toMatchObject({ verdict: 'down', headline: '1 server tidak terjangkau' });
    expect(fleet(overview({ alerts: [alert(1, { level: 'critical' })] })).verdict).toBe('crit');
    expect(fleet(overview({ incidents: [{ id: 1, severity: 'critical' } as never] })).verdict).toBe('crit'); expect(fleet(overview({ incidents: [{ id: 1, severity: 'major' } as never] })).verdict).toBe('warn');
    expect(fleet(overview({ alerts: [alert(1, { level: 'minor' }), alert(2, { level: 'info' })] })).verdict).toBe('ok');
    expect(fleet(overview({ alerts: [alert(1)] })).verdict).toBe('warn'); expect(fleet(overview({ servers: [srv(1, { status: 'peringatan', open_alerts: 1 })] })).verdict).toBe('warn');
    expect(fleet(overview({ servers: [srv(1, { status: 'belum' })] })).verdict).toBe('nodata'); expect(fleet(overview())).toMatchObject({ verdict: 'ok', headline: 'Semua server sehat' });
  });
});

describe('OverviewPage', () => {
  const render = (o: Overview) => { mockApi({ 'GET /api/overview': { body: o } }); renderWithProviders(<OverviewPage />); };

  it('server sehat dan tanpa tugas: vonis hijau, pesan tenang, tidak ada bagian peringatan', async () => {
    render(overview());
    expect(await screen.findByRole('heading', { name: 'Semua server sehat' })).toBeInTheDocument(); expect(screen.getByText('Tidak ada yang menunggu Anda.')).toBeInTheDocument(); expect(screen.queryByRole('heading', { name: /Peringatan aktif/ })).not.toBeInTheDocument();
  });

  it('urutan: vonis, tindakan Anda, peringatan (kritis dulu, dipotong 8), lalu server terburuk dulu; rincian dilipat', async () => {
    const alerts = Array.from({ length: 10 }, (_, i) => alert(i + 1, { level: i === 9 ? 'critical' : 'major', ts: NOW - i }));
    render(overview({ servers: [srv(1), srv(2, { status: 'peringatan', open_alerts: 2 })], alerts, maintenance: { overdue: 2, soon: 0 } }));
    expect(await screen.findByRole('heading', { name: 'Ada yang Critical' })).toBeInTheDocument();
    const heads = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent); expect(heads.slice(0, 4)).toEqual(['Ada yang Critical', 'Perlu tindakan Anda', 'Peringatan aktif (10)', 'Server']);
    const section = screen.getByRole('heading', { name: 'Peringatan aktif (10)' }).closest('section')!; expect(within(section).getAllByText(/^alert-/)).toHaveLength(8); expect(within(section).getAllByText(/^alert-/)[0]).toHaveTextContent('alert-10');   // kritis pertama
    expect(screen.getByText(/dan 2 lainnya/)).toBeInTheDocument(); expect(screen.getByText(/2 tugas terlambat/)).toBeInTheDocument();
    const names = within(screen.getByRole('heading', { name: 'Server' }).closest('section')!).getAllByText(/^srv-\d$/).map((e) => e.textContent); expect(names).toEqual(['srv-2', 'srv-1']);
    for (const t of ['Setup terbaru', 'Pemakaian AI 7 hari']) expect(screen.getByText(t).closest('details')).not.toHaveAttribute('open');
  });
});
