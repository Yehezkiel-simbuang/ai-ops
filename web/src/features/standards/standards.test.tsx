import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import { scaleOf, zones } from './Meter';
import { StandardsPage, limitProblem, type Row, type Standards } from './StandardsPage';

afterEach(() => vi.unstubAllGlobals());

const stat = { count: 120, min: 10, max: 60, avg: 30, p95: 50, servers: 3 };
const row = (over: Partial<Row>): Row => ({ key: 'x', unit: '%', dir: 'gt', numeric: true, minor: null, warn: 70, crit: 90, confirm: 2, default: { minor: null, warn: 70, crit: 90, confirm: 2 }, custom: false, stats: null, servers: 0, ...over });
const data = (): Standards => ({
  base: [
    row({ key: 'base:disk', label: 'Disk root terpakai', description: 'Persen ruang disk.', min: 0, max: 100, warn: 85, crit: 95, confirm: null, default: { minor: null, warn: 85, crit: 95, confirm: null }, stats: stat, servers: 3 }),
    row({ key: 'base:mem', label: 'Memori tersedia', description: 'Persen memori.', dir: 'lt', min: 0, max: 100, warn: 10, crit: 5, confirm: null, default: { minor: null, warn: 10, crit: 5, confirm: null }, custom: true })
  ],
  packs: [{ id: 'mysql', label: 'MySQL / MariaDB', checks: [
    row({ key: 'pack:mysql:MySQL: koneksi terpakai %', name: 'MySQL: koneksi terpakai %', typeLabel: 'Koneksi MySQL terpakai', stats: stat, servers: 2 }),
    row({ key: 'pack:mysql:MySQL: layanan aktif', name: 'MySQL: layanan aktif', typeLabel: 'Layanan systemd aktif', numeric: false, warn: null, crit: null, confirm: 1, default: { minor: null, warn: null, crit: null, confirm: 1 } })
  ] }]
});
const api = (extra: Record<string, unknown> = {}) => mockApi({ 'GET /api/standards': { body: data() }, ...extra } as never);
const card = (name: string) => screen.getByRole('region', { name });

describe('logika', () => {
  it('limitProblem: urutan menurut arah, rentang, angka, dan wajib isi', () => {
    expect(limitProblem('gt', '70', '90')).toBeNull(); expect(limitProblem('gt', '90', '70')).toMatch(/lebih tinggi/); expect(limitProblem('lt', '10', '5')).toBeNull(); expect(limitProblem('lt', '5', '10')).toMatch(/lebih rendah/);
    expect(limitProblem('gt', '70', '')).toBeNull(); expect(limitProblem('gt', 'abc', '')).toMatch(/angka/); expect(limitProblem('gt', '', '5', { requireWarn: true })).toMatch(/wajib/); expect(limitProblem('gt', '150', '', { min: 0, max: 100 })).toMatch(/antara 0 dan 100/);
  });
  it('zona garis ukur menurut arah bahaya, dan skala memuat ambang, rentang, dan nilai', () => {
    expect(zones('gt', 70, 90, 100).map(([a, b, t]) => `${a}-${b}${t}`)).toEqual(['0-70ok', '70-90warn', '90-100bad']); expect(zones('lt', 10, 5, 100).map(([a, b, t]) => `${a}-${b}${t}`)).toEqual(['0-5bad', '5-10warn', '10-100ok']);
    expect(zones('gt', null, null, 50)).toEqual([[0, 50, 'ok']]); expect(scaleOf(70, 90, stat, 38)).toBeCloseTo(103.5, 5); expect(scaleOf(null, null, null, null)).toBe(1);
  });
});

