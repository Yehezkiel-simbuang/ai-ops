import { copyText } from './clipboard';

afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });

describe('copyText', () => {
  it('memakai API papan klip bila tersedia (HTTPS atau localhost)', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    expect(await copyText('halo')).toBe(true); expect(write).toHaveBeenCalledWith('halo');
  });

  it('di alamat http:// (API tidak ada) jatuh ke cara lama: menyalin dari kotak teks sementara yang dibersihkan lagi', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    let copied = ''; document.execCommand = vi.fn(() => { copied = (document.activeElement as HTMLTextAreaElement).value; return true; });
    expect(await copyText('skrip pemasangan')).toBe(true); expect(copied).toBe('skrip pemasangan'); expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull();
  });

  it('API menolak (izin) lalu cara lama berhasil; keduanya gagal = false tanpa melempar galat', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('ditolak')) }, configurable: true });
    document.execCommand = vi.fn(() => true); expect(await copyText('x')).toBe(true);
    document.execCommand = vi.fn(() => { throw new Error('tidak didukung'); }); expect(await copyText('x')).toBe(false);
    document.execCommand = vi.fn(() => false); expect(await copyText('x')).toBe(false);
  });
});
