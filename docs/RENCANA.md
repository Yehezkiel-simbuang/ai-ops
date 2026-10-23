# Rencana: AI Ops Agent untuk Setup dan Monitoring Server Produksi

Tanggal: 2026-10-19 · Status: rencana awal (belum ada kode)

## 1. Keputusan yang sudah diambil
| Hal | Keputusan |
|---|---|
| Mode | **Dua mode:** Monitoring (selalu aktif, baca-saja) dan Setup (dibuka eksplisit, bisa mengubah server) |
| Cakupan versi pertama | Diagnosis + deploy + tuning server/DB |
| Cara membangun | **Agen kustom**, bukan produk jadi |
| Penyedia LLM | **Multi-provider**: tidak terkunci pada satu penyedia |

## 2. Tujuan dan non-tujuan
**Tujuan**
- Mendiagnosis masalah server seperti yang kita lakukan pada insiden 18 Oktober (login 504, stall disk), tapi lebih cepat dan dengan bukti yang tercatat.
- Menjalankan deploy dan tuning dengan alur yang aman: rencana, persetujuan, penerapan, verifikasi, rollback.
- Menjaga catatan audit lengkap: siapa meminta apa, apa yang dijalankan, hasilnya.

**Bukan tujuan (setidaknya sampai fase akhir)**
- Agen yang bertindak sendiri tanpa persetujuan di produksi.
- Menggantikan sistem pemantauan (Prometheus/Grafana). Agen **membaca** dari sana dan menjelaskan.

## 3. Dua mode
| | **Monitoring** | **Setup** |
|---|---|---|
| Kapan aktif | Selalu (terjadwal dan atas permintaan) | Dibuka manual per sesi, **otomatis kedaluwarsa** (misalnya 60 menit) |
| Kemampuan | Hanya membaca | Membaca + mengubah, lewat alur persetujuan |
| Kredensial | Pengguna SSH dan pengguna DB **baca-saja** | Kredensial terpisah dengan hak tulis terbatas, diterbitkan jangka pendek |
| Output | Laporan, peringatan, dugaan penyebab | Rencana perubahan, diff, hasil verifikasi, catatan rollback |
| Persetujuan manusia | Tidak perlu | **Wajib** untuk setiap langkah yang mengubah sesuatu |

Pemisahan ini dipaksa di **lapisan kredensial**, bukan hanya di prompt. Mode Monitoring secara teknis tidak punya kunci untuk menulis, jadi model yang salah paham pun tidak bisa merusak apa pun.

## 4. Arsitektur
```
 Saluran (CLI / Web / Telegram / WhatsApp)
              │
      ┌───────▼─────────┐
      │  Orkestrator    │  loop agen, kontrol mode, batas langkah dan biaya, tombol darurat
      └──┬───────────┬──┘
         │           │
 ┌───────▼──┐   ┌────▼────────────┐
 │ Abstraksi│   │  Policy Engine  │  klasifikasi risiko, daftar larangan, persetujuan, jendela waktu
 │ Provider │   └────┬────────────┘
 │ (adapter)│        │
 └──────────┘   ┌────▼──────────────────────────────┐
                │  Lapisan Tool (bertipe, bukan shell bebas) │
                │  baca: katalog perintah, SQL baca-saja, baca log, probe HTTP, metrik │
                │  ubah (Setup): edit config + validasi, reload, deploy, rollback       │
                └────┬──────────────────────────────┘
                     │
        Server (app, DB, RADIUS, host Proxmox)  ←  hanya lewat kredensial sesuai mode
 
 Di samping semuanya: Audit log (tak bisa diubah), Vault rahasia, Basis pengetahuan (runbook, inventaris)
```

