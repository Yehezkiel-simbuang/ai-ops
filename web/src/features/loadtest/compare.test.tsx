import { screen } from '@testing-library/react';
import { mockApi, renderWithProviders } from '@/test/utils';
import { ComparePage, capacityDelta, type CompareItem } from './ComparePage';

const item = (id: number, name: string, rps: number | null, over: Partial<CompareItem> = {}): CompareItem => ({
  id, name, status: 'done', setup: { name: `s${id}`, services: [{ name: 'app', image: 'x:1' }], limits: ['app: 0.5 CPU'] }, criteria: { p95Ms: 500, errPct: 1 },
  healthy: rps === null ? null : { idx: 1, vus: 20, rps }, knee: { idx: 2, vus: 80, rps: 40, reason: 'p95 900 ms' }, verdict: { tone: 'warn', title: 't', text: '' },
  stages: [{ vus: 5, rps: 4, p95: 80, errPct: 0, valid: true }, { vus: 20, rps: rps ?? 0, p95: 200, errPct: 0, valid: true }], ...over
});

describe('capacityDelta', () => {
  it('selisih persen terhadap pembanding; null bila tidak ada tahap sehat', () => {
    expect(capacityDelta(item(1, 'a', 20), item(2, 'b', 30))).toBe(50); expect(capacityDelta(item(1, 'a', 20), item(2, 'b', 10))).toBe(-50);
    expect(capacityDelta(item(1, 'a', null), item(2, 'b', 30))).toBeNull(); expect(capacityDelta(item(1, 'a', 20), item(2, 'b', null))).toBeNull();
  });
});

describe('ComparePage', () => {
  it('menampilkan susunan, kapasitas sehat, selisih, dan tahap berdampingan', async () => {
    mockApi({ 'GET /api/loadtests/compare?ids=1,2': { body: [item(1, 'Tanpa Redis', 20), item(2, 'Dengan Redis', 30, { setup: null })] } });
    renderWithProviders(<ComparePage />, { route: '/uji-beban/banding?ids=1,2' });
    expect(await screen.findByText('pembanding')).toBeInTheDocument(); expect(screen.getByText('+50%')).toBeInTheDocument(); expect(screen.getByText('tidak dicatat')).toBeInTheDocument();
    expect(screen.getByText(/s1: app \(app: 0.5 CPU\)/)).toBeInTheDocument(); expect(screen.getAllByText(/20 pengguna: 200 ms/)).toHaveLength(2);
  });
  it('tanpa pilihan: petunjuk, tidak memanggil API', () => {
    const calls = mockApi({}); renderWithProviders(<ComparePage />, { route: '/uji-beban/banding' });
    expect(screen.getByText(/Pilih 2 sampai 4 uji/)).toBeInTheDocument(); expect(calls).toHaveLength(0);
  });
});
