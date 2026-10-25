import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { mockApi, renderWithProviders } from '@/test/utils';
import { buildPayload, initialForm, peakVus, problems, stagePreset, totalSeconds } from './form';
import { draft, finished, listItem, running, status } from './fixtures';
import { LoadTestDetailPage } from './LoadTestDetailPage';
import { LoadTestsPage } from './LoadTestsPage';
import { NewLoadTestForm } from './NewLoadTestForm';
import type { Analysis } from './types';

afterEach(() => vi.unstubAllGlobals());

describe('form (logika murni)', () => {
  it('preset tahap, total durasi, dan puncak', () => {
    expect(stagePreset('cepat')).toEqual([{ vus: 5, seconds: 15 }, { vus: 20, seconds: 15 }, { vus: 80, seconds: 15 }]);
    expect(totalSeconds(stagePreset('bertahap'))).toBe(150); expect(peakVus(stagePreset('panjang'))).toBe(400);
  });
  it('masalah terdeteksi sebelum kirim; konfirmasi bukan-produksi wajib', () => {
    const f = initialForm();
    expect(problems(f)).toEqual(expect.arrayContaining(['Nama uji wajib diisi', 'Target harus berupa alamat http:// atau https://', 'Centang konfirmasi bahwa target BUKAN produksi']));
    const ok = { ...f, name: 'x', target: 'http://10.0.0.5:8080', confirm: true };
    expect(problems(ok)).toEqual([]);
    expect(problems({ ...ok, requests: [{ ...f.requests[0]!, path: 'tanpa-slash' }] })).toContain('Path request harus diawali /');
    expect(problems({ ...ok, stages: [{ vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }, { vus: 10, seconds: 600 }] })).toContain('Total durasi maksimal 3600 detik');
  });
  it('muatan: baris kosong dibuang, target dirapikan, badan kosong tidak dikirim', () => {
    const f = { ...initialForm(), name: ' Uji ', target: ' http://10.0.0.5:8080/ ', headers: [{ key: ' Authorization ', value: 'Bearer x' }, { key: '', value: 'abaikan' }], scrape: [{ label: 'a', url: 'http://10.0.0.5/m', metric: 'm' }, { label: '', url: '', metric: '' }], confirm: true };
    f.requests = [{ name: '', method: 'POST', path: ' /x ', weight: 2, body: '   ' }];
    expect(buildPayload(f)).toMatchObject({ name: 'Uji', target: 'http://10.0.0.5:8080', confirmNotProduction: true, headers: { Authorization: 'Bearer x' }, scrape: [{ label: 'a', url: 'http://10.0.0.5/m', metric: 'm' }] });
    expect(buildPayload(f).requests).toEqual([{ name: '/x', method: 'POST', path: '/x', weight: 2, body: undefined }]);
  });
});

describe('NewLoadTestForm', () => {
  it('tombol simpan terkunci sampai nama, target, dan konfirmasi bukan-produksi terisi; lalu mengirim muatan yang benar', async () => {
    const calls = mockApi({ 'POST /api/loadtests': { body: { id: 9 } } });
    const created = vi.fn();
    renderWithProviders(<NewLoadTestForm status={status} onCreated={created} onCancel={() => undefined} />);
    const save = screen.getByRole('button', { name: /Simpan sebagai draf/ });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Proyek A, 1 server/), 'Uji proyek A');
    await userEvent.type(screen.getByLabelText('Target'), 'http://10.0.0.5:8080');
    expect(save).toBeDisabled();   // konfirmasi belum dicentang
    await userEvent.click(screen.getByRole('checkbox', { name: /BUKAN server produksi/ }));
    expect(save).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cepat (5, 20, 80 pengguna x 15 dtk)' }));
    await userEvent.click(save);
    await waitFor(() => expect(created).toHaveBeenCalledWith(9));
    expect(calls[0]!.body).toMatchObject({ name: 'Uji proyek A', target: 'http://10.0.0.5:8080', confirmNotProduction: true, stages: [{ vus: 5, seconds: 15 }, { vus: 20, seconds: 15 }, { vus: 80, seconds: 15 }], criteria: { p95Ms: 1000, errPct: 1 } });
  });
  it('menambah dan menghapus request dan tahap; request terakhir tidak bisa dihapus', async () => {
    renderWithProviders(<NewLoadTestForm status={status} onCreated={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Hapus request' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Tambah request' }));
    expect(screen.getAllByLabelText('Path')).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Hapus request' })[0]!);
    expect(screen.getAllByLabelText('Path')).toHaveLength(1);
    const before = screen.getAllByLabelText(/Pengguna tahap/).length;
    await userEvent.click(screen.getByRole('button', { name: 'Tambah tahap' }));
    expect(screen.getAllByLabelText(/Pengguna tahap/)).toHaveLength(before + 1);
  });
  it('menampilkan host yang diizinkan dari pengaturan', () => {
    renderWithProviders(<NewLoadTestForm status={status} onCreated={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText(/staging\.contoh\.com/)).toBeInTheDocument();
  });
});