### 4.1 Abstraksi provider (multi-provider)
Antarmuka tunggal yang dipakai orkestrator, tidak peduli penyedianya:
```
chat(pesan, daftar_tool, opsi) -> aliran peristiwa { teks, panggilan_tool, selesai, penggunaan_token }
```
- **Adapter per penyedia** (Anthropic, OpenAI, Gemini, model lokal, dst.). Setiap adapter menerjemahkan format tool-call, streaming, dan penghentian penalaran milik penyedia ke format internal.
- **Flag kemampuan** per model: dukung tool, dukung output terstruktur, panjang konteks, harga. Orkestrator menyesuaikan perilaku, bukan mengasumsikan.
- **Kebijakan routing**: model murah untuk meringkas log, model kuat untuk menyusun rencana perubahan, dan **fallback** ke penyedia lain bila error, batas laju, atau penolakan.
- **Fitur khusus satu penyedia** (misalnya cache prompt, blok penalaran) dibungkus di dalam adapter dan tidak bocor ke orkestrator. Konsekuensinya: kita memakai kemampuan **denominator terkecil** di lapisan atas.
- **Evaluasi per penyedia**: kumpulan skenario insiden nyata (lihat Fase 2) dijalankan ke semua penyedia untuk membandingkan akurasi, biaya, dan latensi.
- **Privasi**: log bisa memuat data pelanggan. Sebelum dikirim ke penyedia mana pun, lewati **redaksi** (nomor telepon, email, token, IP pelanggan). Tentukan penyedia mana yang boleh menerima kelas data mana.

Catatan implementasi: adapter Claude memakai SDK resmi Anthropic. Adapter penyedia lain ditulis dari dokumentasi masing-masing. Pustaka abstraksi siap pakai (misalnya LiteLLM atau sejenisnya) bisa dievaluasi, tapi akan kita nilai dulu apakah cukup mendukung tool-call dan streaming yang kita butuhkan.

### 4.2 Lapisan tool: bertipe, bukan shell bebas
Agen **tidak** diberi terminal bebas. Ia memanggil tool dengan parameter yang divalidasi.

**Mode Monitoring (baca-saja)**
| Tool | Isi |
|---|---|
| `run_catalog_command` | Menjalankan perintah **bernama** dari katalog (misalnya `zpool_iostat_yl`, `mysql_processlist`, `php_fpm_slowlog_tail`), parameter divalidasi, timeout, keluaran dipotong |
| `mysql_readonly` | SQL melalui pengguna DB baca-saja, ditolak oleh parser bila bukan `SELECT`/`SHOW`/`EXPLAIN`, dengan batas waktu dan batas baris |
| `read_log` | Hanya direktori log yang diizinkan, dengan filter waktu |
| `http_probe` | `GET` ke URL internal terdaftar, mengukur waktu |
| `metrics_query` | Baca dari Prometheus/Loki bila tersedia |

**Mode Setup (tambahan)**
| Tool | Isi |
|---|---|
| `propose_change` | Menyusun **rencana**: langkah, diff, risiko, rencana rollback, pemeriksaan verifikasi |
| `apply_change` | Menjalankan rencana yang **sudah disetujui**, langkah demi langkah, berhenti saat verifikasi gagal |
| `edit_config` | Edit file dengan cadangan otomatis dan validasi (`nginx -t`, `php-fpm8.2 -t`, `mysqld --validate-config`) sebelum diterapkan |
| `deploy_release` | Alur deploy Laravel (lihat 6.2) |
| `rollback` | Mengembalikan ke keadaan yang dicatat sebelum perubahan |

### 4.3 Policy Engine
- **Klasifikasi risiko** tiap tool call: baca, rendah, sedang, tinggi, merusak.
- **Daftar larangan keras**, tidak bisa dibuka oleh model maupun mode Setup: `DROP`/`TRUNCATE` tanpa rencana yang disetujui khusus, `rm -rf` di luar jalur kerja, `zpool destroy`, `migrate:fresh`, `php artisan test` pada lingkungan yang `.env`-nya menunjuk produksi, perintah yang mematikan layanan inti tanpa jendela waktu.
- **Jendela waktu**: tidak ada perubahan saat jam cron kritis (misalnya jam batch malam) atau saat peringatan insiden aktif, kecuali dengan penimpaan eksplisit yang dicatat.
- **Persetujuan**: tombol setuju/tolak di saluran (Telegram/Web), menampilkan **rencana lengkap dan risikonya**, bukan hanya perintahnya.
- **Batas**: jumlah langkah per sesi, anggaran biaya, laju perintah, ukuran keluaran.
- **Tombol darurat**: satu perintah yang mencabut kredensial sesi dan menghentikan semua tool.

### 4.4 Rahasia dan audit
- Agen **tidak pernah melihat** kata sandi atau kunci. Tool memakainya di sisi server, dan keluaran disaring dari rahasia.
- Akses SSH memakai sertifikat jangka pendek yang diterbitkan per sesi.
- **Audit log append-only**: setiap prompt, panggilan tool, keluaran, persetujuan, dan diff, disimpan di tempat yang tidak bisa diubah agen. Dapat diputar ulang untuk analisis insiden.

