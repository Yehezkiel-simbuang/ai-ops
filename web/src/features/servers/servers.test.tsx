import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import { installCommand } from './pubkey';
import { ServersPage } from './ServersPage';

afterEach(() => vi.unstubAllGlobals());

const openForm = async () => { await userEvent.click(await screen.findByRole('button', { name: 'Tambah server' })); };

describe('ServersPage: SSH key wajib', () => {
  it('Simpan terkunci sampai kunci privat atau path berkas kunci diisi; lalu mengirim kunci', async () => {
    const calls = mockApi({ 'GET /api/servers': { body: [] }, 'POST /api/servers': { body: { id: 1 } } });
    renderWithProviders(<ServersPage />);
    await openForm();
    await userEvent.type(await screen.findByPlaceholderText('srv-database'), 'srv-1'); await userEvent.type(screen.getByPlaceholderText('10.0.0.5'), '10.0.0.9'); await userEvent.type(screen.getByPlaceholderText('ops'), 'aiops');
    const save = screen.getByRole('button', { name: 'Simpan' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('-----BEGIN OPENSSH PRIVATE KEY-----'), 'KUNCI');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/servers')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ name: 'srv-1', host: '10.0.0.9', username: 'aiops', ssh_key: 'KUNCI' });
  });
  it('path berkas kunci juga cukup', async () => {
    mockApi({ 'GET /api/servers': { body: [] } });
    renderWithProviders(<ServersPage />);
    await openForm();
    const save = await screen.findByRole('button', { name: 'Simpan' });
    expect(save).toBeDisabled(); await userEvent.type(screen.getByPlaceholderText(/ssh_key \(alternatif/), '/run/secrets/ssh_key');
    expect(save).toBeEnabled();
  });
});

describe('ServersPage: bantuan', () => {
  it('formulir menautkan ke panduan kunci SSH', async () => {
    mockApi({ 'GET /api/servers': { body: [] } });
    renderWithProviders(<ServersPage />);
    const links = await screen.findAllByRole('link', { name: /panduan/ });
    expect(links.every((l) => l.getAttribute('href') === '/panduan?bagian=kunci')).toBe(true); expect(links.length).toBeGreaterThanOrEqual(1);
  });
});

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
const server = (over = {}) => ({ id: 3, name: 'srv-a', host: '10.0.0.9', port: 22, username: 'aiops', key_path: '', has_ssh_key: true, ssh_pub: '', use_sudo: false, services: '', notes: '',  exec_via: 'auto', last_status: 'ok', os_info: '', open_alerts: 0, ...over });

describe('ServersPage: memasukkan kunci', () => {
  const fill = async () => {
    await userEvent.type(await screen.findByPlaceholderText('srv-database'), 'srv-1'); await userEvent.type(screen.getByPlaceholderText('10.0.0.5'), '10.0.0.9'); await userEvent.type(screen.getByPlaceholderText('ops'), 'aiops');
  };
  it('pilih berkas kunci: isinya dibaca ke kolom kunci; berkas yang bukan kunci privat ditolak', async () => {
    mockApi({ 'GET /api/servers': { body: [] } });
    renderWithProviders(<ServersPage />);
    await openForm();
    await fill();
    const input = screen.getByLabelText('Berkas kunci privat') as HTMLInputElement;
    await userEvent.upload(input, new File(['bukan kunci'], 'catatan.txt', { type: 'text/plain' }));
    expect(await screen.findByText(/bukan kunci privat SSH/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Simpan' })).toBeDisabled();
    await userEvent.upload(input, new File([PEM], 'aiops_key'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Simpan' })).toBeEnabled()); expect(screen.getByPlaceholderText('-----BEGIN OPENSSH PRIVATE KEY-----')).toHaveValue(PEM);
  });
  it('buat kunci otomatis: Simpan aktif tanpa menempel, permintaan memakai generate_key, lalu kunci publik ditampilkan', async () => {
    const calls = mockApi({ 'GET /api/servers': { body: [] }, 'POST /api/servers': { body: { id: 5, ssh_pub: 'ssh-ed25519 AAAAC3Nz aiops-srv-1' } } });
    renderWithProviders(<ServersPage />);
    await openForm();
    await fill();
    expect(screen.getByRole('button', { name: 'Simpan' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Buat kunci otomatis' }));
    expect(screen.getByText('Kunci belum dibuat.')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Simpan dan buat kunci' })[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/servers')).toBe(true));
    const body = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>; expect(body.generate_key).toBe(true); expect(body.ssh_key).toBeUndefined();
    expect(await screen.findByText('Pasang kunci publik di server')).toBeInTheDocument(); expect(screen.getByText(/echo 'ssh-ed25519 AAAAC3Nz aiops-srv-1' >>/)).toBeInTheDocument(); expect(screen.getByText(/untuk pengguna "aiops"/)).toBeInTheDocument();
  });
  it('server dengan kunci publik tersimpan punya tombol untuk menampilkannya lagi; yang kuncinya ditempel tidak', async () => {
    mockApi({ 'GET /api/servers': { body: [server({ ssh_pub: 'ssh-ed25519 AAAA aiops-srv-a' }), server({ id: 4, name: 'srv-b' })] } });
    renderWithProviders(<ServersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Aksi lain srv-a' })); await userEvent.click(screen.getByRole('menuitem', { name: 'Kunci publik' }));
    expect(await screen.findByText(/echo 'ssh-ed25519 AAAA aiops-srv-a'/)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}'); await userEvent.click(screen.getByRole('button', { name: 'Aksi lain srv-b' })); expect(screen.queryByRole('menuitem', { name: 'Kunci publik' })).not.toBeInTheDocument(); expect(screen.getByRole('menuitem', { name: 'Hapus' })).toBeInTheDocument();
  });
});

describe('dialog kunci publik', () => {
  it('kunci publik tidak menutup sendiri dan tidak mengosongkan papan klip (bukan rahasia)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });   // user-event memasang papan klip tiruannya sendiri
      mockApi({ 'GET /api/servers': { body: [server({ ssh_pub: 'ssh-ed25519 AAAA aiops-srv-a' })] } });
      renderWithProviders(<ServersPage />);
      await user.click(await screen.findByRole('button', { name: 'Aksi lain srv-a' })); await user.click(screen.getByRole('menuitem', { name: 'Kunci publik' }));
      expect(await screen.findByText(/echo 'ssh-ed25519 AAAA aiops-srv-a'/)).toBeInTheDocument();
      expect(screen.queryByText(/Disembunyikan otomatis/)).not.toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(screen.getByText(/echo 'ssh-ed25519 AAAA aiops-srv-a'/)).toBeInTheDocument();   // masih tampil setelah 60 detik
      await user.click(screen.getByRole('button', { name: 'Salin' }));
      expect(await navigator.clipboard.readText()).toBe(installCommand('ssh-ed25519 AAAA aiops-srv-a', 'aiops'));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await navigator.clipboard.readText()).toBe(installCommand('ssh-ed25519 AAAA aiops-srv-a', 'aiops'));   // papan klip tidak dikosongkan menyusul
    } finally { vi.useRealTimers(); }
  });
});

describe('uji koneksi gagal', () => {
  it('galat yang dikenali menampilkan penyebab dan saran, dan menawarkan panduan', async () => {
    mockApi({
      'GET /api/servers': { body: [server()] },
      'POST /api/servers/3/test': { body: { ok: false, error: 'ubuntu@10.0.0.9: Permission denied (publickey,keyboard-interactive).', hint: 'Server menolak kunci. Penyebab tersering: kunci publik belum ada di authorized_keys.' } }
    });
    renderWithProviders(<ServersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Uji koneksi' }));
    expect(await screen.findByText(/Koneksi ke srv-a gagal/)).toBeInTheDocument();
    expect(screen.getByText(/Permission denied \(publickey,keyboard-interactive\)/)).toBeInTheDocument(); expect(screen.getByText(/Server menolak kunci/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buka panduan' })).toBeInTheDocument();
  });
  it('galat tanpa saran tetap tampil sebagai pesan singkat', async () => {
    mockApi({ 'GET /api/servers': { body: [server()] }, 'POST /api/servers/3/test': { body: { ok: false, error: 'Koneksi gagal', hint: '' } } });
    renderWithProviders(<ServersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Uji koneksi' }));
    expect(await screen.findByText('Gagal: Koneksi gagal')).toBeInTheDocument();
  });
});

describe('perintah pasang kunci publik', () => {
  it('menambahkan tanpa menimpa, mengatur izin, dan membawa kuncinya apa adanya', () => {
    const c = installCommand('ssh-ed25519 AAAA aiops-x');
    expect(c).toBe("mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAA aiops-x' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys");
    expect(c).toContain('>>'); expect(c).not.toMatch(/[^>]>[^>]/);   // hanya penambahan (>>), tidak pernah menimpa berkas
  });
  it('dengan nama pengguna: kunci masuk ke berkas pengguna itu (bukan yang sedang login), pengguna dicek, dan kepemilikan diatur', () => {
    const c = installCommand('ssh-ed25519 AAAA aiops-x', 'ubuntu');
    expect(c).toContain('getent passwd ubuntu'); expect(c).toContain("echo 'ssh-ed25519 AAAA aiops-x' >> ~ubuntu/.ssh/authorized_keys"); expect(c).toContain("grep -qsF 'ssh-ed25519 AAAA aiops-x'");
    expect(c).toContain('chown -R ubuntu: ~ubuntu/.ssh'); expect(c).toContain('chmod 600 ~ubuntu/.ssh/authorized_keys'); expect(c).toContain('Pengguna ubuntu tidak ada di server ini');
    expect(c).not.toMatch(/(^|[^>])>s*S*authorized_keys/);   // tetap hanya menambah (>>), tidak menimpa berkas kunci
  });
  it('nama pengguna yang tidak wajar tidak disisipkan ke perintah shell', () => {
    for (const bad of ['a; rm -rf /', '$(id)', 'x y', '../root', '']) expect(installCommand('ssh-ed25519 AAAA x', bad)).not.toContain(bad || '@@');
    expect(installCommand('ssh-ed25519 AAAA x', 'a; rm -rf /')).toContain('~/.ssh');
  });
  it('bentuk kunci yang berisiko (tanda kutip atau baris baru) tidak dirakit menjadi perintah shell', () => {
    expect(installCommand("ssh-ed25519 AAAA x'; rm -rf ~ #")).toBe("ssh-ed25519 AAAA x'; rm -rf ~ #");
    expect(installCommand('ssh-ed25519 AAAA x\nlain')).not.toContain('mkdir');
  });
});

describe('ServersPage: tabel', () => {
  const rows = (name = 'Daftar server') => within(screen.getByRole('table', { name })).getAllByRole('row').slice(1);
  it('server bermasalah di atas; pencarian baru muncul bila lebih dari 5 server dan menyaring nama atau alamat', async () => {
    const list = [server({ id: 1, name: 'a-sehat' }), server({ id: 2, name: 'b-turun', last_status: 'tidak terjangkau' }), server({ id: 3, name: 'c-warn', last_status: 'peringatan' })];
    mockApi({ 'GET /api/servers': { body: list } });
    renderWithProviders(<ServersPage />);
    await screen.findByRole('table', { name: 'Daftar server' }); expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('b-turun'), expect.stringContaining('c-warn'), expect.stringContaining('a-sehat')]);
    expect(screen.queryByLabelText('Cari server')).not.toBeInTheDocument();
  });
  it('dengan banyak server: pencarian mempersempit tabel', async () => {
    mockApi({ 'GET /api/servers': { body: Array.from({ length: 7 }, (_, i) => server({ id: i + 1, name: `srv-${i + 1}`, host: `10.0.0.${i + 1}` })) } });
    renderWithProviders(<ServersPage />);
    await userEvent.type(await screen.findByLabelText('Cari server'), 'srv-3'); expect(rows()).toHaveLength(1); expect(rows()[0]).toHaveTextContent('srv-3');
  });
});

describe('ServersPage: tanpa pemantauan berkala', () => {
  it('formulir tidak punya kotak atau interval pemantauan berkala; kolom Status menyebut kapan terakhir terlihat, bukan interval', async () => {
    mockApi({ 'GET /api/servers': { body: [server({ last_seen: Date.now() - 120_000 }), server({ id: 4, name: 'srv-b', last_seen: null })] } });
    renderWithProviders(<ServersPage />);
    expect(await screen.findByText(/terakhir terlihat 2 mnt lalu/)).toBeInTheDocument(); expect(screen.getByText('belum pernah terlihat')).toBeInTheDocument(); expect(screen.queryByText(/dipantau tiap|monitoring mati/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Tambah server' }));
    expect(await screen.findByPlaceholderText('srv-database')).toBeInTheDocument(); expect(screen.queryByText(/Aktifkan monitoring berkala/)).not.toBeInTheDocument(); expect(screen.queryByText('Interval (detik)')).not.toBeInTheDocument();
  });
});
