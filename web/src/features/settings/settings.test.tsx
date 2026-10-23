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