### 4.5 Basis pengetahuan
- Runbook (misalnya [SERVER_TUNING_RUNBOOK.md](SERVER_TUNING_RUNBOOK.md)), inventaris server (peran, versi, jalur), dan **pelajaran** yang kita temukan (lihat bagian 5).
- Setiap kesimpulan agen wajib **menyebut sumber buktinya** (ID keluaran tool) dan **tingkat keyakinan** ("terbukti" atau "dugaan").

## 5. Pelajaran dari insiden hari ini yang menjadi syarat desain
| Kejadian | Syarat desain |
|---|---|
| `.env` lokal menunjuk database produksi, dan `phpunit` + `RefreshDatabase` bisa menjalankan `migrate:fresh` | Agen **sadar lingkungan**. Ia menolak perintah uji/migrasi/destruktif pada target yang terdeteksi sebagai produksi |
| Angka `/proc/pressure/io` dan `vmstat` di container LXC ternyata milik seluruh host | Setiap tool membawa **anotasi konteks** ("angka ini host-wide") agar model tidak salah menyimpulkan |
| Beberapa kesimpulan awal terlalu pasti, lalu direvisi setelah ada data (geoip, dugaan "tersendat") | Wajib **penandaan bukti dan keyakinan**; klaim kuat tanpa bukti ditolak oleh lapisan laporan |
| Menghapus modul WA membuat menu yang tersimpan di database berisiko merusak sidebar | Alur deploy punya **pemeriksaan pra-deploy**: `route:list` dibandingkan, kompilasi view, cek menu yatim |
| Perubahan konfigurasi (buffer pool, `flush_log`) hilang saat restart bila hanya `SET GLOBAL` | Alur tuning **wajib menyimpan permanen** dan memverifikasi nilai setelah restart terjadwal |
| Pengukuran saat tenang menyesatkan; data baru berguna saat stall | Mode Monitoring menyimpan **riwayat berkala** dan memicu pengambilan data otomatis saat ambang terlewati |

## 6. Alur kerja

### 6.1 Mode Setup (mesin status)
```
Niat  →  Penemuan (baca-saja)  →  Rencana (diff, risiko, rollback)  →  Persetujuan
       →  Pra-pemeriksaan  →  Penerapan (satu server dulu)  →  Verifikasi (SLO)
       →  Selesai atau Rollback otomatis  →  Laporan
```
Verifikasi memakai ambang yang jelas (misalnya kode 200, latensi login, tidak ada `waiting for handler commit`, tekanan I/O). Bila gagal: **rollback otomatis** dan laporan.

### 6.2 Deploy Laravel (playbook pertama mode Setup)
1. Catat commit saat ini (untuk rollback) dan pastikan git bersih.
2. `git pull`, `composer dump-autoload -o`.
3. `php artisan migrate --pretend`, lalu tampilkan ke manusia sebelum `migrate --force`.
4. Pemeriksaan pra-deploy (perubahan route, view, menu yatim).
5. `optimize:clear`, `queue:restart`, `reload php-fpm`.
6. Verifikasi: `curl` login, `/api/profile` dengan header JSON, log error baru, jumlah timeout.
7. Rollback otomatis bila verifikasi gagal.

### 6.3 Playbook diagnosis (mode Monitoring), hasil dari insiden ini
- **Login lambat/504**: ukur `GET` vs `POST /login`, slowlog FPM, `processlist`, transaksi tersangkut, latensi `fsync`, `zpool iostat -yl`.
- **Stall disk**: ambang `syncq_wait`, `disk_wait`, tekanan I/O host, siapa penulis terbesar per dataset.
- **Kesehatan MySQL**: umur transaksi, `Innodb_os_log_pending_fsyncs`, rantai lock, `Max_used_connections`.
- **PHP-FPM**: `max children reached`, antrean, slowlog per jam.
- **Antrean dan job**: pertumbuhan `failed_jobs`, penyebab terbanyak.
- **RADIUS**: log "duplicate packet", tekanan I/O container, ukuran `radacct`.