describe('StandardsPage', () => {
  it('satu halaman global: kartu dasar dan paket, berapa server memakainya, label bawaan atau diubah; yang hidup-mati tidak punya ambang', async () => {
    api(); renderWithProviders(<StandardsPage />);
    expect(await screen.findByRole('region', { name: 'Disk root terpakai' })).toBeInTheDocument(); expect(screen.getAllByText(/semua server/).length).toBeGreaterThan(0);
    expect(within(card('Disk root terpakai')).getByText('bawaan')).toBeInTheDocument(); expect(within(card('Memori tersedia')).getByText('diubah')).toBeInTheDocument();
    expect(within(card('Disk root terpakai')).getByText(/dipakai di 3 server/)).toBeInTheDocument(); expect(within(card('Disk root terpakai')).getByText(/7 hari: min 10, rata-rata 30, p95 50, maks 60 % \(120 sampel\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 dengan ambang, 1 hidup atau mati/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('MySQL / MariaDB'));
    expect(within(card('MySQL: koneksi terpakai %')).getByText(/dipakai di 2 server/)).toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'MySQL: layanan aktif' })).not.toBeInTheDocument();
  });

  it('Simpan terkunci sampai ada perubahan valid; urutan terbalik memunculkan pesan; menyimpan mengirim nilai; pulihkan mengirim reset', async () => {
    const calls = api({ 'PUT /api/standards': { body: data() } });
    renderWithProviders(<StandardsPage />);
    const disk = await screen.findByRole('region', { name: 'Disk root terpakai' }), save = within(disk).getByRole('button', { name: 'Simpan' });
    expect(save).toBeDisabled();
    const warn = within(disk).getByLabelText('Batas Major'), crit = within(disk).getByLabelText('Batas Critical');
    await userEvent.clear(warn); await userEvent.type(warn, '97'); expect(within(disk).getByRole('alert')).toHaveTextContent(/lebih tinggi/); expect(save).toBeDisabled();
    await userEvent.clear(warn); await userEvent.type(warn, '60'); await userEvent.clear(crit); await userEvent.type(crit, '80'); expect(save).toBeEnabled(); await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/standards')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ key: 'base:disk', minor: null, warn: 60, crit: 80, confirm: null });
    await userEvent.click(within(card('Memori tersedia')).getByRole('button', { name: /Pulihkan bawaan/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2)); expect(calls.filter((c) => c.method === 'PUT')[1]!.body).toEqual({ key: 'base:mem', reset: true });
  });

  it('kartu paket punya jumlah konfirmasi dan mengirimnya; kartu dasar tidak', async () => {
    const calls = api({ 'PUT /api/standards': { body: data() } });
    renderWithProviders(<StandardsPage />);
    await userEvent.click(await screen.findByText('MySQL / MariaDB'));
    const c = card('MySQL: koneksi terpakai %'); expect(within(card('Disk root terpakai')).queryByLabelText('Konfirmasi')).not.toBeInTheDocument();
    const conf = within(c).getByLabelText('Konfirmasi'); await userEvent.clear(conf); await userEvent.type(conf, '3'); await userEvent.click(within(c).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(calls.some((x) => x.method === 'PUT')).toBe(true)); expect(calls.find((x) => x.method === 'PUT')!.body).toEqual({ key: 'pack:mysql:MySQL: koneksi terpakai %', minor: null, warn: 70, crit: 90, confirm: 3 });
  });

  it('Buat dengan AI: usulan ditampilkan untuk ditinjau (yang bermasalah terkunci), dan hanya yang dicentang yang disimpan', async () => {
    const calls = api({
      'POST /api/standards/suggest': { body: { model: 'm', withData: 1, total: 8, proposals: [
        { key: 'base:disk', name: 'Disk root terpakai', unit: '%', current: { warn: 85, crit: 95 }, warn: 75, crit: 90, why: 'p95 sekitar 59', problem: '' },
        { key: 'base:io', name: 'Tekanan I/O disk', unit: '%', current: { warn: 20, crit: 50 }, warn: 60, crit: 30, why: '', problem: 'Ambang kritis harus sama atau lebih tinggi dari ambang peringatan' }
      ] } },
      'PUT /api/standards': { body: data() }
    });
    renderWithProviders(<StandardsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Buat dengan AI' })); await userEvent.click(await screen.findByRole('button', { name: 'Minta usulan' }));
    expect(await screen.findByText(/Data cukup untuk 1 dari 8/)).toBeInTheDocument(); expect(screen.getByText('p95 sekitar 59')).toBeInTheDocument();
    expect(screen.getByLabelText('Terapkan Tekanan I/O disk')).toBeDisabled(); expect(screen.getByLabelText('Terapkan Disk root terpakai')).toBeChecked();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);   // belum ada yang tersimpan
    await userEvent.click(screen.getByRole('button', { name: /Terapkan 1 yang dipilih/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)); expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ key: 'base:disk', warn: 75, crit: 90 });
  });
});

describe('tiga batas: Minor, Major, Critical', () => {
  it('limitProblem: Minor opsional, dan urutannya harus makin parah menurut arah', () => {
    expect(limitProblem('gt', '85', '95', { minor: '75' })).toBeNull(); expect(limitProblem('gt', '85', '95', { minor: '' })).toBeNull();
    expect(limitProblem('gt', '85', '95', { minor: '90' })).toMatch(/Major harus sama atau lebih tinggi dari Minor/); expect(limitProblem('gt', '85', '80', { minor: '70' })).toMatch(/Critical harus sama atau lebih tinggi dari Major/);
    expect(limitProblem('lt', '10', '5', { minor: '20' })).toBeNull(); expect(limitProblem('lt', '10', '5', { minor: '8' })).toMatch(/Major harus sama atau lebih rendah dari Minor/);
  });
  it('zones: Minor menambah satu zona di antara aman dan Major, untuk arah naik dan turun; tanpa Minor sama seperti dulu', () => {
    expect(zones('gt', 85, 95, 100, 75).map((z) => z[2])).toEqual(['ok', 'minor', 'warn', 'bad']); expect(zones('gt', 85, 95, 100).map((z) => z[2])).toEqual(['ok', 'warn', 'bad']);
    expect(zones('lt', 10, 5, 100, 20).map((z) => z[2])).toEqual(['bad', 'warn', 'minor', 'ok']); expect(zones('lt', 10, 5, 100).map((z) => z[2])).toEqual(['bad', 'warn', 'ok']);
    expect(zones('gt', 85, 95, 100, 75)[1]).toEqual([75, 85, 'minor']);
  });
  it('kartu: tiga kolom isian; Minor dikirim ke server; Minor di atas Major ditolak dengan pesan', async () => {
    const d: Standards = { base: [row({ key: 'base:disk', label: 'Disk root terpakai', description: 'x', min: 0, max: 100, minor: 75, warn: 85, crit: 95, confirm: null, default: { minor: 75, warn: 85, crit: 95, confirm: null } })], packs: [] };
    const calls = mockApi({ 'GET /api/standards': { body: d }, 'PUT /api/standards': { body: d } });
    renderWithProviders(<StandardsPage />);
    const minor = await screen.findByLabelText('Batas Minor'); expect(screen.getByLabelText('Batas Major')).toHaveValue(85); expect(screen.getByLabelText('Batas Critical')).toHaveValue(95); expect(minor).toHaveValue(75);
    await userEvent.clear(minor); await userEvent.type(minor, '90'); expect(await screen.findByText(/Major harus sama atau lebih tinggi dari Minor/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Simpan' })).toBeDisabled();
    await userEvent.clear(minor); await userEvent.type(minor, '70'); await userEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true)); expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ key: 'base:disk', minor: 70, warn: 85, crit: 95, confirm: null });
  });
});
