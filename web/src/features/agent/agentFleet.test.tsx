import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetAgent } from '@/api/types';
import { StandardsPage, type EventRow, type Row, type Standards } from '@/features/standards/StandardsPage';
import { ServersPage } from '@/features/servers/ServersPage';
import { mockApi, renderWithProviders } from '@/test/utils';
import { AgentFleet, fleetSummary } from './AgentFleet';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const agent = (id: number, state: FleetAgent['state'], over: Partial<FleetAgent> = {}): FleetAgent => ({ server_id: id, name: `srv-${id}`, state, last_seen: state === 'mati' ? NOW - 600_000 : state === 'hidup' ? NOW - 20_000 : null, version: '1.0', exec_enabled: false, open_keys: 0, ...over });

describe('Armada agen', () => {
  it('ringkasan menghitung tiap keadaan dan melewatkan yang nol', () => {
    expect(fleetSummary([agent(1, 'hidup'), agent(2, 'hidup'), agent(3, 'mati'), agent(4, 'belum_dipasang')])).toBe('2 hidup, 1 mati, 1 belum dipasang');
    expect(fleetSummary([agent(1, 'hidup')])).toBe('1 hidup');
  });

  it('yang mati dan belum terhubung ditampilkan sebagai daftar yang bisa dibuka; yang sehat hanya terhitung', async () => {
    mockApi({ 'GET /api/agents': { body: [agent(1, 'mati'), agent(2, 'belum_terhubung'), agent(3, 'hidup'), agent(4, 'belum_dipasang')] } });
    renderWithProviders(<AgentFleet />);
    const panel = (await screen.findByRole('heading', { name: 'Armada agen' })).closest('section')!;
    expect(within(panel).getByText('1 hidup, 1 mati, 1 belum terhubung, 1 belum dipasang')).toBeInTheDocument();
    expect(within(panel).getByText('srv-1').closest('a')).toHaveAttribute('href', '/agen/1'); expect(within(panel).getByText(/terakhir terlihat/)).toBeInTheDocument(); expect(within(panel).getByText(/belum pernah menghubungi aplikasi/)).toBeInTheDocument();
    expect(within(panel).getByText('mati')).toBeInTheDocument(); expect(within(panel).getByText('belum terhubung')).toBeInTheDocument(); expect(within(panel).queryByText('srv-3')).not.toBeInTheDocument();
  });

  it('semua sehat: satu kalimat tenang tanpa daftar; belum ada agen sama sekali: panel tidak tampil', async () => {
    mockApi({ 'GET /api/agents': { body: [agent(1, 'hidup'), agent(2, 'hidup'), agent(3, 'belum_dipasang')] } });
    const { unmount } = renderWithProviders(<AgentFleet />);
    expect(await screen.findByText(/2 hidup, 1 belum dipasang. Semua agen yang dipasang melapor./)).toBeInTheDocument(); expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    unmount(); vi.unstubAllGlobals();
    mockApi({ 'GET /api/agents': { body: [agent(1, 'belum_dipasang')] } });
    renderWithProviders(<AgentFleet />);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Armada agen' })).not.toBeInTheDocument());
  });

  it('muncul di halaman Server, di atas tabel', async () => {
    const srv = { id: 1, name: 'srv-1', host: '10.0.0.1', port: 22, username: 'ops', key_path: '', has_ssh_key: true, ssh_pub: '', playground: false, use_sudo: false, services: '', notes: '',  exec_via: 'auto', os_info: '', last_seen: NOW, last_status: 'ok', open_alerts: 0 };
    mockApi({ 'GET /api/servers': { body: [srv] }, 'GET /api/agents': { body: [agent(1, 'mati')] } });
    renderWithProviders(<ServersPage />);
    const fleet = await screen.findByRole('heading', { name: 'Armada agen' }), table = screen.getByRole('table', { name: 'Daftar server' });
    expect(fleet.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Standar: batas dan tingkat untuk agen', () => {
  const row = (over: Partial<Row>): Row => ({ key: 'x', unit: '%', dir: 'gt', numeric: true, minor: null, warn: 70, crit: 90, confirm: null, default: { minor: null, warn: 70, crit: 90, confirm: null }, custom: false, stats: null, servers: 0, ...over });
  const ev = (key: string, label: string, level: EventRow['level'], over: Partial<EventRow> = {}): EventRow => ({ key, label, description: `${label}: keterangan`, level, default: level, custom: false, ...over });
  const data = (): Standards => ({
    base: [row({ key: 'base:disk', label: 'Disk root terpakai', warn: 85, crit: 95, minor: 75, default: { minor: 75, warn: 85, crit: 95, confirm: null } })],
    agent: [row({ key: 'agent:ssh_fail', label: 'Login SSH gagal', unit: 'kali', minor: 5, warn: 15, crit: 30, default: { minor: 5, warn: 15, crit: 30, confirm: null } })],
    events: [ev('sec:users', 'Akun baru yang bisa login', 'critical'), ev('sec:ports', 'Port baru mendengarkan dari luar', 'minor', { default: 'major', custom: true })],
    packs: []
  });

  it('batas login SSH gagal tampil sebagai kartu tiga batas (tanpa garis ukur 7 hari) dan disimpan ke server dengan kuncinya', async () => {
    const calls = mockApi({ 'GET /api/standards': { body: data() }, 'PUT /api/standards': { body: data() } });
    renderWithProviders(<StandardsPage />);
    const card = (await screen.findByRole('heading', { name: 'Dihitung oleh agen' })).closest('section, div')!.parentElement!.querySelector('section[aria-label="Login SSH gagal"]') as HTMLElement;
    expect(card).toBeTruthy(); expect(within(card).getByLabelText('Batas Minor')).toHaveValue(5); expect(within(card).queryByText(/Belum ada data 7 hari/)).not.toBeInTheDocument();
    const major = within(card).getByLabelText('Batas Major'); await userEvent.clear(major); await userEvent.type(major, '20'); await userEvent.click(within(card).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/standards')).toBe(true)); expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ key: 'agent:ssh_fail', minor: 5, warn: 20, crit: 30 });
  });

  it('tingkat kejadian: tiap jenis punya pilihan Critical, Major, Minor, Info; mengubah mengirim tingkatnya; yang diubah bisa dipulihkan', async () => {
    const calls = mockApi({ 'GET /api/standards': { body: data() }, 'PUT /api/standards/event': { body: data() } });
    renderWithProviders(<StandardsPage />);
    const users = await screen.findByLabelText('Tingkat Akun baru yang bisa login') as HTMLSelectElement;
    expect(users.value).toBe('critical'); expect([...users.options].map((o) => o.textContent)).toEqual(['Critical', 'Major', 'Minor', 'Info']);
    await userEvent.selectOptions(users, 'major'); await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/standards/event')).toBe(true));
    expect(calls.find((c) => c.path === '/api/standards/event')!.body).toEqual({ key: 'sec:users', level: 'major' });
    expect(screen.getAllByText('diubah').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Pulihkan (Major)' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/standards/event')).toHaveLength(2)); expect(calls.filter((c) => c.path === '/api/standards/event')[1]!.body).toEqual({ key: 'sec:ports', reset: true });
  });

  it('tanpa data agen dari server (versi lama), bagian itu tidak tampil dan halaman tetap jalan', async () => {
    mockApi({ 'GET /api/standards': { body: { base: data().base, packs: [] } } });
    renderWithProviders(<StandardsPage />);
    await screen.findByRole('heading', { name: 'Pemeriksaan dasar server' }); expect(screen.queryByRole('heading', { name: 'Dihitung oleh agen' })).not.toBeInTheDocument(); expect(screen.queryByRole('heading', { name: 'Tingkat kejadian dari agen' })).not.toBeInTheDocument();
  });
});
