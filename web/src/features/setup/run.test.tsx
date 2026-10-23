import { screen } from '@testing-library/react';
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
