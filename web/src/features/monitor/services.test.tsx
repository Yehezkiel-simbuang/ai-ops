import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import { ChecksPanel } from './ChecksPanel';
import { ServicesPanel, activeCheckName, type TryResult } from './ServicesPanel';

afterEach(() => vi.unstubAllGlobals());

const scan = { services: [{ unit: 'mysql', pack: 'mysql', noise: false }, { unit: 'kafka', pack: null, noise: false }, { unit: 'aplikasi-kustom', pack: null, noise: false }, { unit: 'ssh', pack: null, noise: true }], ports: [3306, 5672] };
const tried = (status: string, value: number | null, stdout = '42\n', exitCode = 0): TryResult => ({ command: 'x', exitCode, ms: 5, timedOut: false, stdout, stderr: '', evaluation: { status, value, detail: '' } });

describe('ServicesPanel', () => {
  it('menampilkan layanan hasil pemindaian termasuk yang tanpa paket; layanan sistem tersembunyi sampai diminta; bisa dicari', async () => {
    mockApi({ 'GET /api/servers/1/scan': { body: scan } });
    renderWithProviders(<ServicesPanel serverId={1} existing={[]} onClose={() => undefined} />);
    expect(await screen.findByLabelText('Pantau kafka')).toBeInTheDocument(); expect(screen.getByText('paket mysql')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pantau ssh')).not.toBeInTheDocument(); expect(screen.getByText(/4 layanan berjalan \| port: 3306, 5672/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'tampilkan layanan sistem' })); expect(screen.getByLabelText('Pantau ssh')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Cari layanan'), 'kaf'); expect(screen.queryByLabelText('Pantau mysql')).not.toBeInTheDocument(); expect(screen.getByLabelText('Pantau kafka')).toBeInTheDocument();
  });

  it('yang dicentang ditambahkan sebagai pemeriksaan layanan aktif; yang sudah dipantau terkunci', async () => {
    const calls = mockApi({ 'GET /api/servers/1/scan': { body: scan }, 'POST /api/servers/1/checks': { body: { added: [] } } });
    renderWithProviders(<ServicesPanel serverId={1} existing={[activeCheckName('mysql')]} onClose={() => undefined} />);
    expect(await screen.findByLabelText('Pantau mysql')).toBeDisabled(); expect(screen.getByText('sudah dipantau')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Pantau kafka')); await userEvent.click(screen.getByLabelText('Pantau aplikasi-kustom'));
    await userEvent.click(screen.getByRole('button', { name: /Pantau 2 layanan terpilih/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/servers/1/checks')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { name: 'Layanan kafka aktif', type: 'systemd', params: { unit: 'kafka' }, confirm: 2, pack: 'lain' },
      { name: 'Layanan aplikasi-kustom aktif', type: 'systemd', params: { unit: 'aplikasi-kustom' }, confirm: 2, pack: 'lain' }
    ]);
  });

  it('saran AI: yang ditolak tidak bisa disimpan; yang baca-saja harus Dicoba dulu, dan perintah tanpa angka mengunci Simpan', async () => {
    let attempt = 0;
    const calls = mockApi({
      'GET /api/servers/1/scan': { body: scan },
      'POST /api/servers/1/checks/suggest': { body: { model: 'm', suggestions: [
        { unit: 'kafka', title: 'Antrean Kafka', command: 'kafka-topics.sh --list', why: 'antrean', readOnly: true, problem: '' },
        { unit: 'aplikasi-kustom', title: 'Hapus log', command: 'rm -rf /x', why: '', readOnly: false, problem: 'Ditolak: bukan perintah baca-saja (rm)' }
      ] } },
      'POST /api/servers/1/checks/try': () => ({ body: attempt++ === 0 ? tried('unknown', null, 'Error: unable to connect', 1) : tried('ok', 7, '7\n') }),
      'POST /api/servers/1/checks': { body: { added: [] } }
    });
    renderWithProviders(<ServicesPanel serverId={1} existing={[]} onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Minta saran AI/ }));
    expect(await screen.findByText(/Ini tebakan/)).toBeInTheDocument(); expect(screen.getByText(/Ditolak: bukan perintah baca-saja/)).toBeInTheDocument();
    const box = screen.getByLabelText('Perintah pemeriksaan'), save = screen.getByRole('button', { name: 'Simpan' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Coba' }));
    expect((await screen.findAllByText('Tidak terbaca')).length).toBeGreaterThan(0); expect(screen.getByText(/Error: unable to connect/)).toBeInTheDocument(); expect(save).toBeDisabled();
    await userEvent.clear(box); await userEvent.type(box, 'kafka-topics.sh --list | wc -l'); await userEvent.click(screen.getByRole('button', { name: 'Coba' }));
    expect(await screen.findByText(/nilai terbaca: 7/)).toBeInTheDocument(); await waitFor(() => expect(save).toBeEnabled()); await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/servers/1/checks')).toBe(true));
    expect(calls.find((c) => c.path === '/api/servers/1/checks')!.body).toMatchObject({ name: 'Antrean Kafka', type: 'custom', params: { command: 'kafka-topics.sh --list | wc -l' } });
  });
});

describe('ChecksPanel: kelompok dan ubah perintah', () => {
  const check = (id: number, name: string, over = {}) => ({ id, name, type: 'systemd', enabled: true, warn: null, crit: null, last_status: 'ok', last_detail: '', last_value: null, last_run: Date.now(), ...over });
  it('Hapus kelompok meminta konfirmasi lalu menghapus semua pemeriksaannya; hanya yang kustom punya tombol ubah perintah', async () => {
    const calls = mockApi({ 'GET /api/checks/meta': { body: { packs: [], types: [] } }, 'DELETE /api/checks/1': { body: {} }, 'DELETE /api/checks/2': { body: {} } });
    const { container } = renderWithProviders(<ChecksPanel serverId={1} checks={[check(1, 'MySQL: a', { pack: 'mysql' }), check(2, 'MySQL: b', { pack: 'mysql', type: 'custom', params: { command: 'echo 1' } })] as never} />);
    const g = container.querySelector('details.group') as HTMLElement;
    await userEvent.click(within(g).getByRole('button', { name: 'Hapus kelompok mysql' }));   // langsung dari baris kelompok, tanpa membuka
    // (jsdom membuka kelompok saat tombol di dalam summary diklik; di Chrome asli tidak, sudah diperiksa terpisah)
    await userEvent.click(await screen.findByRole('button', { name: 'Batal' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);   // batal tidak menghapus
    await userEvent.click(within(g).getByText('mysql'));
    expect(within(g).getByRole('button', { name: 'Ubah perintah MySQL: b' })).toBeInTheDocument(); expect(within(g).queryByRole('button', { name: 'Ubah perintah MySQL: a' })).not.toBeInTheDocument();
    await userEvent.click(within(g).getByRole('button', { name: 'Hapus kelompok mysql' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Hapus semuanya' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path).sort()).toEqual(['/api/checks/1', '/api/checks/2']));
  });
});
