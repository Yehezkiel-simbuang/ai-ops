import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import { WebChecksPage, certDays } from './WebChecksPage';
import type { WebCheck } from './types';

afterEach(() => vi.unstubAllGlobals());

const check = (over: Partial<WebCheck> = {}): WebCheck => ({
  id: 1, kind: 'http', has_token: false, name: 'Toko', url: 'https://tokoku.com/', interval_s: 60, timeout_ms: 10000, expect_status: 0, slow_ms: 2000, confirm: 2, enabled: true, last_status: 'sehat', last_title: 'Sehat', last_detail: '200 dalam 120 ms',
  last_code: 200, last_ms: 120, last_run: Date.now() - 30_000, cert_expires: Date.now() + 40.5 * 864e5, uptime24h: 99.9, avgMs24h: 140, samples24h: 1400, ...over
});

describe('WebChecksPage', () => {
  it('menampilkan status, uptime, kecepatan rata-rata, dan sisa sertifikat; yang bermasalah menyebut alasannya', async () => {
    mockApi({ 'GET /api/webchecks': { body: [check(), check({ id: 2, name: 'API', last_status: 'kritis', last_title: 'Status 500', last_detail: 'Status 500 dianggap error.', cert_expires: null, uptime24h: 80 })] } });
    renderWithProviders(<WebChecksPage />);
    expect(await screen.findByText('Toko')).toBeInTheDocument();
    expect(screen.getByText(/uptime 24 jam 99.9% \| rata-rata 140 ms/)).toBeInTheDocument(); expect(screen.getByText(/sertifikat 40 hari lagi/)).toBeInTheDocument();
    expect(screen.getByText('Sehat', { selector: '.badge' })).toBeInTheDocument(); expect(screen.getByText('Bermasalah')).toBeInTheDocument(); expect(screen.getByText(/Status 500 \(Status 500 dianggap error\.\)/)).toBeInTheDocument();
  });
  it('kosong: ada arahan; tombol Tambah terkunci sampai nama dan alamat http(s) valid, lalu mengirim muatan', async () => {
    const calls = mockApi({ 'GET /api/webchecks': { body: [] }, 'POST /api/webchecks': { body: { id: 3 } } });
    renderWithProviders(<WebChecksPage />);
    expect(await screen.findByText(/Belum ada layanan/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Tambah layanan' }));
    const add = await screen.findByRole('button', { name: 'Tambah' });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Toko online'), 'Situs saya'); await userEvent.type(screen.getByPlaceholderText('https://tokoku.com'), 'tokoku.com');
    expect(add).toBeDisabled();   // tanpa skema
    await userEvent.clear(screen.getByPlaceholderText('https://tokoku.com')); await userEvent.type(screen.getByPlaceholderText('https://tokoku.com'), 'https://tokoku.com');
    expect(add).toBeEnabled(); await userEvent.click(add);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/webchecks')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ kind: 'http', name: 'Situs saya', url: 'https://tokoku.com', interval_s: 60, slow_ms: 2000, confirm: 2 });
  });
  it('jeda mengirim PATCH enabled=false; yang dijeda berlabel Dijeda; hapus meminta konfirmasi', async () => {
    const calls = mockApi({ 'GET /api/webchecks': { body: [check()] }, 'PATCH /api/webchecks/1': { body: {} }, 'DELETE /api/webchecks/1': { body: { ok: true } } });
    renderWithProviders(<WebChecksPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Jeda Toko' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Hapus Toko' })); await userEvent.click(await screen.findByRole('button', { name: 'Batal' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
  it('certDays: sisa hari, negatif bila lewat, null bila tidak diketahui', () => {
    const now = 1_000_000_000_000;
    expect(certDays({ cert_expires: now + 5 * 864e5 }, now)).toBe(5); expect(certDays({ cert_expires: now - 864e5 }, now)).toBe(-1); expect(certDays({ cert_expires: null }, now)).toBeNull();
  });
});

describe('jenis Vercel', () => {
  it('formulir Vercel meminta proyek dan token, interval minimal 300, dan mengirim muatan tanpa URL', async () => {
    const calls = mockApi({ 'GET /api/webchecks': { body: [] }, 'POST /api/webchecks': { body: { id: 4 } } });
    renderWithProviders(<WebChecksPage />);
    await screen.findByText(/Belum ada layanan/);
    await userEvent.click(screen.getByRole('button', { name: 'Tambah layanan' }));
    await userEvent.type(await screen.findByPlaceholderText('Toko online'), 'Toko Vercel');
    await userEvent.selectOptions(screen.getByLabelText('Jenis pemantauan'), 'vercel');
    expect(screen.queryByPlaceholderText('https://tokoku.com')).not.toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Tambah' });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('tokoku'), 'tokoku'); await userEvent.type(screen.getByLabelText('Token akses Vercel'), 'vercel-token-panjang');
    expect(add).toBeEnabled(); expect(screen.getByLabelText('Periksa tiap (detik)')).toHaveValue(300);
    await userEvent.click(add);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ kind: 'vercel', name: 'Toko Vercel', interval_s: 300, confirm: 2, vercel: { token: 'vercel-token-panjang', project: 'tokoku' } });
  });
  it('baris Vercel menampilkan proyek, bukan URL palsu, dan tanpa rata-rata ms', async () => {
    mockApi({ 'GET /api/webchecks': { body: [check({ id: 7, kind: 'vercel', has_token: true, name: 'Toko Vercel', url: 'vercel:tokoku', cert_expires: null, avgMs24h: 90 })] } });
    renderWithProviders(<WebChecksPage />);
    expect(await screen.findByText('Vercel: tokoku')).toBeInTheDocument(); expect(screen.getByText(/pemeriksaan sehat 24 jam 99.9%/)).toBeInTheDocument(); expect(screen.queryByText(/rata-rata/)).not.toBeInTheDocument();
  });
});
