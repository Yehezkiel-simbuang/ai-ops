import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunTemplate } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { applyFills, holesOf } from './NewRunDialog';
import { SetupPage } from './SetupPage';

afterEach(() => vi.unstubAllGlobals());

const server = { id: 1, name: 'srv-uji', host: '10.0.0.1', port: 22, username: 'ops', key_path: '', has_ssh_key: true, ssh_pub: '', playground: false, use_sudo: true, services: '', notes: '', exec_via: 'auto', os_info: '', last_seen: Date.now(), last_status: 'ok', open_alerts: 0 };
const GOAL = 'Port yang terbuka: [ISI: port, mis. 80 dan 443, atau tulis "tidak ada"]. Domain: [ISI: domain]. Ulangi domain: [ISI: domain].\n\nAturan wajib: contoh panjang yang membuat bagian isian tidak terlihat di kotak tujuan.';
const templates: RunTemplate[] = [
  { id: 'baseline', name: 'Pengamanan dasar server baru', category: 'Fondasi server', goal: GOAL, steps: ['Baca OS', 'Pasang ufw'], ask: ['Port', 'Domain'], maxTurns: 40, tokenBudget: 300000 },
  { id: 'diagnosis', name: 'Diagnosis awal (baca saja)', category: 'Diagnosis dan tuning', goal: 'Kumpulkan gambaran kondisi server.', steps: ['Baca OS'] }
];
const open = async () => {
  const calls = mockApi({ 'GET /api/runs': { body: [] }, 'GET /api/servers': { body: [server] }, 'GET /api/templates': { body: templates }, 'POST /api/runs': { body: { id: 'r9' } } });
  renderWithProviders(<SetupPage />);
  await userEvent.click(await screen.findByRole('button', { name: 'Proses baru' }));
  return { calls, dlg: (await screen.findByRole('heading', { name: 'Proses baru' })).closest('dialog')! };
};

describe('isian templat', () => {
  it('bagian [ISI: ...] diambil sekali per teks yang sama dan diganti hanya bila sudah diisi', () => {
    expect(holesOf(GOAL).map((h) => h.label)).toEqual(['port, mis. 80 dan 443, atau tulis "tidak ada"', 'domain']);
    const g = applyFills(GOAL, { '[ISI: domain]': ' contoh.com ', '[ISI: port, mis. 80 dan 443, atau tulis "tidak ada"]': '  ' });
    expect(g).toContain('Domain: contoh.com. Ulangi domain: contoh.com.'); expect(g).toContain('[ISI: port'); expect(g).not.toContain('[ISI: domain]');   // port masih kosong: tetap terdeteksi belum selesai
    expect(holesOf('tanpa isian')).toEqual([]);
  });

  it('tiap bagian jadi kolom tersendiri dengan penghitung yang belum diisi; mengisinya mengisi tujuan dan membuka kunci Buat proses', async () => {
    const { dlg, calls } = await open(), create = within(dlg).getByRole('button', { name: 'Buat proses' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Pengamanan dasar server baru' }));
    const box = within(dlg).getByRole('group', { name: 'Isian yang dibutuhkan' });
    expect(within(box).getByText('Isi dulu (2 dari 2 belum diisi)')).toBeInTheDocument(); expect(create).toBeDisabled();
    await userEvent.type(within(box).getByLabelText('port, mis. 80 dan 443, atau tulis "tidak ada"'), '80 dan 443');
    expect(within(box).getByText('Isi dulu (1 dari 2 belum diisi)')).toBeInTheDocument(); expect(create).toBeDisabled(); expect(within(dlg).getByRole('alert')).toHaveTextContent('Lengkapi kolom "Isi dulu" di atas');
    await userEvent.type(within(box).getByLabelText('domain'), 'contoh.com');
    expect(within(box).getByText('Isi dulu (semua terisi)')).toBeInTheDocument(); await waitFor(() => expect(create).toBeEnabled()); expect(within(dlg).queryByRole('alert')).not.toBeInTheDocument();
    const goal = (within(dlg).getByLabelText('Tujuan') as HTMLTextAreaElement).value; expect(goal).toContain('Port yang terbuka: 80 dan 443.'); expect(goal).toContain('Domain: contoh.com. Ulangi domain: contoh.com.'); expect(goal).not.toContain('[ISI:');
    await userEvent.click(create);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/runs')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/runs')!.body).toMatchObject({ template: 'baseline', goal: expect.stringContaining('Domain: contoh.com.') });
  });

  it('setelah tujuan diubah langsung, kolom tidak lagi menimpanya; berpindah templat mengosongkan isian', async () => {
    const { dlg } = await open(), goalBox = within(dlg).getByLabelText('Tujuan') as HTMLTextAreaElement;
    await userEvent.click(within(dlg).getByRole('button', { name: 'Pengamanan dasar server baru' }));
    await userEvent.clear(goalBox); await userEvent.type(goalBox, 'Tujuan saya sendiri');
    await userEvent.type(within(dlg).getByLabelText('domain'), 'contoh.com');
    expect(goalBox.value).toBe('Tujuan saya sendiri');   // pilihan tangan dihormati
    await userEvent.click(within(dlg).getByRole('button', { name: 'Diagnosis awal (baca saja)' }));
    expect(within(dlg).queryByRole('group', { name: 'Isian yang dibutuhkan' })).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Pengamanan dasar server baru' }));
    expect((within(dlg).getByLabelText('domain') as HTMLInputElement).value).toBe(''); expect(goalBox.value).toContain('[ISI: domain]');
  });
});
