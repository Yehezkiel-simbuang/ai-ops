import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { mockApi, renderWithProviders } from '@/test/utils';
import type { Credential, InventoryRow, MaintenanceTask } from '@/api/types';
import { pageWindow, paginate, sortRows } from '@/lib/grid';
import { InventoryPage } from './InventoryPage';
import { NO_FILTERS, activeCount, applyFilters, chips, options, removeChip } from './inventoryFilters';

afterEach(() => { vi.unstubAllGlobals(); try { localStorage.clear(); } catch { /* abaikan */ } });

const row = (id: number, over: Partial<InventoryRow> = {}): InventoryRow => ({
  id, name: `srv-${String(id).padStart(2, '0')}`, host: `10.0.0.${id}`, port: 22, username: 'ops', os_info: 'Ubuntu 24.04', primary_address: null, purpose: `fungsi ${id}`, tags: [], owner: '', environment: 'dev',
  overdue: 0, next_due: null, credentials: 0, rotation_due: 0, ...over
});

describe('grid (logika murni)', () => {
  it('sortRows: angka alami, nilai kosong selalu di akhir, tidak mengubah aslinya', () => {
    const src = ['srv-10', 'srv-2', '', 'srv-1']; const asc = sortRows(src, (x) => x, 'asc');
    expect(asc).toEqual(['srv-1', 'srv-2', 'srv-10', '']); expect(sortRows(src, (x) => x, 'desc')).toEqual(['srv-10', 'srv-2', 'srv-1', '']); expect(src).toEqual(['srv-10', 'srv-2', '', 'srv-1']);
    expect(sortRows([3, 1, 2], (x) => x, 'asc')).toEqual([1, 2, 3]); expect(sortRows([3, 1], undefined, 'asc')).toEqual([3, 1]);
  });
  it('paginate: potongan, rentang tampilan, dan halaman di luar rentang dirapikan', () => {
    const rows = Array.from({ length: 23 }, (_, i) => i + 1);
    expect(paginate(rows, 1, 10)).toMatchObject({ items: rows.slice(0, 10), page: 1, pages: 3, total: 23, from: 1, to: 10 }); expect(paginate(rows, 3, 10)).toMatchObject({ items: [21, 22, 23], from: 21, to: 23 });
    expect(paginate(rows, 99, 10).page).toBe(3); expect(paginate(rows, 0, 10).page).toBe(1); expect(paginate([], 1, 10)).toMatchObject({ items: [], pages: 1, from: 0, to: 0, total: 0 });
  });
  it('pageWindow: semua bila sedikit; pemisah di tengah bila banyak; selalu memuat pertama, terakhir, dan sekitar aktif', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]); expect(pageWindow(1, 20)).toEqual([1, 2, null, 19, 20]); expect(pageWindow(10, 20)).toEqual([1, 2, null, 9, 10, 11, null, 19, 20]); expect(pageWindow(20, 20)).toEqual([1, 2, null, 19, 20]);
    expect(pageWindow(4, 9)).toEqual([1, 2, 3, 4, 5, null, 8, 9]);
  });
});

describe('saringan inventaris (logika murni)', () => {
  const rows = [
    row(1, { environment: 'prod', tags: ['db', 'kritis'], owner: 'Andi', overdue: 2, credentials: 3, rotation_due: 1 }), row(2, { environment: 'staging', tags: ['web'], owner: 'Budi', next_due: 5, credentials: 1 }),
    row(3, { environment: 'dev', tags: ['db'], owner: 'Andi' }), row(4, { environment: 'prod', tags: [], owner: '' })
  ];
  const ids = (f: Partial<typeof NO_FILTERS>) => applyFilters(rows, { ...NO_FILTERS, ...f }).map((r) => r.id);
  it('tiap saringan, dan gabungan (AND antar kelompok, OR dalam kelompok)', () => {
    expect(ids({})).toEqual([1, 2, 3, 4]); expect(ids({ env: ['prod'] })).toEqual([1, 4]); expect(ids({ env: ['prod', 'dev'] })).toEqual([1, 3, 4]); expect(ids({ tags: ['db'] })).toEqual([1, 3]); expect(ids({ tags: ['db', 'web'] })).toEqual([1, 2, 3]);
    expect(ids({ owner: 'Andi' })).toEqual([1, 3]); expect(ids({ maint: 'terlambat' })).toEqual([1]); expect(ids({ maint: 'terjadwal' })).toEqual([2]); expect(ids({ maint: 'tanpa' })).toEqual([3, 4]);
    expect(ids({ cred: 'punya' })).toEqual([1, 2]); expect(ids({ cred: 'tanpa' })).toEqual([3, 4]); expect(ids({ cred: 'ganti' })).toEqual([1]);
    expect(ids({ env: ['prod'], owner: 'Andi', tags: ['db'] })).toEqual([1]); expect(ids({ env: ['staging'], owner: 'Andi' })).toEqual([]);
  });
  it('options, activeCount, chips, removeChip', () => {
    expect(options(rows)).toEqual({ env: ['prod', 'staging', 'dev', 'lab'], tags: ['db', 'kritis', 'web'], owners: ['Andi', 'Budi'] });
    const f = { ...NO_FILTERS, env: ['prod', 'dev'], tags: ['db'], cred: 'ganti' as const };
    expect(activeCount(f)).toBe(3); expect(chips(f).map((c) => c.id)).toEqual(['env:prod', 'env:dev', 'tag:db', 'cred']);
    expect(removeChip(f, 'env:prod').env).toEqual(['dev']); expect(removeChip(f, 'cred').cred).toBe(''); expect(removeChip(f, 'tag:db').tags).toEqual([]);
  });
});

