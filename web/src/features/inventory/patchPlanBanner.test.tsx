import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PatchDetail, PatchOverview, PatchRow } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { PatchingPanel } from './PatchingPanel';

afterEach(() => vi.unstubAllGlobals());

const row = (): PatchRow => ({ patched_at: null, server_id: 1, name: 'srv-1', os: 'Ubuntu 24.04', kernel: '6.8', reported: Date.now() - 60_000, stale: false, updates: 3, security: 2, reboot: false, reboot_days: null, eol_days: 900, cves: 0, exploited: 0, vuln_unknown: 0, level: 'minor', reasons: [] });
const ov: PatchOverview = { rows: [row()], without_agent: 0 };
const detail = (plan: PatchDetail['plan']): PatchDetail => ({ patched_at: null, plan, name: 'srv-1', os: 'Ubuntu 24.04 LTS', reported: Date.now(), ecosystem: 'Ubuntu:24.04:LTS', supported: true, matched_at: Date.now(), kev_at: Date.now(), total: 1, packages: [{ name: 'curl', old: '1', new: '2', sec: false, cves: [], ids: [], exploited: [], unknown: false, external: false }] });
const open = async (plan: PatchDetail['plan']) => {
  mockApi({ 'GET /api/maintenance/patching': { body: ov }, 'GET /api/servers/1/patching': { body: detail(plan) } });
  renderWithProviders(<PatchingPanel />);
  await userEvent.click((await screen.findByText('srv-1')).closest('tr')!);
  return (await screen.findByRole('heading', { name: 'Pembaruan srv-1' })).closest('dialog')!;
};

describe('rencana patch yang sudah ada, di rincian server', () => {
  it('rencana yang sedang berjalan: ditunjukkan dengan tautan, dan membuat rencana baru dikunci', async () => {
    const dlg = await open({ id: 24, status: 'executing', created: Date.now() });
    expect(within(dlg).getByText(/Rencana patch #24 sedang berjalan di server ini/)).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: 'Buka rencana #24' })).toHaveAttribute('href', '/patch/24');
    expect(within(dlg).getByRole('button', { name: /Siapkan rencana patch/ })).toBeDisabled();
  });

  it('rencana yang menunggu persetujuan: ditunjukkan, dan rencana baru boleh dibuat (menggantikannya)', async () => {
    const dlg = await open({ id: 26, status: 'proposed', created: Date.now() });
    expect(within(dlg).getByText(/Sudah ada rencana patch #26 yang menunggu persetujuan/)).toBeInTheDocument(); expect(within(dlg).getByRole('link', { name: 'Buka rencana #26' })).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: /Siapkan rencana patch/ })).toBeEnabled();
  });

  it('rencana yang gagal disebut gagal; tanpa rencana tidak ada keterangan', async () => {
    const dlg = await open({ id: 23, status: 'failed', created: Date.now() });
    expect(within(dlg).getByText(/Rencana patch #23 terakhir gagal/)).toBeInTheDocument(); expect(within(dlg).getByRole('button', { name: /Siapkan rencana patch/ })).toBeEnabled();
  });
});
