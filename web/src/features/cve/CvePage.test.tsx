import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { mockApi, renderWithProviders } from '@/test/utils';
import { CvePage } from './CvePage';
import type { CveLookup, ServerVerdict } from './types';

afterEach(() => vi.unstubAllGlobals());

const srv = (over: Partial<ServerVerdict>): ServerVerdict => ({
  server_id: 1, name: 'srv-cloud', host: '148.230.102.209', hasAgent: false, publicHost: true, os: 'Ubuntu 24.04', release: 'noble', kernel: '6.8.0-147-generic', verdict: 'rentan_tanpa_patch',
  packages: [{ name: 'linux', status: 'pending', fixed: '6.8.0-149.149', installed: null, verdict: 'rentan_tanpa_patch', text: 'Belum dirilis; perbaikan disiapkan di 6.8.0-149.149' }], note: null, kernelPkg: true, ...over
});
const lookup = (over: Partial<CveLookup> = {}): CveLookup => ({
  id: 'CVE-2026-98432', found: true, sources: { ubuntu: 'ok', osv: 'ok' }, summary: 'ipv4: free inet_opt and ireq_opt after an RCU grace period', description: 'In the Linux kernel...', published: '2026-10-15T00:00:00', updated: '2026-10-30T19:44:25',
  priority: 'high', cvss: 9.8, vector: 'CVSS:3.1/AV:N/AC:L', kev: false, mitigation: '', notices: [], references: ['https://www.cve.org/CVERecord?id=CVE-2026-98432'],
  matrix: [{ name: 'linux', statuses: { noble: { status: 'pending', fixed: '6.8.0-149.149' }, focal: { status: 'needed', fixed: '' } } }], matrixTotal: 14, matrixReleases: ['noble', 'focal'], releaseLabels: { noble: 'Ubuntu 24.04', focal: 'Ubuntu 20.04' },
  servers: [srv({}), srv({ server_id: 2, name: 'srv-lama', host: '10.0.0.9', verdict: 'tidak_diketahui', packages: [], note: 'OS CentOS 7 belum dinilai (baru Ubuntu).', publicHost: false, kernelPkg: false })],
  advice: [
    { kind: 'resmi', title: 'Mitigasi dari Ubuntu', text: 'Ubuntu tidak menerbitkan mitigasi atau workaround untuk CVE ini.' },
    { kind: 'umum', title: 'Pantau rilis patch', text: 'Belum ada perbaikan untuk srv-cloud.' }, { kind: 'umum', title: 'Pasang patch di srv-uji', text: 'Perbarui paket kernel lalu reboot.', link: '/patch/3' }
  ], watching: false, ...over
});
const page = (route = '/cve/CVE-2026-98432') => renderWithProviders(<Routes><Route path="/cve" element={<CvePage />} /><Route path="/cve/:id" element={<CvePage />} /></Routes>, { route });

