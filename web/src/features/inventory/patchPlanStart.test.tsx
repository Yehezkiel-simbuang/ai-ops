import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { PatchDetail, PatchOverview, PatchRow } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { PatchingPanel } from './PatchingPanel';

afterEach(() => vi.unstubAllGlobals());

const row = (over: Partial<PatchRow> = {}): PatchRow => ({ patched_at: null, server_id: 1, name: 'srv-1', os: 'Ubuntu 24.04', kernel: '6.8', reported: Date.now() - 60_000, stale: false, updates: 3, security: 2, reboot: false, reboot_days: null, eol_days: 900, cves: 1, exploited: 1, vuln_unknown: 0, level: 'critical', reasons: [], ...over });
const ov = (rows: PatchRow[]): PatchOverview => ({ rows, without_agent: 0 });
const detail = (over: Partial<PatchDetail> = {}): PatchDetail => ({ patched_at: null, plan: null, name: 'srv-1', os: 'Ubuntu 24.04 LTS', reported: Date.now(), ecosystem: 'Ubuntu:24.04:LTS', supported: true, matched_at: Date.now(), kev_at: Date.now(), total: 3, packages: [
  { name: 'openssl', old: '1', new: '2', sec: true, cves: ['CVE-2024-0001'], ids: [], exploited: ['CVE-2024-0001'], unknown: false, external: false },
  { name: 'nginx', old: '1', new: '2', sec: true, cves: [], ids: [], exploited: [], unknown: false, external: false },
  { name: 'curl', old: '1', new: '2', sec: false, cves: [], ids: [], exploited: [], unknown: false, external: false }], ...over });

describe('menyiapkan rencana patch dari rincian', () => {
  it('paket keamanan terpilih lebih dulu; mengubah pilihan mengubah jumlah; tombol hanya menyusun rencana dan membuka halamannya', async () => {
    const calls = mockApi({ 'GET /api/maintenance/patching': { body: ov([row()]) }, 'GET /api/servers/1/patching': { body: detail() }, 'POST /api/servers/1/patch-plan': { body: { id: 9 } } });
    renderWithProviders(<Routes><Route path="/" element={<PatchingPanel />} /><Route path="/patch/:id" element={<div>halaman rencana</div>} /></Routes>);
    await userEvent.click((await screen.findByText('srv-1')).closest('tr')!);
    const dlg = (await screen.findByRole('heading', { name: 'Pembaruan srv-1' })).closest('dialog')!;
    expect(within(dlg).getByRole('checkbox', { name: 'Pilih openssl' })).toBeChecked(); expect(within(dlg).getByRole('checkbox', { name: 'Pilih nginx' })).toBeChecked(); expect(within(dlg).getByRole('checkbox', { name: 'Pilih curl' })).not.toBeChecked();
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Pilih nginx' })); await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Pilih curl' }));
    const btn = within(dlg).getByRole('button', { name: 'Siapkan rencana patch (2 paket)' }); expect(within(dlg).getByText(/Tidak ada yang dijalankan di server sebelum Anda menyetujuinya/)).toBeInTheDocument();
    await userEvent.click(btn);
    expect(await screen.findByText('halaman rencana')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/servers/1/patch-plan')!.body).toEqual({ packages: ['openssl', 'curl'] });
  });

  it('tanpa pilihan tombol terkunci; distro yang belum didukung tidak punya kotak pilih maupun tombol rencana', async () => {
    mockApi({ 'GET /api/maintenance/patching': { body: ov([row()]) }, 'GET /api/servers/1/patching': { body: detail() } });
    const { unmount } = renderWithProviders(<PatchingPanel />);
    await userEvent.click((await screen.findByText('srv-1')).closest('tr')!);
    let dlg = (await screen.findByRole('heading', { name: 'Pembaruan srv-1' })).closest('dialog')!;
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Pilih openssl' })); await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Pilih nginx' }));
    expect(within(dlg).getByRole('button', { name: 'Siapkan rencana patch (0 paket)' })).toBeDisabled();
    unmount(); vi.unstubAllGlobals();
    mockApi({ 'GET /api/maintenance/patching': { body: ov([row()]) }, 'GET /api/servers/1/patching': { body: detail({ supported: false }) } });
    renderWithProviders(<PatchingPanel />);
    await userEvent.click((await screen.findByText('srv-1')).closest('tr')!);
    dlg = (await screen.findByRole('heading', { name: 'Pembaruan srv-1' })).closest('dialog')!;
    expect(within(dlg).queryByRole('checkbox')).not.toBeInTheDocument(); expect(within(dlg).queryByRole('button', { name: /Siapkan rencana patch/ })).not.toBeInTheDocument();
  });
});
