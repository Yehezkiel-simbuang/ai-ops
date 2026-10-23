// Label isian parameter pemeriksaan (dipakai formulir tambah pemeriksaan dan halaman Ambang batas).
export const FIELD_LABELS: Record<string, string> = {
  unit: 'Nama unit systemd', host: 'Nama host (domain)', port: 'Port', url: 'URL', prefix: 'Awalan perintah (kosong, "sudo -n ", atau "sudo -n -u postgres ")', sec: 'Batas detik', db: 'Nama database',
  sql: 'SQL baca-saja (angka pertama dipakai)', pattern: 'Teks yang dicari', path: 'Path', name: 'Nama kontainer', command: 'Perintah baca-saja'
};
