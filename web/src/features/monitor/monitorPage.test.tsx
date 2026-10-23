import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { Alert, Check, Level, MonitorView, Server } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { MonitorPage } from './MonitorPage';
import { summarize } from './health';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const server = (over: Partial<Server> = {}): Server => ({ id: 1, name: 'srv-a', host: '10.0.0.1', port: 22, username: 'ops', key_path: '', has_ssh_key: true, ssh_pub: '', playground: false, use_sudo: false, services: '', notes: '', monitor_on: true, monitor_every: 60, exec_via: 'ssh', os_info: 'Ubuntu 24.04', last_seen: NOW, last_status: 'ok', open_alerts: 0, ...over } as Server);
const check = (id: number, over: Partial<Check> = {}): Check => ({ id, name: `cek-${id}`, type: 'systemd', pack: 'mysql', enabled: true, warn: null, crit: null, last_status: 'ok', last_detail: 'normal', last_value: null, last_run: NOW, ...over });
const alert = (id: number, over: Partial<Alert> = {}): Alert => ({ id, title: `alert-${id}`, detail: 'rinci', level: 'major', ts: NOW, resolved: false, acked: false, ...over });
const view = (over: Partial<MonitorView> = {}): MonitorView => ({ server: server(), latest: {}, alerts: [], reports: [], checks: [check(1)], series: { load5: [{ ts: NOW, value: 1 }], mem_avail_pct: [], disk_root_pct: [], io_psi10: [], swap_used_mb: [] }, ...over });
const lv = (level: Level, id = 1): Alert => alert(id, { level, title: `${level}-${id}` });

describe('summarize', () => {
  it('sehat: tanpa masalah dan ada data', () => {
    expect(summarize(view())).toMatchObject({ verdict: 'ok', headline: 'Sehat', urgent: [], minor: [], info: [], counts: { ok: 1, crit: 0, major: 0, minor: 0, off: 0 } });
  });
  it('belum ada data bila tidak ada metrik dan pemeriksaan belum pernah jalan', () => {
    expect(summarize(view({ series: { load5: [], mem_avail_pct: [], disk_root_pct: [], io_psi10: [], swap_used_mb: [] }, checks: [check(1, { last_run: null, last_status: null })] })).verdict).toBe('nodata');
  });
  it('tidak terjangkau mengalahkan semuanya dan menjadi masalah pertama', () => {
    const s = summarize(view({ server: server({ last_status: 'tidak terjangkau' }), alerts: [lv('critical')] }));
    expect(s.verdict).toBe('down'); expect(s.urgent[0]).toMatchObject({ kind: 'down', level: 'critical' });
  });
  it('empat tingkat dipisah: Critical dan Major perlu ditangani, Minor lihat kalau sempat, Info hanya jejak', () => {
    const s = summarize(view({ alerts: [lv('info', 1), lv('minor', 2), lv('major', 3), lv('critical', 4)], checks: [] }));
    expect(s.urgent.map((p) => p.level)).toEqual(['critical', 'major']); expect(s.minor.map((p) => p.level)).toEqual(['minor']); expect(s.info.map((p) => p.level)).toEqual(['info']); expect(s.verdict).toBe('crit');
  });
  it('urutan di dalam satu tingkat: yang belum dilihat sebelum yang sudah, lalu yang terbaru; peringatan selesai masuk riwayat', () => {
    const s = summarize(view({ alerts: [alert(1, { ts: 1 }), alert(2, { acked: true }), alert(3), alert(4, { resolved: true })], checks: [] }));
    expect(s.urgent.map((p) => p.id)).toEqual(['a3', 'a1', 'a2']); expect(s.history.map((a) => a.id)).toEqual([4]);
  });
  it('vonis menurut tingkat tertinggi: Major = perlu perhatian; hanya Minor = tetap sehat dengan catatan; tanpa urgent tidak kuning atau merah', () => {
    expect(summarize(view({ alerts: [lv('major')] }))).toMatchObject({ verdict: 'warn', headline: 'Perlu perhatian' });
    expect(summarize(view({ alerts: [lv('minor')] }))).toMatchObject({ verdict: 'ok', headline: 'Sehat', detail: expect.stringContaining('1 Minor') });
    expect(summarize(view({ alerts: [lv('info')] })).verdict).toBe('ok');
  });
  it('pemeriksaan yang sudah jadi peringatan tidak ditampilkan dua kali; status warn = Major, crit = Critical, minor = Minor; yang dimatikan diabaikan', () => {
    const s = summarize(view({ alerts: [alert(1, { title: 'cek-1' })], checks: [check(1, { last_status: 'warn' }), check(2, { last_status: 'crit' }), check(3, { last_status: 'crit', enabled: false }), check(4, { last_status: 'minor' }), check(5, { last_status: 'unknown' })] }));
    expect(s.urgent.map((p) => [p.title, p.level, !!p.unconfirmed])).toEqual([['cek-2', 'critical', true], ['cek-1', 'major', false]]);
    expect(s.minor.map((p) => p.title).sort()).toEqual(['cek-4', 'cek-5']); expect(s.counts).toMatchObject({ crit: 1, major: 1, minor: 2, off: 1 });
  });
});

