import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '@/App';
import { mockApi } from '@/test/utils';
import { passwordRules } from './ChangePassword';
import type { Overview } from '@/api/types';

const OVERVIEW: Overview = {
  servers: [], pending: [], incidents: [], recsWaiting: 0, maintenance: { overdue: 0, soon: 0 }, rotationDue: 0, runs: [], alerts: [], setupReady: true, monitorReady: true,
  usage: { input: 0, output: 0, calls: 0, cost: 0, costKnown: false }
};

function renderApp(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
}

afterEach(() => vi.unstubAllGlobals());

describe('autentikasi', () => {
  it('tanpa sesi, halaman terlindungi mengarahkan ke formulir masuk', async () => {
    mockApi({ 'GET /api/me': { status: 401, body: { error: 'Belum masuk' } } });
    renderApp('/inventaris');
    expect(await screen.findByLabelText('Pengguna')).toBeInTheDocument();
    expect(screen.queryByText('Inventaris')).not.toBeInTheDocument();
  });

  it('login berhasil membuka Ringkasan', async () => {
    const calls = mockApi({
      'GET /api/me': { status: 401, body: { error: 'Belum masuk' } },
      'POST /api/login': { body: { ok: true, user: { id: 1, username: 'admin' } } },
      'GET /api/overview': { body: OVERVIEW }
    });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('Pengguna'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'password-panjang-123');
    await userEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(await screen.findByRole('heading', { name: 'Ringkasan' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/login')!.body).toEqual({ username: 'admin', password: 'password-panjang-123' });
    expect(screen.getByRole('navigation', { name: 'Navigasi utama' })).toBeInTheDocument();
  });

  it('login salah menampilkan pesan dari server dan tetap di formulir', async () => {
    mockApi({
      'GET /api/me': { status: 401, body: { error: 'Belum masuk' } },
      'POST /api/login': { status: 401, body: { error: 'Pengguna atau password salah' } }
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Pengguna'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'salah-salah');
    await userEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pengguna atau password salah');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Masuk' })).toBeEnabled());
  });
});

describe('wajib ganti password awal', () => {
  it('selama password awal belum diganti, hanya halaman ganti password yang tampil (tanpa menu)', async () => {
    mockApi({ 'GET /api/me': { body: { user: { id: 1, username: 'admin', mustChange: true } } } });
    renderApp('/server');
    expect(await screen.findByRole('heading', { name: 'Ganti password awal' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Navigasi utama' })).not.toBeInTheDocument(); expect(screen.queryByText('Inventaris')).not.toBeInTheDocument();
  });
  it('tombol terkunci sampai semua syarat terpenuhi; lalu mengirim dan kembali ke halaman masuk', async () => {
    const calls = mockApi({ 'GET /api/me': { body: { user: { id: 1, username: 'admin', mustChange: true } } }, 'POST /api/account/password': { body: { ok: true } } });
    renderApp('/');
    const btn = await screen.findByRole('button', { name: 'Ganti password' });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Password saat ini/), '123456');
    await userEvent.type(screen.getByLabelText('Password baru'), '123456');   // sama dengan password awal
    await userEvent.type(screen.getByLabelText('Ulangi password baru'), '123456');
    expect(btn).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Password baru')); await userEvent.type(screen.getByLabelText('Password baru'), 'password-baru-yang-panjang');
    expect(btn).toBeDisabled();   // pengulangan belum cocok
    await userEvent.clear(screen.getByLabelText('Ulangi password baru')); await userEvent.type(screen.getByLabelText('Ulangi password baru'), 'password-baru-yang-panjang');
    expect(btn).toBeEnabled(); await userEvent.click(btn);
    await waitFor(() => expect(calls.find((c) => c.path === '/api/account/password')?.body).toEqual({ current: '123456', next: 'password-baru-yang-panjang' }));
    expect(await screen.findByLabelText('Pengguna')).toBeInTheDocument();   // kembali ke formulir masuk
  });
  it('syarat ditandai satu per satu', () => {
    expect(passwordRules('123456', 'pendek', 'pendek').map((r) => r.ok)).toEqual([false, true, true, true]);
    expect(passwordRules('123456', '123456', '123456').map((r) => r.ok)).toEqual([false, false, false, true]);
    expect(passwordRules('lama-lama-lama', 'baru-baru-baru-baru', 'beda').map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(passwordRules('x', 'baru-baru-baru-baru', 'baru-baru-baru-baru').every((r) => r.ok)).toBe(true);
  });
  it('pengguna biasa (tanpa kewajiban) langsung masuk ke aplikasi', async () => {
    mockApi({ 'GET /api/me': { body: { user: { id: 1, username: 'admin', mustChange: false } } }, 'GET /api/overview': { body: OVERVIEW } });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Ringkasan' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ganti password awal' })).not.toBeInTheDocument();
  });
});
