import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunTemplate } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { SetupPage } from './SetupPage';

afterEach(() => vi.unstubAllGlobals());

const server = { id: 1, name: 'srv-uji', host: '10.0.0.1', port: 22, username: 'ops', key_path: '', has_ssh_key: true, ssh_pub: '', playground: false, use_sudo: true, services: '', notes: '', exec_via: 'auto', os_info: '', last_seen: Date.now(), last_status: 'ok', open_alerts: 0 };
const templates: RunTemplate[] = [
  { id: 'diagnosis', name: 'Diagnosis awal (baca saja)', category: 'Diagnosis dan tuning', goal: 'Kumpulkan gambaran kondisi server.', steps: ['Baca OS'] },
  { id: 'postgres-install', name: 'Pasang PostgreSQL, database, dan backup', category: 'Data dan antrean', goal: 'Nama database: [ISI: nama database]. Pengguna aplikasi: [ISI: nama pengguna aplikasi].', steps: ['Baca OS', 'Pasang'], ask: ['Nama database', 'Pengguna aplikasi'], maxTurns: 40, tokenBudget: 300000 },
  { id: 'lb-nginx', name: 'Load balancer Nginx', category: 'Jaringan dan TLS', goal: 'Atur Nginx sebagai load balancer.', steps: ['Baca OS'], maxTurns: 40, tokenBudget: 300000 }
];
const open = async () => {
  const calls = mockApi({ 'GET /api/runs': { body: [] }, 'GET /api/servers': { body: [server] }, 'GET /api/templates': { body: templates }, 'POST /api/runs': { body: { id: 'r9' } } });
  renderWithProviders(<SetupPage />);
  await userEvent.click(await screen.findByRole('button', { name: 'Proses baru' }));
  return { calls, dlg: (await screen.findByRole('heading', { name: 'Proses baru' })).closest('dialog')! };
};

describe('Setup: templat dikelompokkan dan bagian [ISI: ...] wajib diganti', () => {
  it('templat tampil per kelompok dengan judul kelompoknya', async () => {
    const { dlg } = await open();
    for (const [cat, name] of [['Diagnosis dan tuning', 'Diagnosis awal (baca saja)'], ['Data dan antrean', 'Pasang PostgreSQL, database, dan backup'], ['Jaringan dan TLS', 'Load balancer Nginx']]) {
      expect(within(within(dlg).getByRole('group', { name: cat })).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('memilih templat pemasangan mengisi tujuan, menyebut yang harus diisi, menaikkan anggaran, dan mengunci Buat proses sampai diganti', async () => {
    const { dlg, calls } = await open(), goal = within(dlg).getByLabelText('Tujuan') as HTMLTextAreaElement, create = within(dlg).getByRole('button', { name: 'Buat proses' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Pasang PostgreSQL, database, dan backup' }));
    expect(goal.value).toContain('[ISI: nama database]'); expect(within(within(dlg).getByRole('group', { name: 'Isian yang dibutuhkan' })).getAllByRole('textbox').map((x) => x.getAttribute('aria-label'))).toEqual(['nama database', 'nama pengguna aplikasi']);
    expect((within(dlg).getByLabelText('Maks. giliran agen') as HTMLInputElement).value).toBe('40'); expect((within(dlg).getByLabelText('Anggaran token') as HTMLInputElement).value).toBe('300000');
    expect(create).toBeDisabled(); expect(within(dlg).getByRole('alert')).toHaveTextContent('Tujuan masih berisi [ISI: nama database]');
    await userEvent.clear(goal); await userEvent.type(goal, 'Nama database: appdb. Pengguna aplikasi: appuser.');
    await waitFor(() => expect(create).toBeEnabled()); expect(within(dlg).queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(create);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/runs')).toBe(true));
    expect(calls.find((c) => c.path === '/api/runs' && c.method === 'POST')!.body).toMatchObject({ serverId: 1, template: 'postgres-install', maxTurns: 40, tokenBudget: 300000, goal: 'Nama database: appdb. Pengguna aplikasi: appuser.' });
  });

  it('templat tanpa bagian yang harus diisi langsung bisa dibuat; berpindah templat mengembalikan anggaran bawaan', async () => {
    const { dlg } = await open(), create = within(dlg).getByRole('button', { name: 'Buat proses' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Pasang PostgreSQL, database, dan backup' })); expect(create).toBeDisabled();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Diagnosis awal (baca saja)' }));
    expect(create).toBeEnabled(); expect((within(dlg).getByLabelText('Maks. giliran agen') as HTMLInputElement).value).toBe('30'); expect((within(dlg).getByLabelText('Anggaran token') as HTMLInputElement).value).toBe('200000');
    expect(within(dlg).queryByRole('group', { name: 'Isian yang dibutuhkan' })).not.toBeInTheDocument();
  });
});
