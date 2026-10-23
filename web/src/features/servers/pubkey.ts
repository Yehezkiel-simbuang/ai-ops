const USER_OK = /^[a-z_][a-z0-9_-]{0,31}$/i;

/**
 * Perintah siap tempel di server. Kunci selalu masuk ke berkas milik PENGGUNA SSH yang diisi di formulir (~pengguna), walau perintah
 * dijalankan sebagai root. Menambahkan tanpa menghapus kunci lain (dan tidak menggandakan bila dijalankan ulang), mengatur izin yang diminta sshd, dan memberi kepemilikan ke pengguna itu.
 */
export function installCommand(pub: string, username = ''): string {
  if (/['\n\r]/.test(pub)) return pub;   // bentuk tak terduga: tampilkan kuncinya saja daripada merakit perintah shell yang berisiko
  if (!USER_OK.test(username)) return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${pub}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
  const d = `~${username}/.ssh`;
  return `if getent passwd ${username} >/dev/null; then mkdir -p ${d} && chmod 700 ${d} && { grep -qsF '${pub}' ${d}/authorized_keys || echo '${pub}' >> ${d}/authorized_keys; } && chmod 600 ${d}/authorized_keys && chown -R ${username}: ${d} && echo "Kunci terpasang untuk ${username}"; else echo "Pengguna ${username} tidak ada di server ini"; fi`;
}

export const installHelp = (username: string): string =>
  `Masuk ke server (sebagai ${username} atau root), lalu tempel perintah di bawah ini dan tekan Enter. Kunci otomatis dipasang untuk pengguna "${username}" dan tidak menghapus kunci lain. Setelah muncul "Kunci terpasang", kembali ke sini dan tekan Uji koneksi. Langkah lengkap ada di Panduan.`;
