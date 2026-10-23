import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { Alert, Check, MonitorView, Server } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { MonitorPage } from './MonitorPage';
import { summarize } from './health';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const server = (over: Partial<Server> = {}): Server => ({ id: 1, name: 'srv-a', host: '10.0.0.1', port: 22, username: 'ops', key_path: '', has_ssh_key: true, ssh_pub: '', playground: false, use_sudo: false, services: '', notes: '', monitor_on: true, monitor_every: 60, exec_via: 'ssh', os_info: 'Ubuntu 24.04', last_seen: NOW, last_status: 'ok', open_alerts: 0, ...over } as Server);
const check = (id: number, over: Partial<Check> = {}): Check => ({ id, name: `cek-${id}`, type: 'systemd', pack: 'mysql', enabled: true, warn: null, crit: null, last_status: 'ok', last_detail: 'normal', last_value: null, last_run: NOW, ...over });
const alert = (id: number, over: Partial<Alert> = {}): Alert => ({ id, title: `alert-${id}`, detail: 'rinci', level: 'peringatan', ts: NOW, resolved: false, acked: false, ...over });
const view = (over: Partial<MonitorView> = {}): MonitorView => ({ server: server(), latest: {}, alerts: [], reports: [], checks: [check(1)], series: { load5: [{ ts: NOW, value: 1 }], mem_avail_pct: [], disk_root_pct: [], io_psi10: [], swap_used_mb: [] }, ...over });

describe('summarize', () => {
  it('sehat: tanpa masalah dan ada data', () => {
    expect(summarize(view())).toMatchObject({ verdict: 'ok', headline: 'Sehat', problems: [], counts: { ok: 1, crit: 0, warn: 0, off: 0 } });
  });
  it('belum ada data bila tidak ada metrik dan pemeriksaan belum pernah jalan', () => {
    expect(summarize(view({ series: { load5: [], mem_avail_pct: [], disk_root_pct: [], io_psi10: [], swap_used_mb: [] }, checks: [check(1, { last_run: null, last_status: null })] })).verdict).toBe('nodata');
  });
  it('tidak terjangkau mengalahkan semuanya dan menjadi masalah pertama', () => {
    const s = summarize(view({ server: server({ last_status: 'tidak terjangkau' }), alerts: [alert(1, { level: 'kritis' })] }));
    expect(s.verdict).toBe('down'); expect(s.problems[0]).toMatchObject({ kind: 'down', level: 'kritis' });
  });
  it('urutan masalah: kritis dulu, yang belum dilihat sebelum yang sudah, lalu yang terbaru; peringatan resolved masuk riwayat, bukan masalah', () => {
    const s = summarize(view({ alerts: [alert(1, { ts: 1 }), alert(2, { level: 'kritis', acked: true }), alert(3, { level: 'kritis' }), alert(4, { resolved: true })], checks: [] }));
    expect(s.problems.map((p) => p.id)).toEqual(['a3', 'a2', 'a1']); expect(s.history.map((a) => a.id)).toEqual([4]); expect(s.verdict).toBe('crit');
  });
  it('pemeriksaan bermasalah yang sudah jadi peringatan tidak ditampilkan dua kali; yang belum dikonfirmasi ditandai; yang dimatikan diabaikan', () => {
    const s = summarize(view({ alerts: [alert(1, { title: 'cek-1' })], checks: [check(1, { last_status: 'warn' }), check(2, { last_status: 'crit' }), check(3, { last_status: 'crit', enabled: false })] }));
    expect(s.problems.map((p) => [p.title, !!p.unconfirmed])).toEqual([['cek-2', true], ['cek-1', false]]); expect(s.counts).toMatchObject({ crit: 1, warn: 1, off: 1 });
  });
  it('hanya peringatan: perlu perhatian, bukan kritis', () => { expect(summarize(view({ alerts: [alert(1)] }))).toMatchObject({ verdict: 'warn', headline: 'Perlu perhatian' }); });
});

describe('MonitorPage', () => {
  const render = (d: MonitorView) => {
    mockApi({ 'GET /api/servers': { body: [server()] }, 'GET /api/servers/1/monitor': { body: d }, 'GET /api/checks/meta': { body: { packs: [{ id: 'mysql', label: 'MySQL', fields: [] }], types: [] } } });
    renderWithProviders(<Routes><Route path="/monitor/:id" element={<MonitorPage />} /></Routes>, { route: '/monitor/1' });
  };

  it('vonis dan masalah tampil di depan, urut dari yang paling mendesak; rincian dilipat', async () => {
    render(view({ alerts: [alert(1), alert(2, { level: 'kritis', title: 'Disk penuh' })], checks: [check(1), check(2, { pack: 'redis' })] }));
    expect(await screen.findByRole('heading', { name: 'Kritis' })).toBeInTheDocument();
    const panel = screen.getByRole('heading', { name: 'Perlu ditangani (2)' }).closest('section')!; const titles = within(panel).getAllByText(/Disk penuh|alert-1/).map((e) => e.textContent);
    expect(titles).toEqual(['Disk penuh', 'alert-1']);
    for (const name of ['Pemeriksaan layanan di dalam server', 'Riwayat peringatan', 'Laporan AI']) expect(screen.getByText(name).closest('details')).not.toHaveAttribute('open');
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
