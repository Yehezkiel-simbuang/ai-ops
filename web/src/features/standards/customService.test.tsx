import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServicesPanel, type TryResult } from '@/features/monitor/ServicesPanel';
import { mockApi, renderWithProviders } from '@/test/utils';
import { StandardsPage, type Standards } from './StandardsPage';

afterEach(() => vi.unstubAllGlobals());

const scan = { services: [{ unit: 'mysql', pack: 'mysql', noise: false }, { unit: 'foo-agent', pack: null, noise: false }, { unit: 'ssh', pack: null, noise: true }], ports: [] };
const tried: TryResult = { command: 'x', exitCode: 0, ms: 5, timedOut: false, stdout: '7\n', stderr: '', evaluation: { status: 'ok', value: 7, detail: '' } };

describe('Tambahkan ke standar', () => {
  it('hanya layanan yang belum punya paket dan bukan layanan sistem yang ditawari', async () => {
    mockApi({ 'GET /api/servers/1/scan': { body: scan } });
    renderWithProviders(<ServicesPanel serverId={1} existing={[]} onClose={() => undefined} />);
    expect(await screen.findAllByRole('button', { name: 'Tambahkan ke standar' })).toHaveLength(1); expect(screen.getByText('belum ada di standar')).toBeInTheDocument();
  });

  it('hidup atau mati saja: tersimpan sebagai standar baru dan langsung dipasang di server ini', async () => {
    const calls = mockApi({ 'GET /api/servers/1/scan': { body: scan }, 'POST /api/standards/packs': { body: { pack: { id: 'custom-foo-agent' }, added: ['foo-agent: layanan aktif'] } } });
    const done = vi.fn(); renderWithProviders(<ServicesPanel serverId={1} existing={[]} onClose={done} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tambahkan ke standar' }));
    await userEvent.clear(screen.getByLabelText('Nama layanan')); await userEvent.type(screen.getByLabelText('Nama layanan'), 'Foo Agent');
    await userEvent.click(screen.getByRole('button', { name: /Simpan ke standar dan pasang di server ini \(1\)/ }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls.find((c) => c.path === '/api/standards/packs')!.body).toEqual({ unit: 'foo-agent', label: 'Foo Agent', serverId: 1, checks: [{ name: 'foo-agent: layanan aktif', type: 'systemd', params: { unit: 'foo-agent' }, confirm: 2 }] });
  });

  it('pemeriksaan tambahan harus Dicoba dulu; masuk daftar dengan judulnya dan ikut tersimpan; bisa dibuang', async () => {
    const calls = mockApi({ 'GET /api/servers/1/scan': { body: scan }, 'POST /api/servers/1/checks/try': { body: tried }, 'POST /api/standards/packs': { body: { pack: {}, added: [] } } });
    renderWithProviders(<ServicesPanel serverId={1} existing={[]} onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tambahkan ke standar' }));
    expect(screen.getByRole('button', { name: 'Tambahkan ke daftar' })).toBeDisabled();   // belum dicoba
    await userEvent.type(screen.getByLabelText('Judul pemeriksaan'), 'antrean'); await userEvent.type(screen.getByLabelText('Perintah pemeriksaan'), 'cat /proc/loadavg | cut -d" " -f1');
    await userEvent.type(screen.getByLabelText('Ambang peringatan'), '5'); await userEvent.type(screen.getByLabelText('Ambang kritis'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Coba' })); await screen.findByText(/nilai terbaca: 7/);
    await userEvent.click(screen.getByRole('button', { name: 'Tambahkan ke daftar' })); expect(screen.getByText('foo-agent: antrean')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Simpan ke standar dan pasang di server ini \(2\)/ }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/standards/packs')).toBe(true));
    expect((calls.find((c) => c.path === '/api/standards/packs')!.body as { checks: unknown[] }).checks[1]).toEqual({ name: 'foo-agent: antrean', type: 'custom', params: { command: 'cat /proc/loadavg | cut -d" " -f1' }, warn: 5, crit: 10, confirm: 2 });
  });
});

describe('Standar: pengelompokan', () => {
  it('layanan umum dan aplikasi/khusus proyek dipisah dengan judul sendiri; kelompok tanpa isi tidak ditampilkan', async () => {
    const pack = (id: string, label: string, category?: 'umum' | 'aplikasi') => ({ id, label, category, checks: [] });
    mockApi({ 'GET /api/standards': { body: { base: [], packs: [pack('mysql', 'MySQL', 'umum'), pack('laravel', 'Aplikasi Laravel', 'aplikasi'), pack('redis', 'Redis')] } } });
    renderWithProviders(<StandardsPage />);
    const umum = (await screen.findByRole('heading', { name: 'Layanan umum' })).closest('section')!, app = screen.getByRole('heading', { name: 'Aplikasi dan khusus proyek' }).closest('section')!;
    expect(within(umum).getByText('MySQL')).toBeInTheDocument(); expect(within(umum).getByText('Redis')).toBeInTheDocument(); expect(within(umum).queryByText('Aplikasi Laravel')).not.toBeInTheDocument(); expect(within(app).getByText('Aplikasi Laravel')).toBeInTheDocument();
  });
  it('tanpa paket aplikasi, judul "Aplikasi dan khusus proyek" tidak muncul', async () => {
    mockApi({ 'GET /api/standards': { body: { base: [], packs: [{ id: 'mysql', label: 'MySQL', checks: [] }] } } });
    renderWithProviders(<StandardsPage />); await screen.findByRole('heading', { name: 'Layanan umum' }); expect(screen.queryByRole('heading', { name: 'Aplikasi dan khusus proyek' })).not.toBeInTheDocument();
  });
});

describe('Standar: layanan buatan sendiri', () => {
  const data: Standards = {
    base: [],
    packs: [
      { id: 'mysql', label: 'MySQL / MariaDB', checks: [] },
      { id: 'custom-foo-agent', label: 'Foo Agent', custom: true, unit: 'foo-agent', checks: [{ key: 'pack:custom-foo-agent:foo-agent: layanan aktif', name: 'foo-agent: layanan aktif', typeLabel: 'Layanan systemd aktif', unit: 'nilai', dir: 'gt', numeric: false, warn: null, crit: null, confirm: 2, default: { warn: null, crit: null, confirm: 2 }, custom: false, stats: null, servers: 1 }] }
    ]
  };

  it('ditandai buatan sendiri dan bisa dihapus setelah konfirmasi; paket bawaan tidak punya tombol hapus', async () => {
    const calls = mockApi({ 'GET /api/standards': { body: data }, 'DELETE /api/standards/packs/custom-foo-agent': { body: { ok: true } } });
    renderWithProviders(<StandardsPage />);
    expect(await screen.findByText('buatan sendiri')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Hapus MySQL / MariaDB dari standar' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hapus Foo Agent dari standar' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Hapus' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/standards/packs/custom-foo-agent')).toBe(true));
  });
});
