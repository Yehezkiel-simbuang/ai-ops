# AI Ops

**Kelola, pantau, dan rawat server dengan bantuan AI, tanpa menyerahkan kendali.**

AI Ops adalah aplikasi web yang dijalankan sendiri (self-hosted) untuk orang yang mengurus beberapa server tanpa tim operasi khusus. Ia membantu menyiapkan server, memantaunya, memberi tahu bila ada yang genting, dan menyarankan apa yang perlu dirawat. Agen AI boleh mengusulkan dan mengerjakan, tetapi **setiap perintah yang mengubah sesuatu harus Anda setujui dulu**. Perintah yang hanya membaca berjalan otomatis, dan perintah yang merusak diblokir.

## Masalah yang dibantu

| Biasanya | Dengan AI Ops |
|---|---|
| Memasang server baru berarti membuka catatan lama dan mengetik puluhan perintah. | Pilih templat (PostgreSQL, Laravel, load balancer, dan lainnya). Agen menyusun langkah dan Anda menyetujuinya satu per satu. |
| Baru tahu ada masalah setelah pengguna mengeluh. | Agen kecil di tiap server melapor sendiri bila ada yang genting, lengkap dengan buktinya. |
| Notifikasi terlalu banyak, yang penting tenggelam. | Empat tingkat keparahan. Hanya Critical dan Major yang dikirim langsung; sisanya masuk ringkasan harian. |
| Lupa mana server yang belum dipatch atau perlu reboot. | Daftar server yang perlu dipelihara, diurutkan dari yang paling mendesak, lengkap dengan CVE yang sedang dieksploitasi. |
| Patch dipasang tanpa tahu dampaknya. | Rencana patch dengan perkiraan layanan yang terdampak, persetujuan per langkah, dan cara mundur. |
| Tidak yakin arsitektur kuat menahan beban. | Simulasi di lab, lalu pasang sungguhan di server uji dan ukur dengan k6. |
| Kredensial dan dokumentasi server tersebar. | Inventaris dan vault terenkripsi dalam satu tempat. |

## Cara kerjanya

```
        Anda (browser)
              |
        AI Ops (aplikasi + PostgreSQL)  <----  Penyedia model AI pilihan Anda
          |            ^
   SSH, hanya untuk    |  agen mengirim detak jantung dan kejadian
   yang Anda setujui   |  (koneksi KELUAR dari server; aman di belakang NAT)
          v            |
      Server Anda  [agen kecil, opsional]
```

- **Agen** (Go, satu berkas) berjalan di server dan memantau dari dalam. Aplikasi tidak menarik data dari server secara berkala, jadi beban pemantauan tidak menumpuk di server AI Ops.
- **SSH** dipakai hanya untuk hal yang memang harus menjalankan perintah atas permintaan Anda: setup, perbaikan, dan penerapan patch.
- **Persetujuan** selalu di tangan Anda: perintah dikelompokkan menjadi baca (otomatis), ubah (menunggu persetujuan), dan blokir (tidak pernah dijalankan).

## Yang bisa dilakukan

### Memantau dan menangani insiden
- **Agen di server** mengawasi beban, memori, disk, tekanan I/O, layanan (MySQL, PostgreSQL, Redis, Nginx, Docker, dan banyak lagi), port, log, dan perintah kustom. Layanan yang terdeteksi ditawarkan otomatis.
- **Pengawasan keamanan**: login SSH gagal berulang, akun atau kunci SSH baru, perubahan sudoers dan konfigurasi sshd, serta port baru yang terbuka.
- **Status hidup atau mati** tiap agen dari detak jantungnya. Agen yang diam membuka alert Critical.
- **Insiden dengan bukti**: tiap kejadian membawa data diagnostik saat masalah mulai. AI menyusun rekomendasi perbaikan, dan Anda menyetujuinya langkah demi langkah.
- **Empat tingkat keparahan** (Info, Minor, Major, Critical). Critical dan Major dikirim langsung ke Telegram, ntfy, webhook, atau email. Minor masuk ringkasan harian, Info hanya tercatat, dan ada jam tenang untuk Major.
- **Standar pemantauan global**: satu tempat menentukan batas Minor, Major, dan Critical untuk semua server, termasuk batas patch dan tingkat tiap jenis kejadian keamanan. AI bisa mengusulkan angkanya dari data nyata.
- **Layanan tanpa SSH**: cek HTTP dan status deploy dari luar, untuk situs atau API yang tidak perlu masuk ke server.

