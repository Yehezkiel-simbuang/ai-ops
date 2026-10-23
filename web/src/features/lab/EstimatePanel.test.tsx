import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import { EstimatePanel, guessedParams } from './EstimatePanel';
import { project } from './fixtures';
import { initialScenario, scenarioReducer } from './scenario';
import type { LabEstimateResult, LabProject } from './types';

const folder: LabProject = { ...project, id: 'folder:api', source: 'folder', arch: { workloads: [], nodes: [{ id: 'db', type: 'db', connections: 100, assumed: ['connections', 'hotKeys'] }, { id: 'api', type: 'pool', workers: 20, assumed: ['workers'] }] } };
const answer: LabEstimateResult = {
  role: 'monitor', model: 'm-murah', filesRead: ['.env.example'], assumedCount: 3,
  estimates: [
    { node: 'db', key: 'connections', current: 100, value: 25, confidence: 'tinggi', verified: true, file: '.env.example', line: 4, quote: 'DB_POOL_MAX=25', reason: 'tertulis' },
    { node: 'api', key: 'workers', current: 20, value: 8, confidence: 'rendah', verified: false, file: 'x', line: 1, quote: 'q', reason: 'perkiraan' }
  ]
};

describe('EstimatePanel', () => {
  it('daftar tebakan, usulan AI diberi keyakinan dan bukti; hanya yang bukti cocok terpilih dan dikirim saat dipakai', async () => {
    const calls = mockApi({ 'POST /api/lab/estimate': { body: answer } });
    const applied = vi.fn();
    renderWithProviders(<EstimatePanel project={folder} scenario={initialScenario(folder, 'now')} onApply={applied} />);
    expect(screen.getByText('Masih tebakan (3)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Perkirakan dengan AI' }));
    expect(await screen.findByText('keyakinan tinggi')).toBeInTheDocument(); expect(screen.getByText('keyakinan rendah')).toBeInTheDocument();
    expect(screen.getByText('bukti tidak cocok')).toBeInTheDocument(); expect(screen.getByText('.env.example:4')).toBeInTheDocument(); expect(screen.getByText(/Ditulis AI \(m-murah\)/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Pakai db.connections' })).toBeChecked(); expect(screen.getByRole('checkbox', { name: 'Pakai api.workers' })).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Pakai yang dipilih' }));
    expect(applied).toHaveBeenCalledWith([{ node: 'db', key: 'connections', value: 25 }]);
    expect(calls[0]!.body).toEqual({ project: 'folder:api' });
  });
  it('contoh bawaan: tombol AI mati dengan penjelasan', () => {
    renderWithProviders(<EstimatePanel project={project} scenario={initialScenario(project, 'now')} onApply={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Perkirakan dengan AI' })).toBeDisabled(); expect(screen.getByText(/Hanya untuk proyek dari folder/)).toBeInTheDocument();
  });
  it('estimasi yang dipakai tampil berlabel dari AI dan keluar dari daftar tebakan; bisa dikembalikan', async () => {
    const s = { ...initialScenario(folder, 'now'), estimates: [{ node: 'db', key: 'connections', value: 25 }] };
    const applied = vi.fn();
    renderWithProviders(<EstimatePanel project={folder} scenario={s} onApply={applied} />);
    expect(screen.getByText('Dipakai simulasi (1)')).toBeInTheDocument(); expect(screen.getByText('dari AI')).toBeInTheDocument(); expect(screen.getByText('Masih tebakan (2)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Kembalikan ke tebakan' }));
    await waitFor(() => expect(applied).toHaveBeenCalledWith([]));
  });
  it('guessedParams dan reducer setEstimates', () => {
    expect(guessedParams(folder, [{ node: 'api', key: 'workers', value: 8 }]).map((g) => `${g.node}.${g.key}`)).toEqual(['db.connections', 'db.hotKeys']);
    const s = initialScenario(folder, 'now'), next = scenarioReducer(s, { type: 'setEstimates', estimates: [{ node: 'db', key: 'connections', value: 25 }] });
    expect(next!.estimates).toEqual([{ node: 'db', key: 'connections', value: 25 }]); expect(s.estimates).toBeUndefined();
  });
});
