import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { mockApi, renderWithProviders } from '@/test/utils';
import type { RunCommand, RunDetail, RunThought } from '@/api/types';
import { RunPage, turns } from './RunPage';

afterEach(() => vi.unstubAllGlobals());

const cmd = (id: number, ts: number, over: Partial<RunCommand> = {}): RunCommand => ({ id, ts, command: `perintah-${id}`, purpose: `tujuan-${id}`, reason: '', class: 'read', status: 'done', exit_code: 0, stdout: '', stderr: '', decided_by: 'agen', ...over });
const thought = (ts: number, text: string, over: Partial<RunThought> = {}): RunThought => ({ ts, thought: text, command: '', done: false, summary: '', ...over });
const detail = (commands: RunCommand[], thoughts: RunThought[], status = 'waiting_approval'): RunDetail => ({
  run: { id: 'r1', name: 'Proses uji', status, goal: 'g', summary: '', server_name: 'srv', steps: [], updated: 0, tokens: 0, token_budget: 1000, turns: 1, max_turns: 30 } as RunDetail['run'], commands, thoughts
});

describe('turns', () => {
  it('terbaru di atas; catatan menempel pada perintah sesudahnya; ringkasan akhir berdiri sendiri dan paling atas', () => {
    const t = turns({ commands: [cmd(1, 20), cmd(2, 40)], thoughts: [thought(10, 'catatan-1'), thought(30, 'catatan-2'), thought(50, '', { done: true, summary: 'beres' })] });
    expect(t.map((x) => [x.thought?.thought || x.thought?.summary || '', x.command?.id ?? 0])).toEqual([['beres', 0], ['catatan-2', 2], ['catatan-1', 1]]);
  });
  it('catatan kosong diabaikan; catatan tanpa perintah sesudahnya tetap tampil; tanpa apa pun menghasilkan kosong', () => {
    expect(turns({ commands: [], thoughts: [thought(1, '')] })).toEqual([]);
    expect(turns({ commands: [cmd(1, 5)], thoughts: [thought(9, 'menunggu')] }).map((x) => x.thought?.thought ?? x.command?.command)).toEqual(['menunggu', 'perintah-1']);
  });
});

describe('anggaran run', () => {
  const page = (status: string, over: Record<string, number>) => {
    const d = detail([], [], status); Object.assign(d.run, over);
    const calls = mockApi({ 'GET /api/runs/r1': { body: d }, 'POST /api/runs/r1/budget': { body: d.run }, 'POST /api/runs/r1/start': { body: d.run } });
    renderWithProviders(<Routes><Route path="/setup/:id" element={<RunPage />} /></Routes>, { route: '/setup/r1' });
    return calls;
  };

  it('mendekati batas saat berjalan: ada peringatan dan tombol tambah anggaran', async () => {
    const calls = page('running', { tokens: 850, token_budget: 1000 });
    expect(await screen.findByText(/Anggaran hampir habis/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Tambah 20 giliran/ }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/runs/r1/budget')?.body).toEqual({ addTurns: 20, addTokens: 150000 }));
  });

  it('di bawah 80 persen tidak ada peringatan', async () => {
    page('running', { tokens: 500, token_budget: 1000, turns: 3, max_turns: 30 });
    await screen.findByText('Rencana'); expect(screen.queryByText(/Anggaran hampir habis/)).not.toBeInTheDocument();
  });

  it('berhenti karena anggaran habis: dijelaskan bukan gagal, dan Lanjutkan menambah anggaran lalu memulai', async () => {
    const calls = page('stopped', { turns: 30, max_turns: 30 });
    expect(await screen.findByText(/berhenti karena anggaran habis, bukan karena gagal/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Lanjutkan/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/runs/r1/budget', '/api/runs/r1/start']));
  });

  it('dihentikan pengguna sebelum habis: tetap Jalankan lagi tanpa tambahan', async () => {
    page('stopped', { turns: 3, max_turns: 30 });
    expect(await screen.findByRole('button', { name: 'Jalankan lagi' })).toBeInTheDocument(); expect(screen.queryByText(/anggaran habis/)).not.toBeInTheDocument();
  });
});

describe('RunPage', () => {
  it('perintah yang menunggu persetujuan (paling baru) muncul paling atas, di atas riwayat yang sudah selesai', async () => {
    mockApi({ 'GET /api/runs/r1': { body: detail([cmd(1, 20), cmd(2, 40, { status: 'pending_approval', class: 'change', exit_code: null, decided_by: null })], [thought(10, 'catatan-1'), thought(30, 'catatan-2')]) } });
    const { container } = renderWithProviders(<Routes><Route path="/setup/:id" element={<RunPage />} /></Routes>, { route: '/setup/r1' });
    expect(await screen.findByText('Perlu persetujuan')).toBeInTheDocument();
    const text = (container.querySelector('.tl') as HTMLElement).textContent!;
    expect(text.indexOf('Perlu persetujuan')).toBeLessThan(text.indexOf('perintah-1'));   // persetujuan sebelum riwayat
    expect(text.indexOf('catatan-2')).toBeLessThan(text.indexOf('perintah-2')); expect(text.indexOf('perintah-2')).toBeLessThan(text.indexOf('catatan-1'));   // catatan tetap sebelum perintahnya, giliran terbaru dulu
    expect(screen.getByText(/Terbaru di atas/)).toBeInTheDocument();
  });
});