### Patch dan pemeliharaan
- **Saran patch**: agen melaporkan pembaruan paket, pembaruan keamanan, reboot yang tertunda, dan versi OS. Aplikasi menilainya menurut Standar, lalu menyusun daftar server yang paling perlu dipelihara.
- **CVE**: untuk Debian dan Ubuntu, paket yang akan naik dicocokkan ke [OSV.dev](https://osv.dev) untuk melihat kerentanan apa yang ditutup patch itu, dan ke daftar CISA KEV untuk menandai yang **sedang dieksploitasi** (otomatis Critical).
- **Masa dukungan OS**: server dengan OS yang sudah atau hampir habis dukungannya ditandai.
- **Rencana patch**: pilih paket, lalu lihat perkiraan dampaknya (layanan yang mungkin perlu restart, kemungkinan reboot). Langkah yang mengubah sistem butuh persetujuan Anda. Status rencana jelas: Draf, Berjalan, Selesai, Gagal, Ditolak, Digantikan. Restart layanan dan reboot sengaja dikerjakan terpisah.
- **Jadwal pemeliharaan**: tugas berulang atau sekali per server dengan templat standar (pembaruan OS, uji pulih cadangan, kesehatan disk, rotasi kredensial, sertifikat, dan lainnya), pengingat harian, dan riwayat.

### Menyiapkan server (Setup)
- Tulis tujuan, atau pilih salah satu dari **23 templat**, dan agen menyusun langkahnya. Setiap perubahan menunggu persetujuan Anda.
- **Fondasi server**: pengamanan dasar (firewall, fail2ban, SSH), Docker dan Compose, backup terenkripsi (restic), Netdata.
- **Aplikasi**: Node.js (Express + TypeScript), frontend React (Vite), layanan Go, Laravel, dan proyek docker-compose milik Anda.
- **Data dan antrean**: PostgreSQL, MySQL/MariaDB, Redis, RabbitMQ, Qdrant.
- **Jaringan dan TLS**: load balancer Nginx, load balancer HAProxy, Nginx dengan Let's Encrypt.
- **Diagnosis dan tuning**: diagnosis umum, tuning MySQL dan PostgreSQL, tinjau web server dan host Docker.
- Templat pemasangan tidak menebak: bagian `[ISI: ...]` (domain, repositori, port, alamat klien) wajib Anda isi. Rahasia dibangkitkan acak dan disimpan di berkas terbatas, tidak pernah tampil di perintah atau keluaran.

### Inventaris dan vault
- Dokumentasi tiap server: fungsi, pemilik, alamat, layanan dan port, ketergantungan antarserver, runbook, dan fakta otomatis (OS, kernel, CPU, RAM, disk).
- **Vault kredensial** terenkripsi, dengan riwayat versi, pengingat rotasi, dan tanggal kedaluwarsa.

### Menguji arsitektur
- **Lab arsitektur**: gambar arsitektur (Redis, load balancer, replika database, antrean, CDN), ubah beban, dan lihat dampaknya di simulator. Ini perkiraan, bukan pengukuran.
- **Playground**: pasang susunan Docker Compose sungguhan di server uji lewat halaman penyusun (pilih contoh, rakit dari image aplikasi Anda, atau tempel YAML), lalu copot bila selesai.
- **Uji beban** dengan k6 sungguhan: naikkan beban bertahap, temukan di mana mulai tidak sehat, dan bandingkan hasil antar uji. AI dapat menjelaskan hasilnya; penjelasan dikerjakan di server dan tersimpan.

## Yang tidak dilakukan (supaya tidak salah harap)
- Tidak menjalankan perintah yang mengubah sistem tanpa persetujuan Anda, dan tidak merestart layanan atau me-reboot server sendiri.
- Penerapan patch dan pencocokan CVE baru mendukung **Debian dan Ubuntu** (paket repositori resmi). Paket dari repositori pihak ketiga, image Docker, dan dependensi aplikasi (Composer, npm) belum dicek.
- Bukan pengganti sistem pemantauan penuh (Prometheus, SIEM). Ia fokus pada insiden, patch, dan penyiapan untuk skala kecil sampai menengah.
- Penjelasan, dampak, dan usulan dari AI adalah **tafsiran**, bukan jaminan. Simulator adalah model.
- Data yang keluar dari aplikasi: percakapan setup dan ringkasan ke penyedia model AI yang Anda pilih, nama paket dan versi ke OSV.dev, dan pengunduhan daftar CISA KEV.

## Mulai cepat

Butuh Docker dan Node.js 20 atau lebih baru (Node hanya untuk skrip pembuat rahasia).

```bash
node scripts/init-secrets.mjs      # sekali: membuat folder secrets/ (kunci enkripsi dan password database)
docker compose up -d --build       # PostgreSQL 17 + aplikasi
```

Buka **http://localhost:4317** dan masuk dengan pengguna `admin`, password `123456`. Anda langsung diminta menggantinya, dan aplikasi tidak bisa dipakai sebelum itu.

> **Cadangkan `secrets/master_key.txt`.** Tanpa berkas itu, kunci SSH dan API key yang tersimpan di database tidak bisa dibuka lagi.

## Cara memakai

1. **Tambah server.** Menu **Server**, lalu **Tambah server**. Autentikasi memakai **kunci SSH** (login dengan password tidak didukung). Pilih "Buat kunci otomatis", lalu pasang kunci publik yang ditampilkan di server Anda. Untuk patch lewat SSH, akun itu perlu sudo tanpa password, dan opsi "Pengguna ini punya sudo tanpa password" di form server dicentang.
2. **Hubungkan model AI.** Di **Pengaturan**, tambahkan penyedia (Anthropic, OpenAI-kompatibel, atau Gemini) dan pilih model untuk tiap peran. Model penalaran (misalnya gpt-5) boleh dipakai.
3. **Pasang agen** di server (menu Server, ikon Agen): salin skrip pemasangannya dan jalankan di server sebagai root. Dari sini pemantauan, insiden, dan saran patch berjalan sendiri.
4. **Atur batas** di **Standar**, dan saluran notifikasi di **Pengaturan**.
5. **Minta agen bekerja.** Buka **Setup**, pilih templat atau tulis tujuan, lalu setujui langkah demi langkah.
6. **Rawat.** Buka **Inventaris, tab Pemeliharaan** untuk melihat server yang perlu dipatch dan menyiapkan rencana patch.

Halaman **Ringkasan** menampilkan kondisi seluruh server, dan yang butuh tindakan Anda ada di bagian paling atas.

### Agar agen di server lain bisa menjangkau aplikasi
Secara bawaan aplikasi hanya mendengarkan di komputer sendiri, jadi server lain tidak bisa mengunduh agen atau melapor. Di berkas `.env`:

```
BIND_ADDR=192.168.1.10                  # IP komputer ini di jaringan server Anda (bukan 0.0.0.0 bila bisa dihindari)
PUBLIC_URL=http://192.168.1.10:4317     # alamat yang dipakai agen (pakai https:// untuk server sungguhan)
ALLOWED_HOSTS=localhost,127.0.0.1,192.168.1.10
```

Lalu `docker compose up -d`, izinkan port 4317 di firewall, dan buka aplikasi lewat alamat itu. Alamat `http://` hanya untuk jaringan lab yang tepercaya; untuk produksi pakai HTTPS (profil `lan` di bawah).

## Fitur tambahan

| Ingin | Jalankan |
|---|---|
| Uji beban dengan k6 | `docker compose --profile loadtest up -d --build` |
| Mencoba uji beban tanpa server uji | `docker compose --profile demo --profile loadtest up -d --build` |
| HTTPS di jaringan lokal | `docker compose --profile lan up -d --build` (lihat [referensi](docs/REFERENSI.md)) |
| Cadangan database | `sh scripts/backup.sh` |
| Lupa password admin | `docker compose exec app node dist/admin-cli.js reset-password` |

## Keamanan singkat

- Kunci SSH dan API key disimpan **terenkripsi** (AES-256-GCM); password pengguna di-hash. Rahasia agen dipakai untuk menandatangani permintaan (HMAC) dan tidak dikirim.
- Perintah dari agen diklasifikasi: baca otomatis, ubah menunggu persetujuan, merusak diblokir. Agen di server menolak perintah yang merusak sekalipun aplikasi terlanjur mengirimkannya.
- Aplikasi ini memegang akses ke server Anda. **Jangan membukanya ke internet** tanpa HTTPS dan jaringan yang Anda kendalikan, dan ganti password awal segera.
- Playground hanya boleh dipakai di server uji, bukan produksi.

## Teknologi

Node 24, Express 5, TypeScript, PostgreSQL 17, React 19 dan Vite, agen dan runner dalam Go, k6, Docker Compose.

## Pengembangan

```bash
cd server && npm ci && npm run typecheck && npm test   # tes memakai PostgreSQL sungguhan (lihat referensi)
cd web    && npm ci && npm run typecheck && npm test
cd agent  && go vet ./... && go test ./...
cd web    && npm run dev                                # http://localhost:5173
```

Struktur folder, konvensi kode, arsitektur, dan penjelasan tiap fitur ada di **[docs/REFERENSI.md](docs/REFERENSI.md)**.

## Lisensi

[MIT](LICENSE).
