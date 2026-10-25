// Templat tujuan untuk proses setup. Agen tetap memakai kebijakan baca/ubah/blokir yang sama.
import { SETUP_TEMPLATES } from './templates-setup.js';

/** category mengelompokkan templat di halaman Setup; ask = hal yang harus diisi pengguna di bagian [ISI: ...] pada tujuan; maxTurns dan tokenBudget = usulan anggaran. */
export interface Template { id: string; name: string; category: string; goal: string; steps: string[]; ask?: string[]; maxTurns?: number; tokenBudget?: number }

/** Templat diagnosis dan tuning (baca saja atau perubahan kecil berbasis bukti). */
const DIAGNOSIS: Array<Omit<Template, 'category'>> = [
  { id: 'diagnosis', name: 'Diagnosis awal (baca saja)', goal: 'Kumpulkan gambaran kondisi server: OS dan versi, CPU/RAM/swap/disk, layanan utama yang berjalan, log galat terbaru, dan dugaan penyebab lambat. Jangan mengubah apa pun.',
    steps: ['Identifikasi OS, CPU, RAM, disk, dan uptime', 'Daftar layanan berjalan dan port yang didengarkan', 'Periksa beban, tekanan I/O (PSI), dan swap', 'Baca log galat terbaru layanan utama', 'Ringkas temuan dan usulkan langkah berikutnya'] },
  { id: 'netdata', name: 'Pasang Netdata (monitoring mendalam, hanya lokal)', goal: 'Pasang Netdata dari repositori paket resmi OS (bukan skrip curl|sh), dengarkan hanya 127.0.0.1:19999 supaya tidak terbuka ke jaringan. Pastikan collector MySQL/Redis/Nginx/PHP-FPM yang terdeteksi aktif bila memungkinkan, lalu verifikasi endpoint /api/v1/alarms menjawab. Cadangkan setiap berkas konfigurasi sebelum diubah.',
    steps: ['Cek OS, paket netdata tersedia, dan ruang disk', 'Pasang paket netdata lewat package manager', 'Ikat Netdata ke 127.0.0.1 dan nonaktifkan telemetri/cloud', 'Aktifkan collector layanan yang terdeteksi', 'Verifikasi /api/v1/alarms dan beri tahu pengguna untuk mengaktifkan paket "Netdata" di Monitor'] },
  { id: 'mysql', name: 'Tuning MySQL berbasis bukti', goal: 'Ukur dulu: variabel InnoDB, penggunaan buffer pool, latensi fsync/disk, thread yang menunggu commit, dan kunci baris. Usulkan perubahan konfigurasi satu per satu dengan alasan berbasis angka, cadangkan my.cnf, validasi, dan verifikasi sesudahnya. Jangan restart tanpa persetujuan eksplisit.',
    steps: ['Baca versi dan variabel InnoDB penting', 'Ukur buffer pool hit ratio dan thread yang menunggu commit', 'Ukur latensi disk/fsync', 'Usulkan dan terapkan satu perubahan konfigurasi dengan cadangan', 'Verifikasi dengan pengukuran ulang'] },
  { id: 'postgres', name: 'Tuning PostgreSQL berbasis bukti', goal: 'Ukur dulu: versi, shared_buffers dan work_mem terhadap RAM, cache hit ratio, query lambat (pg_stat_statements bila ada), koneksi aktif dan menganggur, bloat/autovacuum, dan latensi fsync WAL. Usulkan perubahan satu per satu dengan cadangan konfigurasi. Jangan restart tanpa persetujuan.',
    steps: ['Baca versi, ukuran database, dan pengaturan memori penting', 'Ukur cache hit ratio, koneksi, dan query terlama', 'Periksa autovacuum dan bloat tabel besar', 'Ukur latensi fsync WAL dan penulisan checkpoint', 'Usulkan dan terapkan satu perubahan dengan cadangan konfigurasi', 'Verifikasi dampak dan siapkan cara membatalkan'] },
  { id: 'webserver', name: 'Tinjau web server dan proxy (Nginx/Apache)', goal: 'Baca konfigurasi dan kondisi web server: jumlah worker dan koneksi, batas waktu (timeout) ke aplikasi, kompresi dan cache statis, ukuran buffer, dan galat 5xx di log. Cari penyebab 502/504 dan lonjakan koneksi. Hanya baca; usulkan perubahan, jangan terapkan tanpa persetujuan.',
    steps: ['Baca versi dan konfigurasi aktif (nginx -T atau apachectl -S)', 'Periksa worker, koneksi, dan batas file terbuka', 'Periksa timeout dan buffer ke aplikasi hulu', 'Hitung galat 4xx/5xx terbaru di log', 'Ringkas temuan dan usulan perubahan beserta risikonya'] },
  { id: 'docker', name: 'Tinjau host Docker (baca saja)', goal: 'Daftar kontainer, citra, volume, dan pemakaian sumber daya. Cari kontainer yang restart terus, log yang membengkak, citra dan volume yatim yang memakan disk, serta kontainer tanpa batas memori. Hanya baca.',
    steps: ['Daftar kontainer berjalan dan status restart', 'Ukur pemakaian CPU/memori per kontainer', 'Periksa ukuran log kontainer dan volume', 'Cari citra dan volume yang tak terpakai', 'Ringkas temuan dan usulan pembersihan yang aman'] }
];

const FOUNDATION = new Set(['netdata']);   // Netdata memasang sesuatu, jadi masuk Fondasi server
/** Urutan kelompok di halaman Setup. */
export const CATEGORIES = ['Diagnosis dan tuning', 'Fondasi server', 'Aplikasi', 'Data dan antrean', 'Jaringan dan TLS'] as const;
export const PLACEHOLDER = /\[ISI:[^\]]*\]/;   // bagian tujuan yang belum diisi pengguna

export const TEMPLATES: Template[] = [...DIAGNOSIS.map((t) => ({ ...t, category: FOUNDATION.has(t.id) ? 'Fondasi server' : 'Diagnosis dan tuning' })), ...SETUP_TEMPLATES]
  .sort((a, b) => CATEGORIES.indexOf(a.category as never) - CATEGORIES.indexOf(b.category as never));
