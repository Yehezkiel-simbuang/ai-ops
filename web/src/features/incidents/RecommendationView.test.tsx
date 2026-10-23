import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import type { Incident, RecStep, Recommendation } from '@/api/types';
import { RecommendationView } from './RecommendationView';

const incident: Incident = { id: 7, title: 'Disk penuh', detail: '/ 97%', server_name: 'srv-db', opened: Date.now(), status: 'open', event_count: 1, rec_status: 'proposed' };
const step = (n: number, over: Partial<RecStep>): RecStep => ({
  id: n, n, title: `Langkah ${n}`, command: `cmd-${n}`, class: 'read', risk: 'rendah', rationale: '', rollback: '', status: 'pending', stdout: '', stderr: '', exit_code: null, via: null, ...over
});
const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  id: 3, status: 'proposed', source: 'playbook', diagnosis: 'Disk hampir penuh', summary: '', verify_out: '', resolved_after: false, updated: 1,
  steps: [step(1, {}), step(2, { class: 'change', risk: 'sedang' }), step(3, { class: 'blocked', status: 'blocked' }), step(4, { status: 'done' })], ...over
});

afterEach(() => vi.unstubAllGlobals());

describe('RecommendationView', () => {
  it('hanya langkah yang boleh dijalankan yang terpilih; langkah diblokir/selesai terkunci', () => {
    renderWithProviders(<RecommendationView incident={incident} rec={rec()} path="ssh" />);
    expect(screen.getByRole('button', { name: /Setujui dan jalankan \(2 langkah\)/ })).toBeEnabled();
    expect(screen.getByLabelText('Pilih langkah 3')).toBeDisabled();
    expect(screen.getByLabelText('Pilih langkah 4')).toBeDisabled();
    expect(screen.getByLabelText('Pilih langkah 1')).toBeChecked();
  });

  it('menyetujui hanya langkah terpilih setelah konfirmasi eksplisit', async () => {
    const calls = mockApi({ 'POST /api/recommendations/3/approve': { body: { ok: true } } });
    renderWithProviders(<RecommendationView incident={incident} rec={rec()} path="agent" />);
    await userEvent.click(screen.getByLabelText('Pilih langkah 1'));      // buang langkah baca
    await userEvent.click(screen.getByRole('button', { name: /Setujui dan jalankan \(1 langkah\)/ }));
    const dialog = await screen.findByText(/MENGUBAH sistem/);
    expect(dialog).toHaveTextContent('srv-db');
    expect(dialog).toHaveTextContent('agen di server');
    expect(calls.some((c) => c.path.includes('/approve'))).toBe(false);   // belum ada yang dijalankan sebelum konfirmasi
    await userEvent.click(within(dialog.closest('dialog')!).getByRole('button', { name: 'Setujui dan jalankan' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/recommendations/3/approve')?.body).toEqual({ steps: [2] }));
  });

  it('membatalkan konfirmasi tidak mengirim apa pun', async () => {
    const calls = mockApi({});
    renderWithProviders(<RecommendationView incident={incident} rec={rec()} path="ssh" />);
    await userEvent.click(screen.getByRole('button', { name: /Setujui dan jalankan \(2 langkah\)/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Batal' }));
    expect(calls).toHaveLength(0);
  });

  it('tanpa jalur eksekusi, tombol setujui dimatikan dan ada petunjuk', () => {
    renderWithProviders(<RecommendationView incident={incident} rec={rec()} path="none" />);
    expect(screen.getByRole('button', { name: /Setujui dan jalankan/ })).toBeDisabled();
    expect(screen.getByText(/Belum ada jalur eksekusi/)).toBeInTheDocument();
  });

  it('rekomendasi yang sedang berjalan tidak bisa diubah pilihannya', () => {
    renderWithProviders(<RecommendationView incident={incident} rec={rec({ status: 'executing' })} path="ssh" />);
    expect(screen.getByLabelText('Pilih langkah 1')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Setujui dan jalankan/ })).not.toBeInTheDocument();
  });
});
