import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import type { Check } from '@/api/types';
import { ChecksPanel, groupChecks } from './ChecksPanel';

afterEach(() => vi.unstubAllGlobals());

const check = (id: number, name: string, status: Check['last_status'], over: Partial<Check> = {}): Check => ({
  id, name, type: 'service', enabled: true, warn: null, crit: null, last_status: status, last_detail: 'ok', last_value: null, last_run: Date.now() - 30_000, ...over
});
const checks = [
  check(1, 'MySQL: layanan aktif', 'crit', { pack: 'mysql' }), check(2, 'MySQL: ping', 'ok', { pack: 'mysql' }),
  check(3, 'Redis: layanan aktif', 'crit', { pack: 'redis' }), check(4, 'Jam tersinkron (NTP)', 'ok'), check(5, 'Redis: memori', 'ok', { pack: 'redis', enabled: false })
];

describe('groupChecks', () => {
  it('mengelompokkan menurut paket, atau awalan nama; urutan kemunculan dipertahankan; yang terburuk menang dan yang dimatikan tidak dihitung', () => {
    const g = groupChecks(checks, [{ id: 'mysql', label: 'MySQL / MariaDB', fields: [] }]);
    expect(g.map((x) => x.key)).toEqual(['mysql', 'redis', 'Jam tersinkron (NTP)']);
    expect(g[0]).toMatchObject({ label: 'MySQL / MariaDB', worst: 'crit' }); expect(g[0]!.checks).toHaveLength(2);
    expect(g[1]).toMatchObject({ label: 'redis', worst: 'crit' });
    expect(groupChecks([check(9, 'Redis: x', 'crit', { pack: 'redis', enabled: false })])[0]!.worst).toBe('belum');   // semua mati
  });
});

describe('ChecksPanel berkelompok', () => {
  it('kelompok bermasalah terbuka sendiri, yang normal dilipat; ringkasan tampil dan yang normal bisa dibuka', async () => {
    mockApi({ 'GET /api/checks/meta': { body: { packs: [], types: [] } } });
    const { container } = renderWithProviders(<ChecksPanel serverId={1} checks={checks} />);
    const groups = container.querySelectorAll('details.group'); expect(groups).toHaveLength(3);
    expect([...groups].map((d) => (d as HTMLDetailsElement).open)).toEqual([true, true, false]);   // mysql dan redis kritis; NTP normal
    expect(within(groups[0] as HTMLElement).getByText('1 Critical')).toBeInTheDocument(); expect(within(groups[1] as HTMLElement).getByText(/1 mati/)).toBeInTheDocument();
    await userEvent.click(groups[2]!.querySelector('summary')!);
    expect((groups[2] as HTMLDetailsElement).open).toBe(true); expect(within(groups[0] as HTMLElement).getByText('MySQL: layanan aktif')).toBeInTheDocument();
  });
  it('Matikan semua mengirim enabled=false untuk setiap pemeriksaan di kelompok itu', async () => {
    const calls = mockApi({ 'GET /api/checks/meta': { body: { packs: [], types: [] } }, 'PUT /api/checks/1': { body: {} }, 'PUT /api/checks/2': { body: {} } });
    const { container } = renderWithProviders(<ChecksPanel serverId={1} checks={checks} />);
    const g = container.querySelectorAll('details.group')[0] as HTMLElement;
    await userEvent.click(within(g).getByRole('button', { name: 'Matikan semua' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.path).sort()).toEqual(['/api/checks/1', '/api/checks/2']));
    expect(calls.filter((c) => c.method === 'PUT').every((c) => (c.body as { enabled: boolean }).enabled === false)).toBe(true);
  });
});
