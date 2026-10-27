import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunTemplate } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { SetupPage } from './SetupPage';

afterEach(() => vi.unstubAllGlobals());

const server = { id: 1, name: 'srv-uji', host: '10.0.0.1', port: 22, username: 'ops', key_path: '', has_ssh_key: true, ssh_pub: '', playground: false, use_sudo: true, services: '', notes: '', exec_via: 'auto', os_info: '', last_seen: Date.now(), last_status: 'ok', open_alerts: 0 };
const templates: RunTemplate[] = [
  { id: 'diagnosis', name: 'Diagnosis awal (baca saja)', category: 'Diagnosis dan tuning', goal: 'Kumpulkan gambaran kondisi server.', steps: ['Baca OS', 'Baca layanan'] },
  { id: 'postgres-install', name: 'Pasang PostgreSQL, database, dan backup', category: 'Data dan antrean', goal: 'Nama database: [ISI: nama].', steps: ['Baca OS', 'Pasang PostgreSQL', 'Buat database'], ask: ['Nama database'], maxTurns: 40, tokenBudget: 300000 },
  { id: 'redis-install', name: 'Pasang Redis (aman, bersandi, dengan batas memori)', category: 'Data dan antrean', goal: 'Batas memori: [ISI: mis. 512mb].', steps: ['Baca OS', 'Pasang Redis'], ask: ['Batas memori'], maxTurns: 40, tokenBudget: 300000 },
  { id: 'lb-nginx', name: 'Load balancer Nginx', category: 'Jaringan dan TLS', goal: 'Atur Nginx sebagai load balancer.', steps: ['Baca OS'] }
];
const open = async () => {
  mockApi({ 'GET /api/runs': { body: [] }, 'GET /api/servers': { body: [server] }, 'GET /api/templates': { body: templates } });
  renderWithProviders(<SetupPage />);
  await userEvent.click(await screen.findByRole('button', { name: 'Proses baru' }));
  return (await screen.findByRole('heading', { name: 'Proses baru' })).closest('dialog')!;
};

describe('Proses baru: dua blok', () => {
  it('dialog lebar dengan dua blok bernomor: pilih templat di satu sisi, atur proses di sisi lain', async () => {
    const dlg = await open();
    expect(dlg).toHaveClass('wide');
    expect(within(dlg).getByRole('region', { name: 'Pilih templat' })).toBeInTheDocument(); expect(within(dlg).getByRole('region', { name: 'Atur proses' })).toBeInTheDocument();
    expect(within(dlg).getByText(/Pilih templat di blok kiri, atau tulis tujuan sendiri/)).toBeInTheDocument();
    expect(within(dlg).getByText('3 langkah | perlu Anda isi: 1')).toBeInTheDocument();   // keterangan di tiap templat: jumlah langkah dan isian
  });

  it('pencarian menyaring templat menurut nama atau kelompok, dan menyebut bila tidak ada yang cocok', async () => {
    const dlg = await open(), box = within(dlg).getByRole('searchbox', { name: 'Cari templat' });
    await userEvent.type(box, 'redis');
    expect(within(dlg).getByRole('button', { name: /Pasang Redis/ })).toBeInTheDocument(); expect(within(dlg).queryByRole('button', { name: /PostgreSQL/ })).not.toBeInTheDocument(); expect(within(dlg).queryByRole('group', { name: 'Diagnosis dan tuning' })).not.toBeInTheDocument();
    await userEvent.clear(box); await userEvent.type(box, 'data dan antrean');
    expect(within(dlg).getByRole('button', { name: /PostgreSQL/ })).toBeInTheDocument(); expect(within(dlg).getByRole('button', { name: /Redis/ })).toBeInTheDocument();
    await userEvent.clear(box); await userEvent.type(box, 'zzz');
    expect(within(dlg).getByText(/Tidak ada templat yang cocok/)).toBeInTheDocument();
  });

  it('templat terpilih diringkas di blok pengaturan (nama, kelompok, isian, rencana langkah); memilihnya lagi membatalkan pilihan', async () => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Pasang PostgreSQL, database, dan backup' }));
    const chosen = within(dlg).getByRole('region', { name: 'Atur proses' });
    expect(within(chosen).getByRole('group', { name: 'Isian yang dibutuhkan' })).toBeInTheDocument(); expect(within(chosen).getByLabelText('nama')).toBeInTheDocument(); expect(within(chosen).getByText('Rencana langkah')).toBeInTheDocument(); expect(within(chosen).getByText('Pasang PostgreSQL')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Pasang PostgreSQL, database, dan backup' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Pasang PostgreSQL, database, dan backup' }));
    expect(within(dlg).getByText(/Pilih templat di blok kiri/)).toBeInTheDocument(); expect((within(dlg).getByLabelText('Tujuan') as HTMLTextAreaElement).value).toBe('');
  });

  it('Batal menutup dialog tanpa membuat proses', async () => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(dlg.hasAttribute('open')).toBe(false));
  });
});
