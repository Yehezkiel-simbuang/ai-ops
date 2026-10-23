import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { mockApi, renderWithProviders } from '@/test/utils';
import { PlaygroundPage, deploySummary } from './PlaygroundPage';
import type { ComposeAnalysis, PlaygroundDeploy } from './types';

afterEach(() => vi.unstubAllGlobals());

const analysis = (over: Partial<ComposeAnalysis> = {}): ComposeAnalysis => ({
  services: [{ name: 'web', image: 'nginx:1.27', ports: [{ host: 8080, container: 80 }], volumes: [], hasHealthcheck: true }], publish: [{ service: 'web', host: 8080, container: 80 }], problems: [], warnings: [], ...over
});
const deploy = (over: Partial<PlaygroundDeploy> = {}): PlaygroundDeploy => ({
  id: 7, server_id: 1, server_name: 'uji-pg', server_host: '10.1.1.1', name: 'web + redis', compose: 'services: {}', health_path: '/', target_port: 0, status: 'draft', target: '', detail: '', log: '',
  created: Date.now(), updated: Date.now(), deployed: null, analysis: analysis(), ...over
});
const server = (over = {}) => ({ id: 1, name: 'uji-pg', host: '10.1.1.1', port: 22, username: 'aiops', key_path: '', has_ssh_key: true, ssh_pub: '', playground: true, use_sudo: false, services: '', notes: '',  exec_via: 'auto', last_status: 'ok', os_info: '', last_seen: null, open_alerts: 0, ...over });

describe('deploySummary', () => {
  it('menyebut image, port yang dibuka, peringatan, dan bahwa data uji dihapus saat dicopot', () => {
    const s = deploySummary({ name: 'a', server_name: 'uji-pg', server_host: '10.1.1.1', analysis: analysis({ warnings: ['image tanpa versi'] }) }).join('\n');
    expect(s).toContain('uji-pg (10.1.1.1)'); expect(s).toContain('nginx:1.27'); expect(s).toContain('8080 (web)'); expect(s).toContain('Perhatian: image tanpa versi'); expect(s).toContain('data uji');
    expect(deploySummary({ name: 'a', server_name: 's', server_host: 'h', analysis: analysis({ publish: [] }) }).join()).toContain('Tidak ada port yang dibuka');
  });
});

describe('PlaygroundPage', () => {
  it('tanpa server playground: petunjuk untuk menandai server, dan tombol susunan baru mati', async () => {
    mockApi({ 'GET /api/playground': { body: [] }, 'GET /api/servers': { body: [server({ playground: false })] } });
    renderWithProviders(<PlaygroundPage />);
    expect(await screen.findByText(/Belum ada server playground/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Susunan baru' })).toBeDisabled();
  });

  it('susunan baru: analisis tampil, masalah mengunci Simpan, yang valid menyimpan muatan yang benar', async () => {
    const calls = mockApi({
      'GET /api/playground': { body: [] }, 'GET /api/servers': { body: [server()] }, 'POST /api/playground': { body: { id: 9 } },
      'POST /api/playground/analyze': (_u, init) => { const c = JSON.parse(String(init?.body)).compose as string; return { body: c.includes('privileged') ? analysis({ problems: ['Layanan "web": "privileged" tidak diizinkan'] }) : analysis() }; }
    });
    renderWithProviders(<PlaygroundPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Susunan baru' }));
    const dlg = (await screen.findByRole('heading', { name: 'Susunan baru' })).closest('dialog')!, save = within(dlg).getByRole('button', { name: 'Simpan' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dlg).getByPlaceholderText('mis. web + redis'), 'uji-1');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Web sederhana + Redis' }));
    expect(await within(dlg).findByText('valid')).toBeInTheDocument();
    await waitFor(() => expect(save).toBeEnabled());
    const box = within(dlg).getByLabelText('Isi Compose');
    await userEvent.type(box, ' privileged');
    expect(await within(dlg).findByText(/tidak diizinkan/)).toBeInTheDocument();
    await waitFor(() => expect(save).toBeDisabled());
    await userEvent.clear(box); await userEvent.click(within(dlg).getByRole('button', { name: 'Web sederhana + Redis' }));
    await waitFor(() => expect(save).toBeEnabled()); await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/playground')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/playground')!.body).toMatchObject({ server_id: 1, name: 'uji-1', health_path: '/', target_port: 0, compose: expect.stringContaining('nginx:1.27-alpine') });
  });

  it('Pasang menampilkan ringkasan untuk disetujui; batal tidak memasang, konfirmasi memasang', async () => {
    const calls = mockApi({ 'GET /api/playground': { body: [deploy()] }, 'GET /api/servers': { body: [server()] }, 'POST /api/playground/7/deploy': { body: deploy({ status: 'deploying' }) } });
    renderWithProviders(<PlaygroundPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pasang' }));
    expect(await screen.findByText(/Pasang "web \+ redis" di server playground uji-pg/)).toBeInTheDocument(); expect(screen.getByText(/Image yang akan ditarik: nginx:1.27/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Batal' }));
    expect(calls.some((c) => c.path.endsWith('/deploy'))).toBe(false);
    await userEvent.click(screen.getAllByRole('button', { name: 'Pasang' })[0]!);
    const confirmBtn = (await screen.findAllByRole('button', { name: 'Pasang' })).find((b) => b.closest('dialog')?.hasAttribute('open'))!;
    await userEvent.click(confirmBtn);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/playground/7/deploy')).toBe(true));
  });

  it('tombol sesuai status: berjalan punya Uji beban (target terisi), sedang memasang tidak bisa dipasang lagi, gagal bisa dicopot', async () => {
    mockApi({
      'GET /api/playground': { body: [deploy({ id: 1, name: 'jalan', status: 'running', target: 'http://10.1.1.1:8080', detail: '2 layanan berjalan' }), deploy({ id: 2, name: 'proses', status: 'deploying', detail: 'Memasang...' }), deploy({ id: 3, name: 'rusak', status: 'failed', detail: 'up gagal' })] },
      'GET /api/servers': { body: [server()] }
    });
    const Where = () => { const l = useLocation(); return <div data-testid="loc">{l.pathname}{l.search}</div>; };
    renderWithProviders(<Routes><Route path="/" element={<PlaygroundPage />} /><Route path="/uji-beban" element={<Where />} /></Routes>);
    await screen.findByText('2 layanan berjalan');
    const row = (n: string) => screen.getByText(n).closest('.item') as HTMLElement;
    expect(within(row('proses')).queryByRole('button', { name: 'Pasang' })).not.toBeInTheDocument(); expect(within(row('proses')).getByText('Memasang')).toBeInTheDocument();
    expect(within(row('rusak')).getByRole('button', { name: 'Copot' })).toBeInTheDocument(); expect(within(row('rusak')).getByRole('button', { name: 'Pasang ulang' })).toBeInTheDocument();
    await userEvent.click(within(row('jalan')).getByRole('button', { name: 'Uji beban' }));
    expect((await screen.findByTestId('loc')).textContent).toBe('/uji-beban?target=http%3A%2F%2F10.1.1.1%3A8080&nama=jalan&pg=1');
  });

  it('Log untuk susunan yang gagal menampilkan keluaran pemasangan', async () => {
    mockApi({ 'GET /api/playground': { body: [deploy({ status: 'failed', detail: 'up gagal', log: '$ docker compose up -d\npull access denied' })] }, 'GET /api/servers': { body: [server()] } });
    renderWithProviders(<PlaygroundPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Log' }));
    expect(await screen.findByText(/pull access denied/)).toBeInTheDocument();
  });
});
