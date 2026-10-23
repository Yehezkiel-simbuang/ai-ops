# AI Ops

**Kelola dan pantau server dengan bantuan AI, tanpa menyerahkan kendali.**

AI Ops adalah aplikasi web yang dijalankan sendiri (self-hosted). Agen AI menyiapkan dan memperbaiki server Anda, tetapi **setiap perintah yang mengubah sesuatu harus Anda setujui dulu**. Perintah yang hanya membaca berjalan otomatis; perintah yang merusak diblokir.

## Yang bisa dilakukan

- **Setup oleh agen.** Jelaskan tujuan ("pasang dan atur MySQL"), agen menyusun langkah, dan Anda menyetujui satu per satu.
- **Monitoring layanan dari dalam server.** Beban, memori, disk, MySQL, PostgreSQL, Redis, Nginx, Docker, dan banyak lagi. Layanan yang terdeteksi ditawarkan otomatis, dan Anda bisa menambah yang belum ada.
- **Standar pemantauan global.** Satu tempat menentukan kapan sebuah nilai dianggap peringatan atau kritis, berlaku untuk semua server. AI bisa mengusulkan angkanya dari data nyata server Anda.
- **Inventaris dan vault.** Dokumentasi tiap server, kredensial terenkripsi, dan jadwal pemeliharaan.
- **Notifikasi** lewat Telegram, ntfy, webhook, atau email saat ada yang kritis.
- **Lab arsitektur, uji beban, dan Playground.** Coba arsitektur di simulator, ukur dengan k6 sungguhan, dan pasang susunan Docker Compose di server uji.
- **Agen kecil opsional** (Go, satu berkas) untuk server di belakang NAT. Agen hanya membuat koneksi keluar.

## Mulai cepat

Butuh Docker dan Node.js 20 atau lebih baru (Node hanya untuk skrip pembuat rahasia).

```bash
node scripts/init-secrets.mjs      # sekali: membuat folder secrets/ (kunci enkripsi dan password database)
docker compose up -d --build       # PostgreSQL 17 + aplikasi
```

Buka **http://localhost:4317** dan masuk dengan pengguna `admin`, password `123456`. Anda langsung diminta menggantinya, dan aplikasi tidak bisa dipakai sebelum itu.

> **Cadangkan `secrets/master_key.txt`.** Tanpa berkas itu, kunci SSH dan API key yang tersimpan di database tidak bisa dibuka lagi.

## Cara memakai

1. **Tambah server.** Buka menu **Server**, lalu **Tambah server**. Autentikasi memakai **kunci SSH** (login dengan password tidak didukung). Pilih "Buat kunci otomatis", lalu pasang kunci publik yang ditampilkan di server Anda. Halaman **Panduan** menjelaskan langkahnya dengan gambar.
2. **Hubungkan model AI.** Di **Pengaturan**, tambahkan penyedia (Anthropic, OpenAI-kompatibel, atau Gemini) dan pilih model untuk peran Setup dan Monitoring.
3. **Pantau.** Buka **Monitor**, pilih server, lalu **Layanan di server** atau **Deteksi paket** untuk memilih apa yang dipantau. Batas peringatan diatur di **Standar**.
4. **Minta agen bekerja.** Buka **Setup**, tulis tujuannya, lalu setujui langkah demi langkah di halaman proses.

Halaman **Ringkasan** menampilkan kondisi seluruh server, dan yang butuh tindakan Anda ada di bagian paling atas.

## Fitur tambahan

| Ingin | Jalankan |
|---|---|
| Uji beban dengan k6 | `docker compose --profile loadtest up -d --build` |
| Mencoba uji beban tanpa server uji | `docker compose --profile demo --profile loadtest up -d --build` |
| HTTPS di jaringan lokal | `docker compose --profile lan up -d --build` (lihat [referensi](docs/REFERENSI.md)) |
| Cadangan database | `sh scripts/backup.sh` |
| Lupa password admin | `docker compose exec app node dist/admin-cli.js reset-password` |

## Keamanan singkat

- Kunci SSH dan API key disimpan **terenkripsi** (AES-256-GCM); password pengguna di-hash.
- Perintah dari agen diklasifikasi: baca otomatis, ubah menunggu persetujuan, merusak diblokir.
- Aplikasi ini memegang akses ke server Anda. **Jangan membukanya ke internet** tanpa HTTPS dan jaringan yang Anda kendalikan, dan ganti password awal segera.
- Playground hanya boleh dipakai di server uji, bukan produksi.

## Teknologi

Node 24, Express 5, TypeScript, PostgreSQL 17, React 19 dan Vite, agen dan runner dalam Go, k6, Docker Compose.

## Pengembangan

```bash
cd server && npm ci && npm run typecheck && npm test   # tes memakai PostgreSQL sungguhan (lihat referensi)
cd web    && npm ci && npm run typecheck && npm test
cd web    && npm run dev                                # http://localhost:5173
```

Struktur folder, konvensi kode, arsitektur, dan penjelasan tiap fitur ada di **[docs/REFERENSI.md](docs/REFERENSI.md)**.

## Lisensi

[MIT](LICENSE).
