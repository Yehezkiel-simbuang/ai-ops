import { screen, within } from '@testing-library/react';
import type { PatchOverview, PatchRow } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { PatchingPanel } from './PatchingPanel';

afterEach(() => vi.unstubAllGlobals());

const row = (id: number, over: Partial<PatchRow> = {}): PatchRow => ({ server_id: id, name: `srv-${id}`, os: 'Ubuntu 22.04', kernel: '5.15', reported: Date.now() - 60_000, stale: false, updates: 3, security: 0, reboot: false, reboot_days: null, eol_days: 900, level: null, reasons: [], ...over });
const ov = (rows: PatchRow[], without_agent = 0): PatchOverview => ({ rows, without_agent });

describe('Pembaruan sistem', () => {
  it('yang paling parah di atas, dengan alasan, dan terbuka sendiri bila ada yang mendesak', async () => {
    mockApi({ 'GET /api/maintenance/patching': { body: ov([
      row(1, { level: 'minor', security: 1, reasons: [{ level: 'minor', text: '1 paket dengan pembaruan keamanan menunggu' }] }),
      row(2, { level: 'critical', security: 40, reboot: true, reboot_days: 60, eol_days: -30, reasons: [{ level: 'critical', text: 'Ubuntu 16.04 sudah berakhir dukungannya 30 hari lalu' }, { level: 'major', text: 'reboot diminta 60 hari lalu' }] }),
      row(3)
    ], 2) } });
    renderWithProviders(<PatchingPanel />);
    const grid = await screen.findByRole('table', { name: 'Pembaruan sistem per server' });
    expect(screen.getByText('Pembaruan sistem').closest('details')).toHaveAttribute('open'); expect(screen.getByText('2 perlu perhatian, 1 mendesak')).toBeInTheDocument();
    const names = within(grid).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1]!.textContent);
    expect(names[0]).toContain('srv-2'); expect(names[1]).toContain('srv-1'); expect(names[2]).toContain('srv-3');
    expect(within(grid).getByText('Ubuntu 16.04 sudah berakhir dukungannya 30 hari lalu')).toBeInTheDocument(); expect(within(grid).getByText('menunggu 60 hari')).toBeInTheDocument(); expect(within(grid).getByText('berakhir 30 hari lalu')).toBeInTheDocument();
    expect(screen.getByText(/2 server belum punya agen yang melapor/)).toBeInTheDocument();
  });

  it('semua aman: terlipat dan menyebut semua aman; jumlah tidak diketahui tampil sebagai strip, bukan nol', async () => {
    mockApi({ 'GET /api/maintenance/patching': { body: ov([row(1, { updates: null, security: null, eol_days: null })]) } });
    renderWithProviders(<PatchingPanel />);
    await screen.findByRole('table', { name: 'Pembaruan sistem per server' });
    expect(screen.getByText('Pembaruan sistem').closest('details')).not.toHaveAttribute('open'); expect(screen.getByText('semua aman')).toBeInTheDocument(); expect(screen.getByText('tidak dinilai')).toBeInTheDocument();
  });

  it('belum ada agen yang melapor: penjelasan cara memasang; gagal dimuat: tidak menampilkan apa pun', async () => {
    mockApi({ 'GET /api/maintenance/patching': { body: ov([], 3) } });
    const { unmount } = renderWithProviders(<PatchingPanel />);
    expect(await screen.findByText('belum ada agen yang melapor')).toBeInTheDocument(); expect(screen.getByText(/Pasang agen di server/)).toBeInTheDocument();
    unmount(); vi.unstubAllGlobals();
    mockApi({ 'GET /api/maintenance/patching': { status: 500, body: { error: 'gagal' } } });
    renderWithProviders(<PatchingPanel />);
    await new Promise((r) => setTimeout(r, 50)); expect(screen.queryByText('Pembaruan sistem')).not.toBeInTheDocument();
  });
});