describe('MonitorPage', () => {
  const render = (d: MonitorView) => {
    mockApi({ 'GET /api/servers': { body: [server()] }, 'GET /api/servers/1/monitor': { body: d }, 'GET /api/checks/meta': { body: { packs: [{ id: 'mysql', label: 'MySQL', fields: [] }], types: [] } } });
    renderWithProviders(<Routes><Route path="/monitor/:id" element={<MonitorPage />} /></Routes>, { route: '/monitor/1' });
  };

  it('vonis dan masalah tampil di depan, urut dari yang paling mendesak, dengan lencana tingkat; rincian dilipat', async () => {
    render(view({ alerts: [alert(1, { title: 'Disk 90%' }), alert(2, { level: 'critical', title: 'Disk penuh' })], checks: [check(1), check(2, { pack: 'redis' })] }));
    expect(await screen.findByRole('heading', { name: 'Critical' })).toBeInTheDocument();
    const panel = screen.getByRole('heading', { name: 'Perlu ditangani (2)' }).closest('section')!; const titles = within(panel).getAllByText(/Disk penuh|Disk 90%/).map((e) => e.textContent);
    expect(titles).toEqual(['Disk penuh', 'Disk 90%']); expect(within(panel).getByText('Critical')).toBeInTheDocument(); expect(within(panel).getByText('Major')).toBeInTheDocument();
    for (const name of ['Pemeriksaan layanan di dalam server', 'Riwayat peringatan', 'Laporan AI']) expect(screen.getByText(name).closest('details')).not.toHaveAttribute('open');
  });

  it('Minor dan Info ada di bagian lipat sendiri, tidak bercampur dengan yang perlu ditangani', async () => {
    render(view({ alerts: [lv('minor', 1), lv('info', 2)] }));
    expect(await screen.findByRole('heading', { name: 'Sehat' })).toBeInTheDocument(); expect(screen.getByText('Tidak ada yang perlu ditangani sekarang.')).toBeInTheDocument();
    const minor = screen.getByText('Minor', { selector: 'summary b' }).closest('details')!, info = screen.getByText('Info', { selector: 'summary b' }).closest('details')!;
    expect(minor).not.toHaveAttribute('open'); expect(within(minor).getByText('minor-1')).toBeInTheDocument(); expect(within(info).getByText('info-2')).toBeInTheDocument();
  });

  it('server sehat: vonis hijau dan pesan tenang, tanpa daftar masalah', async () => {
    render(view());
    expect(await screen.findByRole('heading', { name: 'Sehat' })).toBeInTheDocument(); expect(screen.getByText('Tidak ada yang perlu ditangani sekarang.')).toBeInTheDocument();
  });

  it('tanpa pemeriksaan, bagian pemeriksaan terbuka supaya tombol tambah terlihat', async () => {
    render(view({ checks: [] }));
    await screen.findByRole('heading', { name: /Kondisi|Sehat|Belum ada data/ }); expect(screen.getByText('Pemeriksaan layanan di dalam server').closest('details')).toHaveAttribute('open');
  });
});