const detail = (route: string) => renderWithProviders(<Routes><Route path="/uji-beban/:id" element={<LoadTestDetailPage />} /></Routes>, { route });

describe('LoadTestDetailPage', () => {
  it('draf: belum berjalan; setujui meminta konfirmasi rinci lalu mengirim persetujuan', async () => {
    const calls = mockApi({ 'GET /api/loadtests/5': { body: draft() }, 'POST /api/loadtests/5/run': { body: { status: 'queued' } } });
    detail('/uji-beban/5');
    expect(await screen.findByText(/masih draf dan belum berjalan/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Setujui dan jalankan' }));
    const dlg = await screen.findByText(/Menjalankan uji beban ke http:\/\/10\.0\.0\.5:8080/);
    expect(dlg).toHaveTextContent('3 tahap, puncak 80 pengguna, total 30 detik'); expect(dlg).toHaveTextContent('BUKAN server produksi');
    expect(calls.some((c) => c.path.endsWith('/run'))).toBe(false);   // belum ada yang berjalan sebelum konfirmasi
    await userEvent.click(within(dlg.closest('dialog')!).getByRole('button', { name: 'Setujui dan jalankan' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/loadtests/5/run')).toBe(true));
  });
  it('batal di dialog tidak menjalankan uji', async () => {
    const calls = mockApi({ 'GET /api/loadtests/5': { body: draft() } });
    detail('/uji-beban/5');
    await userEvent.click(await screen.findByRole('button', { name: 'Setujui dan jalankan' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Batal' }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('selesai: kesimpulan, lutut dan tahap sehat terakhir ditandai, hasil per tahap, metrik server, hasil tidak murni diberi peringatan', async () => {
    mockApi({ 'GET /api/loadtests/5': { body: finished() } });
    detail('/uji-beban/5');
    expect(await screen.findByText(/Sehat sampai 20 pengguna/)).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(within(rows.find((r) => r.textContent?.startsWith('3'))!).getByText('lutut')).toBeInTheDocument();
    expect(screen.getByText('sehat terakhir')).toBeInTheDocument();
    expect(screen.getByText('tidak murni')).toBeInTheDocument();   // CPU pembangkit 90% pada tahap 3
    expect(screen.getByText('Metrik server uji per tahap (rata-rata / puncak)')).toBeInTheDocument(); expect(screen.getByText('7.0 / 8.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jalankan lagi' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Setujui dan jalankan' })).not.toBeInTheDocument();
  });
  const aiDone = { status: 'done' as const, text: 'Dugaan: pool DB jenuh.', model: 'm-murah', error: '', ts: Date.now() - 60_000 };
  it('penjelasan AI: tombol memulai pekerjaan di server, menunjukkan sedang berjalan dan bahwa boleh pindah halaman, lalu hasil muncul sendiri', async () => {
    let ai: unknown = null;
    const calls = mockApi({ 'GET /api/loadtests/5': () => ({ body: { ...finished(), ai } }), 'POST /api/loadtests/5/explain': () => { ai = { status: 'running', text: '', model: '', error: '', ts: Date.now() }; return { body: { status: 'running' } }; } });
    const { client } = detail('/uji-beban/5');
    await userEvent.click(await screen.findByRole('button', { name: 'Jelaskan hasil ini' }));
    expect(await screen.findByRole('button', { name: 'Sedang menjelaskan...' })).toBeDisabled(); expect(screen.getByText(/boleh pindah halaman atau tab/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/loadtests/5/explain')).toHaveLength(1);
    ai = aiDone; await client.invalidateQueries({ queryKey: ['loadtests', 'detail', 5] });   // server selesai; polling mengambilnya
    expect(await screen.findByText(/pool DB jenuh/)).toBeInTheDocument(); expect(screen.getByText(/Ditulis AI .m-murah./)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Minta ulang' })).toBeEnabled();
  });
  it('penjelasan AI: yang sudah jadi di server langsung tampil saat halaman dibuka lagi, tanpa meminta ulang', async () => {
    const calls = mockApi({ 'GET /api/loadtests/5': { body: { ...finished(), ai: aiDone } } });
    detail('/uji-beban/5');
    expect(await screen.findByText(/pool DB jenuh/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('penjelasan AI: yang gagal menampilkan alasannya dan bisa dicoba lagi', async () => {
    mockApi({ 'GET /api/loadtests/5': { body: { ...finished(), ai: { status: 'failed', text: '', model: '', error: 'model tidak menjawab', ts: Date.now() } } } });
    detail('/uji-beban/5');
    expect(await screen.findByText(/Penjelasan gagal dibuat: model tidak menjawab/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Coba lagi' })).toBeEnabled();
  });
  it('berjalan: progres tahap dan tombol batalkan; menekan batalkan mengirim permintaan', async () => {
    const calls = mockApi({ 'GET /api/loadtests/5': { body: running() }, 'POST /api/loadtests/5/cancel': { body: { ok: true } } });
    detail('/uji-beban/5');
    expect(await screen.findByText(/1 dari 3 tahap sudah dilaporkan/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hapus uji' })).not.toBeInTheDocument();   // tidak bisa dihapus saat berjalan
    await userEvent.click(screen.getByRole('button', { name: 'Batalkan' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/loadtests/5/cancel')).toBe(true));
  });
  it('gagal: pesan galat dari runner ditampilkan', async () => {
    mockApi({ 'GET /api/loadtests/5': { body: { ...draft(), status: 'failed', error: 'Target ditolak runner: host menunjuk ke alamat publik' } } });
    detail('/uji-beban/5');
    expect(await screen.findByText(/Target ditolak runner/)).toBeInTheDocument();
  });
});

describe('LoadTestsPage', () => {
  const none: Analysis = { healthy: null, knee: null, plateau: null, invalidStages: [], verdict: { tone: 'mute', title: 'Belum ada hasil', text: '' } };
  it('daftar uji dengan status dan ringkasan hasil; runner online ditampilkan', async () => {
    mockApi({
      'GET /api/loadtests/status': { body: status },
      'GET /api/loadtests': { body: [listItem({ id: 2, name: 'Uji selesai', status: 'done' }, 3, { ...none, verdict: { tone: 'warn', title: 'Sehat sampai 20 pengguna', text: '' } }), listItem({ id: 1, name: 'Uji jalan', status: 'running' }, 1)] }
    });
    renderWithProviders(<LoadTestsPage />);
    expect(await screen.findByText('Uji selesai')).toBeInTheDocument();
    expect(screen.getByText('Sehat sampai 20 pengguna')).toBeInTheDocument(); expect(screen.getByText('Berjalan 1/3')).toBeInTheDocument(); expect(screen.getByText('runner online')).toBeInTheDocument();
  });
  it('fitur belum aktif: petunjuk mengaktifkan dan tombol Uji baru dimatikan', async () => {
    mockApi({ 'GET /api/loadtests/status': { body: { ...status, enabled: false } }, 'GET /api/loadtests': { body: [] } });
    renderWithProviders(<LoadTestsPage />);
    expect(await screen.findByText(/rahasia runner belum disetel/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Uji baru' })).toBeDisabled();
  });
  it('runner offline: petunjuk menyalakan runner; daftar kosong diberi arahan', async () => {
    mockApi({ 'GET /api/loadtests/status': { body: { ...status, runner: { online: false, lastSeen: null, info: null } } }, 'GET /api/loadtests': { body: [] } });
    renderWithProviders(<LoadTestsPage />);
    expect(await screen.findByText(/Runner pembangkit beban belum terhubung/)).toBeInTheDocument();
    expect(await screen.findByText(/Belum ada uji beban/)).toBeInTheDocument();
  });
});
