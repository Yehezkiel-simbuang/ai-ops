import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PatchDetail, PatchOverview, PatchRow } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { PatchingPanel } from './PatchingPanel';

afterEach(() => vi.unstubAllGlobals());

const row = (id: number, over: Partial<PatchRow> = {}): PatchRow => ({ patched_at: null, server_id: id, name: `srv-${id}`, os: 'Ubuntu 22.04', kernel: '5.15', reported: Date.now() - 60_000, stale: false, updates: 3, security: 0, reboot: false, reboot_days: null, eol_days: 900, cves: null, exploited: 0, vuln_unknown: 0, level: null, reasons: [], ...over });
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

  it('kolom kerentanan: jumlah CVE, yang dieksploitasi, dan paket yang belum bisa dicek; "-" bila belum dicocokkan', async () => {
    mockApi({ 'GET /api/maintenance/patching': { body: ov([row(1, { level: 'critical', cves: 3, exploited: 1, vuln_unknown: 2, reasons: [{ level: 'critical', text: '1 CVE di daftar CISA KEV' }] }), row(2)]) } });
    renderWithProviders(<PatchingPanel />);
    const grid = await screen.findByRole('table', { name: 'Pembaruan sistem per server' });
    expect(within(grid).getByText(/3 CVE/)).toBeInTheDocument(); expect(within(grid).getByText('1 dieksploitasi')).toBeInTheDocument(); expect(within(grid).getByText('2 paket belum bisa dicek')).toBeInTheDocument();
  });

  it('klik baris membuka rincian: paket keamanan dengan CVE (ditautkan), yang dieksploitasi ditandai, dan sumber yang tidak terjangkau dijelaskan', async () => {
    const detail: PatchDetail = { patched_at: null, plan: null, name: 'srv-1', os: 'Ubuntu 24.04 LTS', reported: Date.now(), ecosystem: 'Ubuntu:24.04:LTS', supported: true, matched_at: Date.now() - 60_000, kev_at: Date.now(), total: 4, packages: [
      { name: 'liblzma5', source: 'xz-utils', old: '5.6.1-3', new: '5.6.1-4', sec: true, cves: ['CVE-2024-0001'], ids: ['USN-1'], exploited: ['CVE-2024-0001'], unknown: false, external: false },
      { name: 'curl', old: '8.5-1', new: '8.5-2', sec: false, cves: [], ids: [], exploited: [], unknown: false, external: false },
      { name: 'zlib1g', source: 'zlib', old: '1', new: '2', sec: true, cves: [], ids: [], exploited: [], unknown: true, external: false }, { name: 'docker-ce', old: '1', new: '2', sec: false, cves: [], ids: [], exploited: [], unknown: false, external: true }] };
    mockApi({ 'GET /api/maintenance/patching': { body: ov([row(1, { level: 'critical', cves: 1, exploited: 1 })]) }, 'GET /api/servers/1/patching': { body: detail } });
    renderWithProviders(<PatchingPanel />);
    await userEvent.click((await screen.findByText('srv-1')).closest('tr')!);
    const dlg = (await screen.findByRole('heading', { name: 'Pembaruan srv-1' })).closest('dialog')!;
    const link = within(dlg).getByRole('link', { name: 'CVE-2024-0001' }); expect(link).toHaveAttribute('href', 'https://nvd.nist.gov/vuln/detail/CVE-2024-0001'); expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(dlg).getAllByText('dieksploitasi')).toHaveLength(1); expect(within(dlg).getByText('sumber: xz-utils')).toBeInTheDocument();
    expect(within(dlg).getByText('belum bisa dicek (sumber tidak terjangkau)')).toBeInTheDocument(); expect(within(dlg).getByText('repositori pihak ketiga: belum bisa dicek')).toBeInTheDocument(); expect(within(dlg).getByText('tidak ada yang tercatat')).toBeInTheDocument();
    const names = within(dlg).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1]!.textContent); expect(names[0]).toContain('liblzma5');
  });

  it('distro yang belum didukung: rincian tetap menampilkan daftar paket dengan penjelasan, tanpa menuduh "tidak ada kerentanan"', async () => {
    const detail: PatchDetail = { patched_at: null, plan: null, name: 'srv-1', os: 'Alpine', reported: Date.now(), ecosystem: null, supported: false, matched_at: null, kev_at: null, total: 1, packages: [{ name: 'busybox', old: '1', new: '2', sec: false, cves: [], ids: [], exploited: [], unknown: false, external: false }] };
    mockApi({ 'GET /api/maintenance/patching': { body: ov([row(1)]) }, 'GET /api/servers/1/patching': { body: detail } });
    renderWithProviders(<PatchingPanel />);
    await userEvent.click((await screen.findByText('srv-1')).closest('tr')!);
    expect(await screen.findByText(/belum mendukung OS ini/)).toBeInTheDocument(); expect(screen.queryByText('tidak ada yang tercatat')).not.toBeInTheDocument();
  });
});
