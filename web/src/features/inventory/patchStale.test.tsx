import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PatchDetail, PatchOverview, PatchRow } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { PatchingPanel } from './PatchingPanel';

afterEach(() => vi.unstubAllGlobals());

const HOUR = 3_600_000;
const row = (over: Partial<PatchRow> = {}): PatchRow => ({ patched_at: null, server_id: 1, name: 'srv-1', os: 'Ubuntu 24.04', kernel: '6.8', reported: Date.now() - 3 * HOUR, stale: false, updates: 53, security: 0, reboot: false, reboot_days: null, eol_days: 900, cves: 0, exploited: 0, vuln_unknown: 0, level: 'minor', reasons: [{ level: 'minor', text: '53 paket bisa diperbarui' }], ...over });
const ov = (r: PatchRow): PatchOverview => ({ rows: [r], without_agent: 0 });
const detail = (patched_at: number | null): PatchDetail => ({ patched_at, plan: null, name: 'srv-1', os: 'Ubuntu 24.04 LTS', reported: Date.now() - 3 * HOUR, ecosystem: 'Ubuntu:24.04:LTS', supported: true, matched_at: Date.now(), kev_at: Date.now(), total: 1, packages: [{ name: 'curl', old: '1', new: '2', sec: false, cves: [], ids: [], exploited: [], unknown: false, external: false }] });

describe('daftar patch yang mungkin sudah usang', () => {
  it('selalu menyebut kapan agen melapor; bila patch diterapkan sesudah laporan, ditandai bahwa daftar belum diperbarui', async () => {
    mockApi({ 'GET /api/maintenance/patching': { body: ov(row({ patched_at: Date.now() - HOUR })) } });
    renderWithProviders(<PatchingPanel />);
    await screen.findByText('srv-1'); expect(screen.getByText(/dilaporkan 3 jam lalu/)).toBeInTheDocument(); expect(screen.getByText('patch diterapkan, daftar belum diperbarui')).toBeInTheDocument();
  });

  it('tanpa patch sesudah laporan tidak ada tanda; laporan yang lama diberi keterangan', async () => {
    mockApi({ 'GET /api/maintenance/patching': { body: ov(row({ stale: true })) } });
    renderWithProviders(<PatchingPanel />);
    await screen.findByText('srv-1'); expect(screen.queryByText('patch diterapkan, daftar belum diperbarui')).not.toBeInTheDocument(); expect(screen.getByText(/\(lama\)/)).toBeInTheDocument();
  });

  it('rincian menjelaskan selisihnya dan Minta laporan ulang mengirim permintaan ke server', async () => {
    const calls = mockApi({ 'GET /api/maintenance/patching': { body: ov(row({ patched_at: Date.now() - HOUR })) }, 'GET /api/servers/1/patching': { body: detail(Date.now() - HOUR) }, 'POST /api/servers/1/patch-refresh': { body: { ok: true, online: true } } });
    renderWithProviders(<PatchingPanel />);
    await userEvent.click((await screen.findByText('srv-1')).closest('tr')!);
    const dlg = (await screen.findByRole('heading', { name: 'Pembaruan srv-1' })).closest('dialog')!;
    expect(within(dlg).getByText(/Patch diterapkan 1 jam lalu, tetapi daftar ini dari laporan agen 3 jam lalu/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Minta laporan ulang' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/servers/1/patch-refresh')).toBe(true));
  });
});
