import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import { IncidentsPage } from './IncidentsPage';

const row = (id: number, over: Record<string, unknown> = {}) => ({ id, title: `Insiden ${id}`, detail: 'd', server_name: 'srv-a', opened: Date.now() - 60_000, resolved_at: null, status: 'open', severity: 'critical', event_count: 1, rec_status: null, ...over });
afterEach(() => vi.unstubAllGlobals());

describe('halaman Insiden', () => {
  it('terbuka diberi jumlah dan garis tingkat; yang pulih menampilkan tingkat aslinya dan penanda catatan', async () => {
    mockApi({
      'GET /api/incidents/page?status=open&offset=0&limit=100': { body: { total: 2, rows: [row(1), row(2, { severity: 'major' })] } },
      'GET /api/incidents/page?status=resolved&offset=0&limit=15': { body: { total: 1, rows: [row(3, { status: 'resolved', resolved_at: Date.now(), has_notes: true })] } }
    });
    renderWithProviders(<IncidentsPage />);
    expect(await screen.findByRole('heading', { name: /Terbuka \(2\)/ })).toBeInTheDocument();
    expect((await screen.findByText('Insiden 1')).closest('a')).toHaveClass('accent-critical'); expect(screen.getByText('Insiden 2').closest('a')).toHaveClass('accent-major');
    const done = (await screen.findByText('Insiden 3')).closest('a'); expect(done).toHaveClass('accent-done'); expect(screen.getByText('ada catatan')).toBeInTheDocument(); expect(screen.getByText('pulih')).toBeInTheDocument();
  });
  it('pulih: pencarian dikirim ke server dan halaman berikutnya meminta offset berikutnya', async () => {
    const calls = mockApi({
      'GET /api/incidents/page?status=open&offset=0&limit=100': { body: { total: 0, rows: [] } },
      'GET /api/incidents/page?status=resolved&offset=0&limit=15': { body: { total: 16, rows: Array.from({ length: 15 }, (_, i) => row(100 + i, { status: 'resolved', resolved_at: 1 })) } },
      'GET /api/incidents/page?status=resolved&offset=15&limit=15': { body: { total: 16, rows: [row(200, { status: 'resolved', resolved_at: 1 })] } },
      'GET /api/incidents/page?status=resolved&offset=0&limit=15&q=kabel': { body: { total: 0, rows: [] } }
    });
    renderWithProviders(<IncidentsPage />);
    expect(await screen.findByText('Menampilkan 1 sampai 15 dari 16')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Sebelumnya' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Berikutnya' })); expect(await screen.findByText('Menampilkan 16 sampai 16 dari 16')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Berikutnya' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Cari insiden pulih'), 'kabel');
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('offset=0&limit=15&q=kabel'))).toBe(true)); expect(await screen.findByText('Tidak ada yang cocok.')).toBeInTheDocument();
  });
});
