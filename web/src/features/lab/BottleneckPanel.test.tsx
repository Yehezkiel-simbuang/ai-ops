import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { mockApi, renderWithProviders } from '@/test/utils';
import { BottleneckPanel, analysisKey, ranksOf } from './BottleneckPanel';
import { project } from './fixtures';
import { initialScenario } from './scenario';
import type { BottleneckAnalysis, LabBottlenecks } from './types';

const analysis = (over: Partial<BottleneckAnalysis> = {}): BottleneckAnalysis => ({
  ranking: [
    { node: 'api', label: 'Server API', count: 7, share: 7 / 8, medianMultiple: 4, title: 'Bottleneck: worker Server API habis', text: 'Semua worker terpakai.' },
    { node: 'pg', label: 'Postgres', count: 1, share: 1 / 8, medianMultiple: 8, title: 'Bottleneck: worker tertahan menunggu Postgres', text: 'Percepat query.' }
  ], variations: 8, planned: 8, multiples: [1, 2, 4, 8, 16, 32], complete: true, healthyCount: 0, cappedCount: 0, varied: ['lama tiap panggilan dan CPU per request (x0,5 sampai x2)'], ms: 900, ...over
});
const result = (): LabBottlenecks => ({ baseline: analysis(), experiment: analysis({ ranking: [], healthyCount: 8 }) });

function Host() {
  const [scenario] = useState(() => initialScenario(project, 'now'));
  const [a, setA] = useState<{ key: string; data: LabBottlenecks } | null>(null);
  return <BottleneckPanel project={project} scenario={scenario} analysis={a} onResult={(key, data) => setA({ key, data })} />;
}

afterEach(() => vi.unstubAllGlobals());

describe('BottleneckPanel', () => {
  it('menampilkan temuan dari kode dengan bukti, dan menegaskan bahwa ini bukan ramalan RPM', () => {
    renderWithProviders(<Host />);
    expect(screen.getByText(/Bukan ramalan RPM/)).toBeInTheDocument();
    expect(screen.getByText('Pisahkan pool untuk request berat')).toBeInTheDocument();
    expect(screen.getByText('laporan menahan worker')).toBeInTheDocument();
  });

  it('cari leher botol: menampilkan urutan, keyakinan "n dari m variasi", dan kelipatan beban', async () => {
    const calls = mockApi({ 'POST /api/lab/bottlenecks': { body: result() } });
    renderWithProviders(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Cari leher botol' }));
    expect(await screen.findByText('#1 Server API')).toBeInTheDocument();
    expect(screen.getByText('7 dari 8 variasi')).toBeInTheDocument();
    expect(screen.getByText('4×')).toBeInTheDocument();
    expect(screen.getByText('#2 Postgres')).toBeInTheDocument();
    expect(screen.getByText(/Tidak ada yang jenuh sampai 32× beban dasar/)).toBeInTheDocument();   // eksperimen sehat
    expect(screen.getByText(/bukan hasil ukur/)).toBeInTheDocument();
    expect(calls[0]!.body).toMatchObject({ project: 'contoh', actions: [] });
    expect(screen.getByRole('button', { name: 'Hitung ulang' })).toBeInTheDocument();
  });

  it('analisis yang terhenti oleh batas waktu diberi tahu', async () => {
    mockApi({ 'POST /api/lab/bottlenecks': { body: { baseline: analysis({ complete: false, variations: 3 }), experiment: analysis() } } });
    renderWithProviders(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Cari leher botol' }));
    await waitFor(() => expect(screen.getByText(/3 dari 8 variasi\./)).toBeInTheDocument());
  });

  it('kegagalan server ditampilkan sebagai galat, bukan hasil kosong', async () => {
    mockApi({ 'POST /api/lab/bottlenecks': { status: 400, body: { error: 'Beban dasar melebihi batas simulasi' } } });
    renderWithProviders(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Cari leher botol' }));
    expect(await screen.findByText('Beban dasar melebihi batas simulasi')).toBeInTheDocument();
    expect(screen.queryByText('#1 Server API')).not.toBeInTheDocument();
  });
});

describe('ranksOf dan analysisKey', () => {
  it('peringkat 1..3 menurut urutan; kunci berubah bila skenario berubah', () => {
    expect(ranksOf(analysis())).toEqual({ api: 1, pg: 2 });
    expect(ranksOf(undefined)).toEqual({});
    const s = initialScenario(project, 'now');
    expect(analysisKey(s)).toBe(analysisKey(structuredClone(s)));
    expect(analysisKey({ ...s, load: { ...s.load, users: 1 } })).not.toBe(analysisKey(s));
  });
});
