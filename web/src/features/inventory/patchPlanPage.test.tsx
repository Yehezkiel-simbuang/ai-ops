import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { PatchPlan, RecStep } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { PatchPlanPage } from './PatchPlanPage';

afterEach(() => vi.unstubAllGlobals());

const step = (n: number, title: string, cls: RecStep['class'], command: string, over: Partial<RecStep> = {}): RecStep => ({ id: n, n, title, command, class: cls, risk: 'rendah', rationale: '', rollback: '', status: 'pending', stdout: '', stderr: '', exit_code: null, via: null, ...over });
const plan = (over: Partial<PatchPlan> = {}): PatchPlan => ({
  id: 12, kind: 'patch', title: 'Patch srv-1: 2 paket', status: 'proposed', source: 'playbook', diagnosis: '2 paket akan diperbarui (2 keamanan).\nRestart tidak ikut dalam rencana ini.', summary: '', verify_out: '', resolved_after: false, updated: Date.now(), server_id: 1, server_name: 'srv-1', path: 'ssh',
  meta: { packages: [{ name: 'openssl', old: '1', new: '2', sec: true, official: true, cves: ['CVE-2024-0001'], exploited: ['CVE-2024-0001'], impact: 'Pustaka inti.' }, { name: 'docker-ce', old: '1', new: '2', sec: false, official: false, cves: [], exploited: [], impact: null }], restarts: ['web server'], reboot: true, totals: { packages: 2, security: 1, cves: 1, exploited: 1, thirdParty: 1 } },
  steps: [step(1, 'Cek ruang disk', 'read', 'df -h'), step(2, 'Perbarui daftar paket', 'change', 'sudo -n apt-get update'), step(3, 'Pasang 2 pembaruan terpilih', 'change', 'sudo -n apt-get install -y --only-upgrade openssl docker-ce', { risk: 'sedang', rollback: 'apt-get install -y --allow-downgrades openssl=1' })], ...over
});
const page = () => renderWithProviders(<Routes><Route path="/patch/:id" element={<PatchPlanPage />} /></Routes>, { route: '/patch/12' });

describe('PatchPlanPage', () => {
  it('menampilkan dampak (paket, CVE, dieksploitasi, restart, reboot) dan langkah yang menunggu persetujuan', async () => {
    mockApi({ 'GET /api/patch-plans/12': { body: plan() } });
    page();
    expect(await screen.findByRole('heading', { name: 'Patch srv-1: 2 paket' })).toBeInTheDocument();
    expect(screen.getAllByText('2 paket').length).toBeGreaterThan(0); expect(screen.getByText('1 sedang dieksploitasi')).toBeInTheDocument(); expect(screen.getByText('kemungkinan restart: web server')).toBeInTheDocument(); expect(screen.getByText('kemungkinan perlu reboot')).toBeInTheDocument(); expect(screen.getByText('1 dari repositori pihak ketiga')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rencana patch #12' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Susun ulang/ })).not.toBeInTheDocument();   // rencana patch tidak punya "susun ulang insiden"
    expect(screen.getByText('belum bisa dicek')).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'CVE-2024-0001' })).toHaveAttribute('href', 'https://nvd.nist.gov/vuln/detail/CVE-2024-0001');
    expect(screen.getByText(/Pasang 2 pembaruan terpilih/)).toBeInTheDocument(); expect(screen.getByText(/apt-get install -y --only-upgrade openssl docker-ce/)).toBeInTheDocument(); expect(screen.getByText(/Pembatalan: apt-get install -y --allow-downgrades openssl=1/)).toBeInTheDocument();
  });

  it('menyetujui meminta konfirmasi yang menyebut jumlah langkah yang MENGUBAH sistem; batal tidak mengirim apa pun', async () => {
    const calls = mockApi({ 'GET /api/patch-plans/12': { body: plan() }, 'POST /api/recommendations/12/approve': { body: { ok: true } } });
    page();
    await userEvent.click(await screen.findByRole('button', { name: /Setujui dan jalankan \(3 langkah\)/ }));
    expect(await screen.findByText(/2 di antaranya MENGUBAH sistem/)).toBeInTheDocument(); expect(screen.getByText(/di srv-1 lewat SSH dari aplikasi/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Batal' })); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: /Setujui dan jalankan/ }));
    const ok = (await screen.findAllByRole('button', { name: 'Setujui dan jalankan' })).find((b) => b.closest('dialog')?.hasAttribute('open'))!; await userEvent.click(ok);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/recommendations/12/approve')).toBe(true));
    expect(calls.find((c) => c.path === '/api/recommendations/12/approve')!.body).toEqual({ steps: [1, 2, 3] });
  });

  it('tanpa jalur eksekusi tombol terkunci; yang sudah selesai menampilkan ringkasan dan tidak bisa disetujui lagi', async () => {
    mockApi({ 'GET /api/patch-plans/12': { body: plan({ path: 'none' }) } });
    const { unmount } = page();
    expect(await screen.findByRole('button', { name: /Setujui dan jalankan/ })).toBeDisabled(); expect(screen.getByText(/Belum ada jalur eksekusi/)).toBeInTheDocument();
    unmount(); vi.unstubAllGlobals();
    mockApi({ 'GET /api/patch-plans/12': { body: plan({ status: 'done', summary: '6 langkah dijalankan via ssh.', steps: plan().steps.map((s) => ({ ...s, status: 'done' as const, exit_code: 0 })) }) } });
    page();
    expect(await screen.findByText(/6 langkah dijalankan via ssh/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Setujui dan jalankan/ })).not.toBeInTheDocument();
  });
});
