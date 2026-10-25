// Menyalin teks ke papan klip. API modern (navigator.clipboard) hanya tersedia di HTTPS atau localhost; saat aplikasi dibuka lewat
// alamat http:// di jaringan lab, kita jatuh ke cara lama (menyalin dari kotak teks sementara) supaya tombol Salin tetap bekerja.

/** true bila berhasil. Tidak melempar galat. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* ditolak (izin): coba cara lama */ }
  try {
    const box = document.createElement('textarea');
    box.value = text; box.setAttribute('readonly', ''); box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(box); box.focus(); box.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(box);
    return ok;
  } catch { return false; }
}

/** Mengosongkan papan klip bila bisa (dipakai setelah menyalin rahasia). Diam-diam gagal bila tidak diizinkan. */
export async function clearClipboard(): Promise<void> { await copyText(' '); }
