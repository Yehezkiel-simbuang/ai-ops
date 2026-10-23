import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import type { AppConfig } from '@/api/types';
import { ChannelsPanel } from './ChannelsPanel';
import { ProvidersPanel } from './ProvidersPanel';
import { SettingsPage } from './SettingsPage';

afterEach(() => vi.unstubAllGlobals());

const config: AppConfig = {
  providers: { lain: { label: 'Lain', type: 'openai', baseUrl: 'https://api.contoh.com/v1', hasKey: true, keyHint: '****abc', keyless: false } },
  roles: {}, prices: {}, presets: []
};

describe('ProvidersPanel', () => {
  it('formulir tidak tampil di halaman; tombol Tambah penyedia membuka modal, Batal menutupnya', async () => {
    renderWithProviders(<ProvidersPanel config={config} />);
    expect(screen.queryByRole('heading', { name: /Tambah penyedia/ })).not.toBeInTheDocument();   // belum ada formulir di halaman
    await userEvent.click(screen.getByRole('button', { name: 'Tambah penyedia' }));
    const dlg = (await screen.findByRole('heading', { name: /Tambah penyedia/ })).closest('dialog')!;
    expect(dlg).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Tambah penyedia/ })).not.toBeInTheDocument());
  });
  it('menyimpan dari modal mengirim muatan lalu menutup modal; Ubah membuka modal berisi data penyedia', async () => {
    const calls = mockApi({ 'POST /api/provider': { body: { ok: true } } });
    renderWithProviders(<ProvidersPanel config={config} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ubah Lain' }));
    expect(await screen.findByRole('heading', { name: 'Ubah Lain' })).toBeInTheDocument(); expect(screen.getByDisplayValue('https://api.contoh.com/v1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/provider')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ id: 'lain', baseUrl: 'https://api.contoh.com/v1' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ubah Lain' })).not.toBeInTheDocument());
  });
});

describe('ChannelsPanel', () => {
  const base = { 'GET /api/channels': { body: [] }, 'GET /api/notifications': { body: [] }, 'GET /api/settings': { body: { reminder_min: 60, notify_runs: false, auto_report: false } } };
  it('formulir kanal ada di modal, bukan di halaman; menambah kanal menutup modal', async () => {
    const calls = mockApi({ ...base, 'POST /api/channels': { body: { id: 1 } } });
    renderWithProviders(<ChannelsPanel />);
    expect(await screen.findByText(/Belum ada kanal/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tambah kanal' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Tambah kanal' }));
    const heading = await screen.findByRole('heading', { name: 'Tambah kanal' }), dlg = heading.closest('dialog')!;
    await userEvent.type(within(dlg).getByLabelText(/Token bot/i), '123:abc'); await userEvent.type(within(dlg).getByLabelText(/Chat ID/i), '42');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Tambah kanal' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/channels')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Tambah kanal' })).not.toBeInTheDocument());
  });
});

describe('ChannelsPanel: tingkat dan jam tenang', () => {
  const base = { 'GET /api/channels': { body: [] }, 'GET /api/notifications': { body: [] }, 'GET /api/settings': { body: { reminder_min: 60, notify_runs: false, auto_report: false, quiet_on: false, quiet_start: 22, quiet_end: 7 } } };
  it('kanal baru bawaannya Major; pilihan tingkat memakai istilah Info, Minor, Major, Critical dan mengirim nilai yang dipilih', async () => {
    const calls = mockApi({ ...base, 'POST /api/channels': { body: { id: 1 } } });
    renderWithProviders(<ChannelsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tambah kanal' }));
    const dlg = (await screen.findByRole('heading', { name: 'Tambah kanal' })).closest('dialog')!, level = within(dlg).getByRole('combobox', { name: /Kirim mulai tingkat/ }) as HTMLSelectElement;
    expect(level.value).toBe('major'); expect([...level.options].map((o) => o.value)).toEqual(['major', 'critical', 'minor', 'info']);
    await userEvent.selectOptions(level, 'critical'); await userEvent.type(within(dlg).getByLabelText(/Token bot/i), '123:abc'); await userEvent.type(within(dlg).getByLabelText(/Chat ID/i), '42');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Tambah kanal' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/channels')).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ min_level: 'critical' });
  });
  it('jam tenang untuk Major: kolom jam hanya muncul bila dinyalakan, dan perubahan dikirim ke server', async () => {
    const calls = mockApi({ ...base, 'POST /api/settings': { body: {} } });
    renderWithProviders(<ChannelsPanel />);
    const toggle = await screen.findByRole('checkbox', { name: 'Jam tenang untuk Major' }); expect(screen.queryByLabelText('Jam tenang mulai')).not.toBeInTheDocument();
    await userEvent.click(toggle); await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/settings')).toBe(true));
    expect(calls.find((c) => c.path === '/api/settings' && c.method === 'POST')!.body).toEqual({ quiet_on: true });
  });
  it('dengan jam tenang menyala, jam mulai dan selesai tampil dan disimpan saat selesai diisi', async () => {
    const on = { ...base, 'GET /api/settings': { body: { reminder_min: 60, notify_runs: false, auto_report: false, quiet_on: true, quiet_start: 22, quiet_end: 7 } }, 'POST /api/settings': { body: {} } };
    const calls = mockApi(on);
    renderWithProviders(<ChannelsPanel />);
    const start = await screen.findByLabelText('Jam tenang mulai'); expect(start).toHaveValue(22); expect(screen.getByLabelText('Jam tenang selesai')).toHaveValue(7);
    await userEvent.clear(start); await userEvent.type(start, '23'); await userEvent.tab();
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && (c.body as { quiet_start?: number }).quiet_start === 23)).toBe(true));
  });
});

describe('SettingsPage: tab', () => {
  const api = { 'GET /api/config': { body: config }, 'GET /api/usage?days=30': { body: { days: 30, total: { input: 0, output: 0, calls: 0, cost: 0, costKnown: false }, byRole: {}, byModel: {}, byDay: {} } }, 'GET /api/settings': { body: { reminder_min: 60, notify_runs: false, auto_report: false } }, 'GET /api/channels': { body: [] }, 'GET /api/notifications': { body: [] }, 'GET /api/audit': { body: [{ ts: Date.now(), actor: 'admin', action: 'login', detail: '1.2.3.4' }] } };
  it('bawaannya tab Model AI; tab lain tidak ikut tampil sampai dipilih', async () => {
    mockApi(api);
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: /Model per peran/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Model AI' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument(); expect(screen.queryByRole('heading', { name: /Notifikasi ke Anda/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Notifikasi' }));
    expect(await screen.findByText(/Notifikasi ke Anda/)).toBeInTheDocument(); expect(screen.queryByRole('heading', { name: /Model per peran/ })).not.toBeInTheDocument();
  });
  it('?tab=akun membuka Akun dan keamanan, termasuk tombol ganti password', async () => {
    mockApi(api);
    renderWithProviders(<SettingsPage />, { route: '/pengaturan?tab=akun' });
    expect(await screen.findByRole('button', { name: 'Ganti password' })).toBeInTheDocument(); expect(screen.getByRole('tab', { name: 'Akun dan keamanan' })).toHaveAttribute('aria-selected', 'true');
  });
  it('tab Jejak audit menampilkan catatan', async () => {
    mockApi(api);
    renderWithProviders(<SettingsPage />, { route: '/pengaturan?tab=audit' });
    expect(await screen.findByText('1.2.3.4')).toBeInTheDocument();
  });
});
