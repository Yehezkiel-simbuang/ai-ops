import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MaintenanceTask } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { MaintenancePage } from './MaintenancePage';

const task = (id: number, over: Partial<MaintenanceTask> = {}): MaintenanceTask => ({
  id, server_id: 1, server_name: 'srv-01', title: `tugas-${id}`, description: '', category: 'umum', priority: 'normal', every_days: 30, due_at: 1_800_000_000_000 + id, last_done: null, status: 'ok', ...over
});
const server = (id: number, name: string) => ({ id, name, host: 'h', port: 22, username: 'u', key_path: '', has_ssh_key: true, ssh_pub: '', playground: false, use_sudo: false, services: '', notes: '', exec_via: 'ssh', os_info: '', last_seen: null, last_status: 'ok', open_alerts: 0 });
const base = { 'GET /api/maintenance/patching': { body: { rows: [], without_agent: [] } }, 'GET /api/patch-plans': { body: [] }, 'GET /api/maintenance/templates': { body: [{ id: 't1', title: 'Cek backup', every_days: 7 }] } };
afterEach(() => vi.unstubAllGlobals());

describe('halaman Pemeliharaan', () => {
  it('ringkasan jumlah per status di atas daftar', async () => {
    mockApi({ ...base, 'GET /api/maintenance': { body: [task(1, { status: 'terlambat' }), task(2, { status: 'terlambat' }), task(3, { status: 'segera' }), task(4)] } });
    renderWithProviders(<MaintenancePage />);
    await screen.findByText('Segera (7 hari)'); const tile = (label: string) => screen.getByText(label, { selector: '.tile span' }).closest('.tile') as HTMLElement;
    expect(tile('Terlambat')).toHaveTextContent('2'); expect(tile('Segera (7 hari)')).toHaveTextContent('1'); expect(tile('Aman')).toHaveTextContent('1');
  });
  it('daftar kosong: ajakan memakai Tugas baru dan templat; dialog meminta server dan menawarkan templat', async () => {
    mockApi({ ...base, 'GET /api/maintenance': { body: [] }, 'GET /api/servers': { body: [server(1, 'srv-a'), server(2, 'srv-b')] } });
    renderWithProviders(<MaintenancePage />);
    expect(await screen.findByText(/Belum ada tugas pemeliharaan/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Tugas baru/ }));
    const pick = await screen.findByLabelText('Untuk server'); expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['srv-a', 'srv-b']);
    expect(screen.getByText('Tambah dari templat standar')).toBeInTheDocument();
  });
});