## 7. Fase dan kriteria selesai
| Fase | Isi | Selesai bila |
|---|---|---|
| **0. Fondasi** | Bastion host, pengguna SSH/DB baca-saja, katalog perintah, audit log, tombol darurat, inventaris, **lingkungan staging** | Agen bisa menjalankan satu perintah baca lewat jalur aman dan tercatat, dan kredensial bisa dicabut seketika |
| **1. Monitoring MVP** | Tool baca, playbook diagnosis 6.3, penyusun laporan (seperti laporan insiden hari ini) | **Memutar ulang insiden 18 Okt** (data dan keluaran yang sama) dan menghasilkan kesimpulan yang sama dengan bukti yang tercatat |
| **2. Abstraksi provider + evaluasi** | Adapter 2-3 penyedia, routing, fallback, kumpulan skenario insiden | Perbandingan akurasi/biaya/latensi tersedia, dan penggantian penyedia tidak mengubah perilaku orkestrator |
| **3. Mode Setup: deploy** | `propose_change`, persetujuan, `deploy_release`, rollback | Deploy penuh di **staging** sukses dan rollback teruji. Baru setelah itu produksi, dengan persetujuan manusia |
| **4. Mode Setup: tuning** | `edit_config` dengan validasi, tuning MySQL/FPM/Nginx/logrotate, verifikasi permanen setelah restart | Satu tuning (misalnya pemisahan pool FPM) berjalan dari rencana sampai verifikasi di staging |
| **5. Pengerasan** | Uji injeksi prompt, uji kekacauan, tinjauan akses, simulasi tombol darurat | Tidak ada jalur yang membuat agen melampaui kredensial modenya |

## 8. Risiko dan mitigasi
| Risiko | Mitigasi |
|---|---|
| **Injeksi prompt lewat isi log atau data** (log bisa memuat teks yang menyerupai perintah) | Keluaran tool diperlakukan sebagai **data**, bukan instruksi; tool tidak bisa memperluas haknya; persetujuan manusia untuk setiap perubahan |
| Kesimpulan keliru (model "yakin" padahal salah) | Wajib bukti dan keyakinan, laporan menandai "dugaan", dan evaluasi dengan skenario nyata |
| Kebocoran data ke penyedia LLM | Redaksi sebelum kirim, pemilihan penyedia per kelas data, kebijakan retensi |
| Perintah berbahaya | Tool bertipe, daftar larangan keras, kredensial per mode, tidak ada shell bebas |
| Kehilangan kontrol (agen berulang atau biaya membengkak) | Batas langkah, anggaran, tombol darurat |
| Ketergantungan berlebihan | Mode Setup selalu menampilkan rencana lengkap dan alasan; runbook tetap dipelihara manusia |
| Penyedia tidak tersedia | Fallback ke penyedia lain dan mode degradasi (hanya baca data mentah) |

## 9. Saran teknologi awal
- **Bahasa agen:** TypeScript atau Python (keduanya punya SDK penyedia utama). Pilih yang paling Anda kuasai untuk dipelihara.
- **Layanan:** satu proses orkestrator di bastion, antrean sederhana, **SQLite/Postgres** untuk audit dan rencana.
- **Saluran awal:** CLI, lalu bot **Telegram** untuk persetujuan dari ponsel.
- **Pemantauan sumber:** `node_exporter`, `mysqld_exporter`, exporter PHP-FPM, status ZFS, pengumpul log.
- **Integrasi tool:** pertimbangkan **MCP** (Model Context Protocol) bila ingin tool bisa dipakai klien lain.

## 10. Pertanyaan terbuka (butuh jawaban Anda)
1. **Staging**: apakah sudah ada salinan lingkungan untuk uji (server aplikasi + DB + RADIUS), atau perlu dibuat dulu? Saya sangat menyarankan tidak menguji mode Setup langsung di produksi.
2. **Daftar server** dan peran masing-masing (app, DB, RADIUS, host Proxmox, bastion) beserta akses jaringannya.
3. **Saluran**: Telegram, WhatsApp, atau web?
4. **Penyedia LLM** yang ingin didukung dan kebijakan data (apakah log boleh dikirim ke pihak ketiga setelah redaksi).
5. **Pemantauan yang sudah ada** (Prometheus/Grafana/Zabbix?) dan siapa yang menyetujui perubahan.
6. **Anggaran** biaya LLM per bulan dan batas waktu proyek.
