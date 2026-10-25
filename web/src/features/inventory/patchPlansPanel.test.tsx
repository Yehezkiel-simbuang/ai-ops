import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { PatchPlan, PatchPlanItem, RecStatus } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { PatchPlanPage } from './PatchPlanPage';
import { PatchPlansPanel } from './PatchPlansPanel';

afterEach(() => vi.unstubAllGlobals());

const item = (id: number, status: RecStatus, over: Partial<PatchPlanItem> = {}): PatchPlanItem => ({ id, server_id: 1, server_name: 'srv-uji', title: `Patch srv-uji: ${id} paket`, status, created: Date.now() - 7_200_000, updated: Date.now() - 3_600_000, approved_by: null, packages: 40, security: 0, steps_done: 0, steps_total: 6, summary: '', ...over });

describe('daftar rencana patch', () => {
  it('menampilkan status dengan istilah alurnya: Draf, Berjalan, Selesai, Gagal, Digantikan; yang perlu perhatian di atas dan terbuka sendiri', async () => {
    mockApi({ 'GET /api/patch-plans': { body: [
      item(24, 'done', { approved_by: 'admin', steps_done: 6, updated: Date.now() - 7_000_000 }), item(26, 'superseded'),
      item(28, 'proposed'), item(29, 'executing', { approved_by: 'admin', steps_done: 2 }), item(30, 'failed', { approved_by: 'admin', steps_done: 3, summary: 'Langkah 3 gagal dengan exit 100' })] } });
    renderWithProviders(<Routes><Route path="/" element={<PatchPlansPanel />} /></Routes>);
    const grid = await screen.findByRole('table', { name: 'Rencana patch' });
    expect(screen.getByText('1 berjalan, 1 draf, 1 gagal, 1 selesai')).toBeInTheDocument(); expect(screen.getByText('Rencana patch').closest('details')).toHaveAttribute('open');
    const labels = within(grid).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(labels).toEqual(['Berjalan', 'Draf', 'Gagal', 'Selesai', 'Digantikan']);   // berjalan dulu, lalu draf, gagal, selesai, digantikan
    expect(within(grid).getByText('2 dari 6 langkah')).toBeInTheDocument(); expect(within(grid).getByText('3 dari 6 langkah')).toBeInTheDocument(); expect(within(grid).getByRole('link', { name: '#29 Patch srv-uji: 29 paket' })).toHaveAttribute('href', '/patch/29');
    expect(within(grid).getByText('Langkah 3 gagal dengan exit 100')).toBeInTheDocument();
  });

  it('kemajuan tidak ditampilkan untuk draf; hanya yang sudah selesai terlipat; tanpa rencana apa pun bagian ini tidak tampil', async () => {
    mockApi({ 'GET /api/patch-plans': { body: [item(24, 'done', { steps_done: 6 }), item(25, 'rejected')] } });
    const { unmount } = renderWithProviders(<PatchPlansPanel />);
    const grid = await screen.findByRole('table', { name: 'Rencana patch' });
    expect(screen.getByText('Rencana patch').closest('details')).not.toHaveAttribute('open'); expect(within(grid).getByText('6 dari 6 langkah')).toBeInTheDocument(); expect(within(grid).getByText('Ditolak')).toBeInTheDocument();
    unmount(); vi.unstubAllGlobals();
    mockApi({ 'GET /api/patch-plans': { body: [] } });
    renderWithProviders(<PatchPlansPanel />);
    await new Promise((r) => setTimeout(r, 50)); expect(screen.queryByText('Rencana patch')).not.toBeInTheDocument();
  });
});

describe('halaman rencana: status', () => {
  const plan = (status: RecStatus): PatchPlan => ({ id: 12, kind: 'patch', title: 'Patch srv-1: 2 paket', status, source: 'playbook', diagnosis: 'x', summary: '', verify_out: '', resolved_after: false, updated: Date.now(), server_id: 1, server_name: 'srv-1', path: 'ssh',
    meta: { packages: [], restarts: [], reboot: false, totals: { packages: 2, security: 0, cves: 0, exploited: 0, thirdParty: 0 } }, steps: [] });
  it.each([['proposed', 'Draf', /belum Anda setujui, jadi belum ada yang dijalankan/], ['executing', 'Berjalan', /Anda boleh pindah halaman/], ['done', 'Selesai', /semua langkah yang disetujui sudah dijalankan/], ['failed', 'Gagal', /berhenti di langkah yang gagal/]] as const)('%s: lencana %s dan penjelasannya', async (status, label, text) => {
    mockApi({ 'GET /api/patch-plans/12': { body: plan(status) } });
    renderWithProviders(<Routes><Route path="/patch/:id" element={<PatchPlanPage />} /></Routes>, { route: '/patch/12' });
    expect(await screen.findByText(text)).toBeInTheDocument(); expect(screen.getAllByText(label).length).toBeGreaterThan(0); expect(screen.queryByText('Rekomendasi siap')).not.toBeInTheDocument();
  });
});