describe('InventoryPage: tabel server', () => {
  const many = Array.from({ length: 27 }, (_, i) => row(i + 1, { environment: i % 3 === 0 ? 'prod' : 'dev', tags: i % 2 ? ['db'] : ['web'], owner: i < 5 ? 'Andi' : 'Budi', overdue: i === 0 ? 1 : 0, credentials: i % 4 }));
  const api = (rows = many) => mockApi({ 'GET /api/inventory': { body: rows }, 'GET /api/inventory?q=cari': { body: rows.slice(0, 3) } });
  const bodyRows = () => within(screen.getByRole('table', { name: 'Daftar server' })).getAllByRole('row').slice(1);

  it('menampilkan 10 baris pertama dengan penomoran halaman; pindah halaman dan ubah ukuran halaman', async () => {
    api(); renderWithProviders(<InventoryPage />);
    expect(await screen.findByText('Menampilkan 1 sampai 10 dari 27')).toBeInTheDocument(); expect(bodyRows()).toHaveLength(10); expect(bodyRows()[0]).toHaveTextContent('srv-01');
    await userEvent.click(screen.getByRole('button', { name: 'Halaman 3' })); expect(screen.getByText('Menampilkan 21 sampai 27 dari 27')).toBeInTheDocument(); expect(bodyRows()).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Halaman berikutnya' })).toBeDisabled(); await userEvent.click(screen.getByRole('button', { name: 'Halaman sebelumnya' })); expect(screen.getByText('Menampilkan 11 sampai 20 dari 27')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Baris per halaman'), '25'); expect(screen.getByText('Menampilkan 1 sampai 25 dari 27')).toBeInTheDocument();   // kembali ke halaman 1
    expect(localStorage.getItem('aiops.inventaris.size')).toBe('25');
  });

  it('urutkan per kolom: naik, turun, lalu kembali bawaan; kembali ke halaman 1', async () => {
    api(); renderWithProviders(<InventoryPage />);
    await screen.findByText('Menampilkan 1 sampai 10 dari 27'); await userEvent.click(screen.getByRole('button', { name: 'Halaman 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Urutkan menurut Server' }));   // bawaan sudah naik menurut nama: klik pertama = turun
    expect(screen.getByRole('columnheader', { name: /Server/ })).toHaveAttribute('aria-sort', 'descending'); expect(screen.getByText('Menampilkan 1 sampai 10 dari 27')).toBeInTheDocument(); expect(bodyRows()[0]).toHaveTextContent('srv-27');
    await userEvent.click(screen.getByRole('button', { name: 'Urutkan menurut Kredensial' })); expect(screen.getByRole('columnheader', { name: /Kredensial/ })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('filter lanjutan: lingkungan dan PIC mempersempit, jumlah dan label aktif tampil, label bisa dihapus satu per satu, dan Hapus semua mengembalikan', async () => {
    api(); renderWithProviders(<InventoryPage />);
    await screen.findByText('27 dari 27 server'); await userEvent.click(screen.getByRole('button', { name: /Filter lanjutan/ }));
    const panel = screen.getByRole('group', { name: 'Filter lanjutan' });
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'prod' })); expect(screen.getByText('9 dari 27 server')).toBeInTheDocument();   // i % 3 === 0 dari 27 = 9
    await userEvent.selectOptions(within(panel).getByLabelText('PIC'), 'Andi'); expect(screen.getByText('2 dari 27 server')).toBeInTheDocument();   // i = 0 dan 3 (di bawah 5)
    expect(screen.getByRole('button', { name: /Filter lanjutan \(2\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hapus filter PIC: Andi' })); expect(screen.getByText('9 dari 27 server')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hapus semua filter' })); expect(screen.getByText('27 dari 27 server')).toBeInTheDocument();
  });

  it('filter yang tidak cocok dengan apa pun menampilkan pesan, bukan tabel kosong', async () => {
    api([row(1, { environment: 'dev' })]); renderWithProviders(<InventoryPage />);
    await screen.findByText('1 dari 1 server'); await userEvent.click(screen.getByRole('button', { name: /Filter lanjutan/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Filter lanjutan' })).getByRole('checkbox', { name: 'prod' }));
    expect(await screen.findByText(/Tidak ada server yang cocok dengan pencarian atau filter/)).toBeInTheDocument();
  });

  it('pencarian teks dikirim ke server (mencakup port dan layanan), lalu tabel menampilkan hasilnya', async () => {
    const calls = api(); renderWithProviders(<InventoryPage />);
    await screen.findByText('Menampilkan 1 sampai 10 dari 27'); await userEvent.type(screen.getByLabelText('Cari'), 'cari');
    expect(await screen.findByText('Menampilkan 1 sampai 3 dari 3')).toBeInTheDocument(); expect(calls.some((c) => c.path === '/api/inventory?q=cari')).toBe(true);
  });

  it('baris bisa diklik menuju dokumentasi server; sorotan pemeliharaan terlambat tampil', async () => {
    api();
    const Where = () => { const l = useLocation(); return <div data-testid="loc">{l.pathname}</div>; };
    renderWithProviders(<Routes><Route path="/" element={<InventoryPage />} /><Route path="/inventaris/:id" element={<Where />} /></Routes>);
    expect(await screen.findByText(/1 server punya pemeliharaan terlambat/)).toBeInTheDocument();
    await userEvent.click(within(bodyRows()[0]!).getByText('fungsi 1')); expect((await screen.findByTestId('loc')).textContent).toBe('/inventaris/1');
  });
});

describe('InventoryPage: tabel Vault dan Pemeliharaan', () => {
  const cred = (id: number, over: Partial<Credential> = {}): Credential => ({
    id, server_id: 1, server_name: 'srv-01', label: `cred-${String(id).padStart(2, '0')}`, kind: 'ssh', username: 'ops', url: '', port: null, notes: '', has_secret: true, versions: 1, age_days: 10, rotated_at: 1_700_000_000_000 + id,
    last_revealed: null, rotate_every_days: null, rotation_due_at: null, rotation_overdue: false, expires_at: null, expired: false, ...over
  } as Credential);
  const task = (id: number, over: Partial<MaintenanceTask> = {}): MaintenanceTask => ({
    id, server_id: 1, server_name: 'srv-01', title: `tugas-${String(id).padStart(2, '0')}`, description: '', category: 'umum', priority: 'normal', every_days: 30, due_at: 1_800_000_000_000 + id, last_done: null, status: 'ok', ...over
  });
  const rowsOf = (name: string) => within(screen.getByRole('table', { name })).getAllByRole('row').slice(1);

  it('Vault: 12 kredensial dibagi halaman, filter status mempersempit', async () => {
    const list = Array.from({ length: 12 }, (_, i) => cred(i + 1, i === 2 ? { rotation_overdue: true } : i === 3 ? { expired: true } : {}));
    mockApi({ 'GET /api/inventory': { body: [] }, 'GET /api/vault': { body: list } });
    renderWithProviders(<InventoryPage />); await userEvent.click(screen.getByRole('tab', { name: 'Vault kredensial' }));
    expect(await screen.findByText('Menampilkan 1 sampai 10 dari 12')).toBeInTheDocument(); expect(rowsOf('Daftar kredensial')).toHaveLength(10);
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'ganti'); expect(screen.getByText('1 dari 12')).toBeInTheDocument(); expect(rowsOf('Daftar kredensial')[0]).toHaveTextContent('cred-03');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'kedaluwarsa'); expect(rowsOf('Daftar kredensial')[0]).toHaveTextContent('cred-04');
  });

  it('Pemeliharaan: urut jatuh tempo, filter status, dan pencarian di klien', async () => {
    const list = [task(1), task(2, { status: 'terlambat', due_at: 1 }), task(3, { status: 'segera' }), task(4, { title: 'cadangan basis data' })];
    mockApi({ 'GET /api/inventory': { body: [] }, 'GET /api/maintenance': { body: list } });
    renderWithProviders(<InventoryPage />); await userEvent.click(screen.getByRole('tab', { name: 'Pemeliharaan' }));
    expect(await screen.findByText('Menampilkan 1 sampai 4 dari 4')).toBeInTheDocument(); expect(rowsOf('Daftar pemeliharaan')[0]).toHaveTextContent('tugas-02');   // jatuh tempo paling awal di atas
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'segera'); expect(rowsOf('Daftar pemeliharaan')).toHaveLength(1); expect(rowsOf('Daftar pemeliharaan')[0]).toHaveTextContent('tugas-03');
    await userEvent.selectOptions(screen.getByLabelText('Status'), ''); await userEvent.type(screen.getByLabelText('Cari'), 'cadangan');
    expect(await screen.findByText('Menampilkan 1 sampai 1 dari 1')).toBeInTheDocument();
  });
});