describe('halaman Cek CVE', () => {
  it('menampilkan ringkasan, penilaian tiap server, saran berlabel resmi dan umum, dan status per rilis', async () => {
    mockApi({ 'GET /api/cve/CVE-2026-98432': { body: lookup() }, 'GET /api/cve': { body: [] } });
    page();
    expect(await screen.findByRole('heading', { name: 'CVE-2026-98432' })).toBeInTheDocument(); expect(screen.getByText(/free inet_opt/)).toBeInTheDocument();
    expect(screen.getByText('prioritas high')).toBeInTheDocument(); expect(screen.getByText('CVSS 9.8')).toBeInTheDocument(); expect(screen.getByText('tidak ada di daftar KEV')).toBeInTheDocument();
    expect(screen.getByText('Rentan, belum ada patch')).toBeInTheDocument(); expect(screen.getByText('Belum bisa dinilai')).toBeInTheDocument(); expect(screen.getByText(/OS CentOS 7 belum dinilai/)).toBeInTheDocument();
    expect(screen.getByText(/linux: Belum dirilis; perbaikan disiapkan di 6\.8\.0-149\.149/)).toBeInTheDocument();
    const advice = within(screen.getByRole('heading', { name: 'Yang bisa dilakukan' }).parentElement!.querySelector('ul')!);   // hanya daftarnya, bukan catatan di bawahnya
    expect(advice.getByText('resmi')).toBeInTheDocument(); expect(advice.getAllByText('umum')).toHaveLength(2); expect(advice.getByText(/tidak menerbitkan mitigasi/)).toBeInTheDocument();
    expect(advice.getByRole('link', { name: 'Buka halaman patch' })).toHaveAttribute('href', '/patch/3');
    const tbl = screen.getByRole('table', { name: 'Status per rilis' }); expect(within(tbl).getByText('Ubuntu 24.04')).toBeInTheDocument();
    expect(within(tbl).getByText('disiapkan 6.8.0-149.149')).toBeInTheDocument(); expect(within(tbl).getByText('belum ada')).toBeInTheDocument(); expect(screen.getByText(/Menampilkan 1 dari 14 paket/)).toBeInTheDocument();
  });

  it('tiap server menaut ke inventarisnya; KEV yang aktif ditandai merah', async () => {
    mockApi({ 'GET /api/cve/CVE-2026-98432': { body: lookup({ kev: true }) }, 'GET /api/cve': { body: [] } });
    page(); expect(await screen.findByText('sedang dieksploitasi (CISA KEV)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /srv-cloud/ })).toHaveAttribute('href', '/inventaris/1');
  });

  it('Pantau mengirim permintaan lalu tombolnya berganti; CVE yang sudah dipantau bisa dihentikan', async () => {
    let watching = false;
    const calls = mockApi({
      'GET /api/cve/CVE-2026-98432': () => ({ body: lookup({ watching }) }), 'GET /api/cve': () => ({ body: watching ? [{ cve: 'CVE-2026-98432', created: 1, last_check: Date.now(), notified: null, state: [{ key: 'linux@noble', value: 'pending 6.8.0-149.149' }] }] : [] }),
      'POST /api/cve/CVE-2026-98432/watch': () => { watching = true; return { body: { ok: true } }; }, 'DELETE /api/cve/CVE-2026-98432/watch': () => { watching = false; return { body: { ok: true } }; }
    });
    page(); await userEvent.click(await screen.findByRole('button', { name: 'Pantau perkembangan perbaikan' }));
    expect(await screen.findByRole('button', { name: 'Berhenti memantau' })).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST' && c.path === '/api/cve/CVE-2026-98432/watch')).toBe(true);
    expect(await screen.findByText(/linux@noble: pending 6\.8\.0-149\.149/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Berhenti memantau' })); expect(await screen.findByRole('button', { name: 'Pantau perkembangan perbaikan' })).toBeInTheDocument();
  });

  it('CVE tidak ditemukan dan sumber gagal dijelaskan, bukan dibiarkan kosong', async () => {
    mockApi({ 'GET /api/cve/CVE-2026-00001': { body: lookup({ id: 'CVE-2026-00001', found: false, sources: { ubuntu: 'tidak ada', osv: 'tidak ada' }, servers: [], advice: [], matrix: [] }) }, 'GET /api/cve': { body: [] } });
    const a = page('/cve/CVE-2026-00001'); expect(await screen.findByText(/tidak ditemukan di tracker Ubuntu maupun OSV\.dev/)).toBeInTheDocument(); a.unmount(); vi.unstubAllGlobals();
    mockApi({ 'GET /api/cve/CVE-2026-00002': { status: 502, body: { error: 'Sumber data kerentanan tidak terjangkau dari server aplikasi.' } }, 'GET /api/cve': { body: [] } });
    page('/cve/CVE-2026-00002'); expect(await screen.findByText(/Gagal memuat: Sumber data kerentanan tidak terjangkau/)).toBeInTheDocument();
  });

  it('formulir: nomor tidak valid ditolak tanpa permintaan; nomor valid (huruf kecil pun) membuka hasilnya', async () => {
    const calls = mockApi({ 'GET /api/cve': { body: [] }, 'GET /api/cve/CVE-2026-98432': { body: lookup() } });
    page('/cve'); const input = screen.getByRole('textbox', { name: 'Nomor CVE' });
    await userEvent.type(input, 'bukan cve'); await userEvent.click(screen.getByRole('button', { name: 'Cek' }));
    expect(await screen.findByText(/Format CVE tidak valid/)).toBeInTheDocument(); expect(calls.some((c) => c.path.startsWith('/api/cve/'))).toBe(false);
    await userEvent.clear(input); await userEvent.type(input, 'cve-2026-98432'); await userEvent.click(screen.getByRole('button', { name: 'Cek' }));
    expect(await screen.findByRole('heading', { name: 'CVE-2026-98432' })).toBeInTheDocument(); await waitFor(() => expect(calls.some((c) => c.path === '/api/cve/CVE-2026-98432')).toBe(true));
  });

  it('alamat dengan nomor tidak valid memberi petunjuk dan tidak memanggil server', async () => {
    const calls = mockApi({ 'GET /api/cve': { body: [] } }); page('/cve/CVE-12');
    expect(await screen.findByText(/bukan nomor CVE yang valid/)).toBeInTheDocument(); expect(calls.some((c) => c.path.startsWith('/api/cve/'))).toBe(false);
  });
});
