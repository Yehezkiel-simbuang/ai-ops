import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { SECTIONS } from './content';
import { GuidePage } from './GuidePage';

describe('GuidePage', () => {
  it('menampilkan semua bagian bernomor dan daftar isi; SSH key ditegaskan wajib', () => {
    renderWithProviders(<GuidePage />);
    expect(screen.getByRole('heading', { name: 'Panduan' })).toBeInTheDocument();
    for (const [i, s] of SECTIONS.entries()) expect(screen.getByRole('heading', { name: `${i + 1}. ${s.title}` })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Daftar isi panduan' })).toBeInTheDocument();
    expect(screen.getByText(/hanya memakai kunci SSH/)).toBeInTheDocument();
    expect(screen.getByText(/Login dengan password tidak didukung/, { selector: 'p' })).toBeInTheDocument();
  });
  it('perintah bisa disalin apa adanya', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    renderWithProviders(<GuidePage />);
    await userEvent.click(screen.getByRole('button', { name: 'Salin: macOS / Linux: buat kunci' }));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('ssh-keygen -t ed25519 -f ~/.ssh/aiops_key'));
  });
  it('klik daftar isi menandai bagian aktif', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderWithProviders(<GuidePage />);
    const link = screen.getByRole('button', { name: 'Layanan tanpa SSH (Vercel, Supabase, hosting biasa)' });
    await userEvent.click(link);
    expect(link).toHaveAttribute('aria-current', 'true');
  });
});

describe('GuidePage: tautan dari halaman lain', () => {
  it('?bagian=agen membuka panduan pada bagian agen dan menandainya aktif; panduan memuat versi Windows dan syarat HTTPS agen', () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderWithProviders(<GuidePage />, { route: '/panduan?bagian=agen' });
    expect(screen.getByRole('button', { name: 'Pasang agen di server (opsional)' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Windows: buat kunci')).toBeInTheDocument(); expect(screen.getByText(/Agen menolak alamat/)).toBeInTheDocument();
    expect(screen.getAllByText(/Get-Content/, { selector: 'pre' }).length).toBeGreaterThan(0);
  });
});

describe('GuidePage: rujukan antar bagian', () => {
  it('setiap "bagian N" menunjuk ke bagian yang judulnya sesuai maksud rujukan', () => {
    const idOf = (n: number) => SECTIONS[n - 1]!.id;
    expect(idOf(2)).toBe('kunci'); expect(idOf(3)).toBe('server'); expect(idOf(4)).toBe('tambah'); expect(idOf(5)).toBe('ai');
    expect(idOf(6)).toBe('agen'); expect(idOf(7)).toBe('layanan'); expect(idOf(8)).toBe('lab'); expect(idOf(9)).toBe('playground'); expect(idOf(10)).toBe('masalah');
    expect(SECTIONS).toHaveLength(10);   // rujukan "bagian N" di content.tsx mengikuti urutan ini; ubah bersama
  });
});
