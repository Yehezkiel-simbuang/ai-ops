# AI Ops: referensi lengkap

> Dokumentasi rinci (arsitektur, keamanan, agen, lab, uji beban, HTTPS, konvensi kode). Ringkasan dan cara mulai cepat ada di [README](../README.md).

Aplikasi web untuk mengelola server Anda dengan bantuan agen: **setup oleh agen** (dengan persetujuan Anda untuk setiap perubahan), **monitoring layanan di dalam server**, **notifikasi** saat kritis, dan **pemakaian token** dari banyak penyedia model.
Plus **lab arsitektur** (halaman Arsitektur): tempat bereksperimen dengan arsitektur proyek Anda seperti bermain. Tambahkan Redis, load balancer, replika database, antrean, atau CDN, ubah beban dan lonjakan trafik, lalu lihat dampaknya pada diagram yang bergerak.

## Jalankan (Docker)

```
node scripts/init-secrets.mjs      # sekali: buat ./secrets (password DB, kunci enkripsi, password admin) dan cetak login pertama
docker compose up -d --build       # PostgreSQL 17 + aplikasi
```

Buka http://localhost:4317 dan masuk sebagai `admin` dengan password yang dicetak. **Cadangkan `secrets/master_key.txt`**: tanpa itu API key dan kunci SSH di database tidak bisa dibuka.

Pengoperasian:

| Tugas | Perintah |
|---|---|
| Log | `docker compose logs -f app` |
| Status / health | `docker compose ps` , `curl localhost:4317/readyz` |
| Cadangan DB | `sh scripts/backup.sh` |
| Pulihkan | `gunzip -c backups/aiops-XXXX.sql.gz \| docker compose exec -T db psql -U aiops -d aiops` |
| Perbarui | `git pull && docker compose up -d --build` (migrasi skema berjalan otomatis saat start) |
| Hentikan | `docker compose down` (data tetap di volume; `-v` menghapusnya) |
| HTTPS di LAN | lihat bagian "HTTPS di jaringan lokal": `docker compose --profile lan up -d --build` |

Konfigurasi lengkap: `.env.example` dan `server/src/config.ts`.

`PROJECTS_DIR` adalah folder di komputer Anda yang dipasang **hanya-baca** ke kontainer sebagai `/projects` (bersama `PROJECTS_ROOT=/projects`). Isinya dianalisis halaman Arsitektur dan rencana setup (mis. `PROJECTS_DIR=D:/work`: tiap subfolder yang punya manifest muncul sebagai proyek). Bawaannya kosong, jadi aplikasi tidak membaca folder Anda sama sekali. Perhatikan: folder itu terbaca penuh oleh aplikasi, termasuk `.env` di dalamnya; sebaiknya arahkan ke satu folder khusus.

## Arsitektur

```
Browser --HTTPS--> [Caddy opsional] --> app (Node 24, Express 5, TypeScript; menyajikan UI React) --pg.Pool--> PostgreSQL 17
                                           |--> OpenSSH --> server Anda (perintah baca otomatis, ubah = persetujuan)
                                           |--> API model (Anthropic / OpenAI-kompatibel / Gemini)
                                           '--> Telegram, ntfy, webhook, SMTP
```

- **Basis data**: PostgreSQL, migrasi SQL bernomor (`server/migrations`) dengan kunci advisory (aman bila beberapa instance start bersamaan), indeks unik parsial agar satu peringatan terbuka per (server, kunci), `CHECK` pada kolom status.
- **Pooling**: satu `pg.Pool` per proses. `DB_POOL_MAX` (bawaan 10), koneksi menganggur dilepas 30 d, batas waktu koneksi 5 d (gagal cepat bila pool habis), `statement_timeout` 15 d, error pada koneksi idle dicatat dan tidak menjatuhkan proses. Satu instance aplikasi tidak butuh PgBouncer; bila nanti banyak replika, pasang PgBouncer (transaction mode) di depan database.
- **Penjadwal monitoring**: berjalan di satu instance saja lewat kunci advisory PostgreSQL (kunci dilepas otomatis bila instance mati, instance lain mengambil alih).
- **Agen setup**: tidak berjalan lebih dari satu kali per run; persetujuan diklaim atomik (`UPDATE ... WHERE status='pending_approval' RETURNING`), jadi perintah tidak mungkin dijalankan dua kali walau tombol ditekan bersamaan. Jalankan **satu replika aplikasi** (loop agen ada di memori proses).
- **Kebijakan perintah** (`server/src/safety.ts`): baca = otomatis, ubah/tidak dikenal = persetujuan, merusak = diblokir. Diuji dengan 71 kasus.
- **Keamanan**: login scrypt, sesi di DB (hanya hash token), cookie `HttpOnly` + `SameSite=Strict` (+`Secure` di produksi), validasi `Host`, header `X-AIOps` + cek `Origin` untuk perubahan (anti CSRF), batas laju (login 8/menit), CSP ketat, API key dan kunci SSH terenkripsi AES-256-GCM dengan `MASTER_KEY` dari secret, kontainer non-root + root filesystem hanya-baca + semua capability dibuang, database di jaringan internal tanpa internet dan tanpa port terbuka.
- **Observabilitas**: log JSON terstruktur (header `cookie`/`authorization` disamarkan), `/healthz` (liveness), `/readyz` (cek DB), `/metrics` Prometheus bila `METRICS_TOKEN` disetel.
- **Shutdown rapi**: SIGTERM menghentikan penjadwal, menyelesaikan request, menutup pool (diuji: berhenti <1 d, exit 0).

## Inventaris: dokumentasi server, vault kredensial, pemeliharaan

Menu **Inventaris** menjawab "server ini apa, IP-nya berapa, usernamenya apa, kapan terakhir dirawat":
- **Profil per server**: fungsi, lingkungan (prod/staging/dev/lab), pemilik, lokasi (rak/VMID), tag, banyak alamat (IP/hostname/URL/MAC, satu utama), layanan + port, **ketergantungan antarserver** (dampak gangguan terlihat), runbook bebas, dan **fakta otomatis** dari server lewat SSH (OS, kernel, CPU/RAM/disk, IP, port, layanan, pembaruan tertunda, perlu reboot). Pencarian satu kotak: nama, IP, username kredensial, port, tag, pemilik, lokasi, fungsi. Ekspor **Markdown per server** dan **CSV** (tanpa rahasia).
- **Vault kredensial**: password/API key/kunci per server atau umum, terenkripsi AES-256-GCM; **pembangkit password** (panjang, simbol, hindari karakter mirip) dan username acak; **Ungkap** wajib konfirmasi password akun, dibatasi laju, dan tercatat di audit (tanpa isi); **riwayat versi** (10 terakhir); **rotasi** satu klik; pengingat periode ganti password dan tanggal kedaluwarsa. Password tidak pernah ada di daftar, ekspor, atau log. Aplikasi **tidak mengubah password di server**: Anda menerapkannya sendiri (perintah `passwd`/`chpasswd` memang diblokir untuk agen).
- **Pemeliharaan**: tugas berulang/sekali per server dengan 10 templat standar (pembaruan OS, uji pulih cadangan, kesehatan disk/ZFS, tinjau akun, rotasi password, sertifikat, firewall, ...). Selesai -> riwayat dan jatuh tempo berikutnya = sekarang + periode (tidak menumpuk). **Ringkasan harian** ke kanal notifikasi Anda (bawaan jam 08:00 zona waktu server, atur `TZ`): tugas terlambat/segera, password yang waktunya diganti, kredensial yang akan kedaluwarsa.

## Berlaku umum (tidak khusus Proxmox atau satu proyek)

Aplikasi ini tidak mengandaikan satu jenis infrastruktur. Server boleh VM di Proxmox, VPS, bare metal, cloud, atau kontainer; yang dipakai hanya SSH dan/atau agen kecil.

- **Monitoring**: paket pemeriksaan ditawarkan menurut yang **terdeteksi** di server (systemd, port, HTTP, MySQL/MariaDB, PostgreSQL, Redis, Nginx, PHP-FPM, Docker, host umum, Netdata, ...). Paket khusus aplikasi seperti Laravel hanya muncul di atas bila terdeteksi; sisanya dilipat dan tidak menjadi bawaan.
- **Agen**: hanya memantau sumber daya umum (CPU, memori, disk, tekanan I/O) dan layanan yang Anda sebut.
- **Analisis proyek** (halaman Arsitektur): membaca Laravel/PHP, Node, Python (Django, Flask, FastAPI), Java (Spring), Go, Ruby (Rails/Puma), dan .NET. Aturan rekomendasi bersifat struktural (pool worker, koneksi database, disk, layanan luar, antrean) dan hanya menyebut teknologi tertentu bila ada bukti di proyeknya (mis. saran `innodb_flush_log_at_trx_commit` hanya untuk keluarga MySQL/MariaDB; saran perangkat log cepat hanya bila lambatnya fsync **terukur**).
- **Templat setup**: diagnosis umum, Netdata, tuning MySQL, tuning PostgreSQL, tinjau web server, tinjau host Docker.
- Cakupan temuan dari kode untuk stack non-PHP masih terbatas pada pola yang dikenali analyzer (mis. panggilan sinkron di event loop Node, `database/sql` tanpa batas koneksi di Go, `http.Get` tanpa timeout, pool Puma lebih kecil dari thread, Django `CONN_MAX_AGE`, Spring open-in-view). Selebihnya bottleneck ditemukan lewat simulasi struktural.

## Lab arsitektur (halaman Arsitektur)

Untuk menentukan arsitektur yang pas **sebelum** mengubah server sungguhan.

- **Proyek**: tiga contoh bawaan (API sederhana, toko online, aplikasi web dengan database di disk lambat; semuanya data rekaan), dan proyek Anda sendiri. Untuk proyek sendiri, setel `PROJECTS_DIR` (mis. `D:/work`) dan `PROJECTS_ROOT=/projects` di `.env`: folder yang punya manifest (composer.json, package.json, go.mod, pom.xml, requirements.txt, Gemfile, .csproj) muncul di daftar dan dianalisis dari kodenya (Laravel, Node, Python, Java, Go, Ruby, .NET). Dibaca hanya-baca; `.env` proyek hanya dibaca kunci aman dan nilainya tidak pernah dicetak.
- **Awal eksperimen = rekomendasi**: dari analisis, aplikasi menyusun rekomendasi lengkap dengan alasan dan harganya, lalu eksperimen dimulai dengan rekomendasi itu sudah terpasang. Bandingkan dengan "kondisi sekarang" di sebelahnya, atau mulai dari kondisi sekarang yang kosong.
- **Blok bangunan**: Cache Redis (hit ratio), load balancer + beberapa server (dengan health check), filter/WAF/rate limit, replika baca database, **database HA (primary + standby + failover)**, database terpisah untuk satu fitur, antrean + worker latar, server lebih besar, SSD NVMe, CDN. Tiap blok punya parameter dan daftar "asumsi model" yang jujur. Komponen yang tidak berlaku untuk arsitektur itu diberi alasan.
- **Beban**: pengguna x request per menit, pengali 3x/10x, lonjakan trafik, lama simulasi, dan gangguan (disk tersendat, layanan luar melambat; yang tercatat nyata menyala otomatis, yang hanya asumsi tidak).
- **Skenario kegagalan (HA)**: "matikan komponen X pada detik T selama S detik" lalu bandingkan kondisi sekarang dengan eksperimen. Server tunggal atau database tanpa cadangan mati total; beberapa server di belakang load balancer hanya kehilangan 1/N kapasitas ditambah request yang masuk ke server mati sampai health check mendeteksinya; database HA terganggu selama failover lalu melambat sesaat (cache dingin). Hasilnya: detik layanan mati total, detik terganggu, ketersediaan, dan **transaksi yang berisiko hilang** (replikasi asinkron: laju tulis x lag; sinkron: nol tetapi commit lebih lambat). Cache (Redis) yang mati tidak mematikan layanan: request jatuh ke database.
- **Visual**: diagram arsitektur dengan aliran request yang bergerak (tebal dan cepat = ramai), warna pemakaian tiap komponen (hijau/kuning/merah), leher botol yang berdenyut dengan penjelasannya, komponen baru bertanda "baru", pemutar waktu, dan grafik waktu respons. Tampilan eksperimen, kondisi sekarang, atau berdampingan.
- **Potensi bottleneck (tanpa meramal RPM)**: tombol "Cari leher botol" menaikkan beban bertahap dari beban dasar (2×, 4×, 8×, ...) dan mencatat komponen mana yang jenuh lebih dulu, untuk kondisi sekarang dan eksperimen. Karena lama tiap panggilan dan CPU per request biasanya tebakan, analisis diulang dengan nilai itu divariasikan 0,5× sampai 2× (nilai yang terukur tidak diubah), lalu hasilnya "Server API jadi leher botol pertama di 7 dari 8 variasi". Jawaban yang konsisten bisa dipercaya; jawaban yang berubah-ubah berarti butuh pengukuran. Di diagram, tiga komponen teratas diberi nomor. Di bawahnya ada temuan dari kode dan konfigurasi lengkap dengan bukti (file dan nilai yang dibaca).
- **Skenario** bisa disimpan per proyek dan dibuka lagi.

Hasil simulasi **deterministik**: benih acaknya diturunkan dari masukan, jadi skenario yang sama selalu memberi hasil yang sama.

Cara kerja: mesin simulasi (`simulator/src/engine.js`) mensimulasikan request satu per satu (worker, koneksi database, fsync disk, antrean, timeout). Server menjalankannya di worker thread (120 detik simulasi sekitar 0,1 detik), jadi menggeser beban terasa langsung. **Ini model, bukan kenyataan**: hit ratio Redis, replication lag, dan biaya tidak dihitung dari data Anda. Pakai untuk membandingkan pilihan dan menemukan leher botol, lalu ukur di server sungguhan (monitor + agen) sebelum memutuskan. Menambah blok baru: satu entri di `simulator/src/components.js` (`describe` + `apply`) dan UI mengikutinya otomatis.

## Layanan tanpa SSH (halaman Layanan)

Untuk situs atau API yang tidak punya server untuk di-SSH (Vercel, Supabase, dan sejenisnya). Server ini membuka alamatnya secara berkala dan mencatat hidup/mati, waktu respons, dan masa berlaku sertifikat HTTPS. Notifikasi dikirim lewat kanal yang sama, hanya saat keadaan berubah dan setelah gagal berturut-turut (default 2 kali), lalu sekali saat pulih.

- Jenis "buka alamatnya" memantau dari luar, seperti pengunjung: tahu bila bermasalah, belum tahu sebabnya.
- Jenis **Vercel** menanyakan deploy produksi terakhir lewat API Vercel (GET /v7/deployments, token Bearer): deploy gagal dinilai kritis, deploy macet lebih dari 30 menit peringatan. Token disimpan terenkripsi dan tidak pernah dikembalikan; interval minimal 5 menit. Pengumpul lain (Supabase dan seterusnya) belum ada.
- Keamanan: alamat link-local dan metadata cloud (169.254.0.0/16, fe80::/10) ditolak saat menyambung, termasuk lewat pengalihan dan DNS; badan respons tidak pernah dibaca; pengalihan maksimal 3 kali. Alamat privat dan publik lain boleh karena memang itu yang dipantau.
- Riwayat hasil disimpan 14 hari.

## Login pertama dan password

- Instalasi baru: pengguna `admin`, password awal `123456`. Aplikasi **memaksa penggantian** saat masuk pertama (minimal 12 karakter, tidak boleh sama dengan yang lama atau 123456) dan menolak semua API lain sebelum itu. Jangan buka aplikasi ke jaringan sebelum password diganti.
- Bila `ADMIN_PASSWORD` (min. 12 karakter) disetel di lingkungan atau secret, password itu dipakai dan tidak dipaksa ganti.
- Lupa password: `docker compose exec app node dist/admin-cli.js reset-password [pengguna]` mengembalikan ke `123456`, memaksa ganti lagi, dan mencabut semua sesi.
- Ganti password kapan saja: Pengaturan, tab Akun dan keamanan.

## Playground: pasang susunan Docker Compose di server uji

Server yang ditandai **playground** (formulir Server) bisa dipasangi susunan Docker Compose lewat SSH, diuji beban dengan halaman Uji beban, lalu dicopot.

- Alur: tulis atau pilih Compose, aplikasi menganalisisnya (opsi berbahaya diblokir), Anda menyetujui ringkasannya, server menarik image dan menjalankan susunan, menunggu semua layanan sehat (dan path kesehatan bila diisi), lalu menampilkan target uji beban. **Copot** menghapus kontainer, jaringan, volume, dan berkas proyek.
- Syarat: server uji punya Docker dan Compose, pengguna SSH boleh memakai Docker, image ada di registry. `build` belum didukung.
- Keamanan: hanya server yang ditandai yang bisa dipasangi; Compose disimpan terenkripsi; `privileged`, host network, bind mount ke folder host, `docker.sock`, `cap_add`, `devices`, dan port 22/2375/2376 diblokir. Pakai server uji dan data uji saja.
- Uji nyata: `node scripts/e2e-playground.mjs <password-admin>` membuat server tiruan (Docker-in-Docker + sshd), memasang susunan sungguhan lewat aplikasi, memeriksa, lalu mencopot dan memastikan tidak ada yang tertinggal (20 pemeriksaan).

## Memakai AI di lab dan uji beban

Model yang Anda atur di Pengaturan (peran Monitoring, atau Setup bila Monitoring kosong) dipakai untuk dua hal, selalu berlabel "ditulis AI":

- **Penjelasan hasil uji beban** (tombol di halaman hasil): menafsirkan angka per tahap, menyebut dugaan leher botol beserta keyakinannya. Model hanya menerima angka, tanpa header atau rahasia.
- **Asumsi di lab** (tab Asumsi, proyek dari folder): model membaca berkas konfigurasi proyek (rahasia disamarkan, berkas `.env` asli tidak dibaca) dan mengusulkan nilai untuk parameter yang masih tebakan. Server memeriksa tiap kutipan bukti (berkas:baris); bukti yang tidak cocok dipaksa berkeyakinan rendah. Usulan baru dipakai simulasi setelah Anda menerimanya.

Keyakinan (tinggi/sedang/rendah) adalah penilaian model yang dicek server, bukan probabilitas terkalibrasi. Akurasi sungguhan baru bisa diukur dengan membandingkan prediksi lab dengan uji beban nyata.

## Uji beban (halaman Uji beban): hasil terukur, bukan perkiraan

Menaikkan beban **bertahap** ke server uji (bukan produksi) dengan k6 sungguhan, lalu mencatat di mana ia mulai tidak sehat dan komponen mana yang jenuh. Pelengkap lab arsitektur: lab memperkirakan, uji beban mengukur.

```
Browser -> AI Ops (app)  <-- runner loadgen (k6, kontainer terpisah, batas CPU/memori) --beban--> server uji (BUKAN produksi)
                                   ^ mengambil uji yang SUDAH Anda setujui; hanya koneksi keluar        |
                                   '--------- hasil tiap tahap + metrik server uji (dibaca tiap detik) <-'
```

- **Menjalankan**: `node scripts/init-secrets.mjs` (membuat `secrets/loadgen_secret.txt` bila belum ada), lalu `docker compose --profile loadtest up -d --build`. Halaman Uji beban menunjukkan "runner online".
- **Satu uji** = target + skenario request (metode, path, bobot, badan; diambil dari access log) + tahap pengguna (mis. 10, 25, 50, 100, 200 x 30 dtk) + kriteria lulus (p95 dan persen error) + metrik server uji (opsional) + header (opsional, terenkripsi). Menyimpan uji hanya membuat **draf**; ia baru berjalan setelah Anda menyetujuinya di dialog yang menyebut target, jumlah tahap, puncak pengguna, dan peringatan produksi.
- **Hasil**: per tahap p50/p95/p99, req/dtk, persen error, CPU pembangkit, serta metrik server uji (rata-rata dan puncak). Aplikasi menandai **tahap sehat terakhir** dan **lutut** (tahap pertama yang melanggar kriteria), mendeteksi throughput yang mendatar, dan memberi kesimpulan. Metrik server uji (teks Prometheus dari node_exporter, postgres_exporter, redis_exporter, cAdvisor, dsb., atau JSON) dibaca tiap detik, jadi di tahap lutut kelihatan komponen mana yang mendekati batasnya.
- **Keamanan**: target dibatasi ke jaringan lokal (10.x, 172.16-31.x, 192.168.x, localhost, nama layanan Docker) atau host yang Anda daftarkan sendiri di `LOADTEST_ALLOWED_HOSTS`; diperiksa di server, lalu **diperiksa ulang oleh runner setelah DNS di-resolve** (nama yang menunjuk ke IP publik ditolak). Konfirmasi "bukan produksi" wajib. Satu uji pada satu waktu. Skrip k6 tetap; data Anda lewat variabel lingkungan sehingga tidak ada injeksi skrip. Runner tidak punya akses socket Docker, tidak membuka port, dan hanya mengambil uji berstatus disetujui. Header disimpan terenkripsi dan tak pernah dikembalikan API.
- **Kejujuran hasil**: bila pembangkit memakai CPU di atas 70% pada sebuah tahap, tahap itu ditandai **tidak murni** (yang jenuh mungkin pembangkitnya, bukan server uji); beri `LOADGEN_CPUS` lebih banyak atau pindahkan runner ke mesin lain. Pembatalan dari UI menghentikan k6 dalam hitungan detik. Runner yang berhenti melapor membuat uji ditutup sebagai gagal.
- **Mencoba tanpa server uji**: `docker compose --profile demo --profile loadtest up -d --build` menyalakan aplikasi contoh (`demo-api`, pool database kecil yang sengaja bisa jenuh); target `http://demo-api:8080`, metrik `http://demo-api:8080/metrics` (mis. `demo_db_pool_in_use`). `node scripts/e2e-loadtest.mjs` menjalankan seluruh alur dengan k6 sungguhan dan memeriksa lutut serta metrik.

## HTTPS di jaringan lokal (tanpa membuka port ke internet)

Catatan DNS: profil `lan` memakai DNS-01 lewat plugin Caddy sesuai penyedia DNS domain Anda. Untuk penyedia **tanpa plugin Caddy** (mis. Niagahoster: belum ada plugin dan API DNS publiknya tidak terkonfirmasi), pakai profil `lan-internal` (CA internal; pasang root CA di perangkat) atau pindahkan nameserver domain ke penyedia yang punya plugin (mis. Cloudflare, gratis; salin dulu semua record DNS yang ada).

Dua profil Caddy; keduanya hanya mendengarkan di `BIND_ADDR` (IP LAN):
- **`lan`: domain Anda + Let's Encrypt via DNS-01** (disarankan). Buat record A `aiops.domainanda.com` -> IP privat server ini, buat token API DNS (hanya izin edit zona itu), isi `.env`: `DOMAIN`, `DNS_PROVIDER` (bawaan cloudflare; lihat github.com/caddy-dns), `DNS_API_TOKEN`, `BIND_ADDR`, `ALLOWED_HOSTS=<domain>`, `PUBLIC_URL=https://<domain>`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`. Jalankan `docker compose --profile lan up -d --build`. Sertifikat dipercaya semua perangkat, tanpa memasang CA.
- **`lan-internal`: CA internal Caddy** (tanpa domain): `docker compose --profile lan-internal up -d`, ambil root CA (`docker compose --profile lan-internal exec caddy-internal cat /data/caddy/pki/authorities/local/root.crt`), impor di browser, dan isi `ca_file` di konfigurasi agen.

Diuji: `node scripts/e2e-lan-https.mjs aiops.lan 8443` (profil lan-internal; 12 pemeriksaan: rantai sertifikat tervalidasi penuh, ditolak tanpa CA, HSTS, cookie Secure, agen terhubung via HTTPS dengan `ca_file` dan ditolak tanpa itu). Caddyfile DNS-01 divalidasi dengan Caddy + plugin Cloudflare; **penerbitan sertifikat Let's Encrypt sungguhan belum diuji** karena butuh domain dan token DNS Anda.

## Agen di server: hanya mendorong yang kritis

Untuk server yang tidak terjangkau SSH (di belakang NAT/firewall) atau yang ingin dipantau tanpa polling, pasang **agen kecil** (Go, satu biner statis ~6 MB, tanpa dependensi, linux amd64/arm64). Panduan pemasangan lengkap dengan kunci dibuat di UI: **Server > Agen**.

Alur: agen menilai kondisi **di server sendiri** (CPU, memori, disk, tekanan I/O, layanan systemd, port, HTTP, kenaikan log, perintah baca kustom) hanya dengan ambang **kritis** -> kirim kejadian ke aplikasi -> aplikasi membuat **insiden** + **rekomendasi** (playbook, disempurnakan model bila dikonfigurasi) -> Anda meninjau dan **menyetujui** langkah yang dipilih -> dijalankan (lewat SSH, atau oleh agen bila server tak terjangkau SSH) -> verifikasi -> agen melaporkan pulih.

**Data yang dikirim sangat sedikit**
- Kondisi normal: **tidak ada kejadian**. Hanya detak jantung ~70 byte tiap menit (terukur: 97 KB badan permintaan per 24 jam; dengan header HTTP sekitar 0,5 MB/hari; naikkan `heartbeat_seconds` ke 300 untuk sekitar 0,1 MB/hari).
- Kejadian hanya saat status berubah: **open** (dengan diagnostik singkat maks. 8 KB, rahasia disamarkan), **resolved** (tanpa diagnostik), dan pengingat "masih kritis" tiap 60 menit selama belum pulih. Kritis baru dianggap terjadi setelah 2 pengukuran berturut-turut, pulih setelah 2 normal (anti kedip).
- Tanpa insiden, agen **tidak** melakukan long-poll perintah. Saat ada insiden terbuka atau perintah disetujui, agen mengambil perintah (long-poll 25 detik).
- Aplikasi tidak menjangkau agen; agen hanya membuat koneksi **keluar**. Tidak ada port terbuka di server.

**Keamanan agen**
- Tiap permintaan ditandatangani HMAC-SHA256 (secret tidak pernah dikirim), cap waktu +-5 menit, kejadian beridempotensi (kirim ulang tidak menggandakan).
- Eksekusi **mati secara bawaan** (`allow_exec=false`). Bila dinyalakan, agen hanya menjalankan perintah yang: sudah Anda setujui, **ditandatangani server** (terikat id, isi perintah, dan kedaluwarsa 10 menit), belum pernah dijalankan (anti replay, bertahan setelah restart), dan lolos daftar blokir lokal (rm -rf /, mkfs, reboot, DROP DATABASE, ...) walau server terkompromi. Keluaran disamarkan dan dibatasi.
- Kegagalan jaringan: kejadian ditahan di disk (maks. 200) dan dikirim saat aplikasi kembali; backoff eksponensial.
- Agen mati/jaringan putus diketahui aplikasi (peringatan "agen tidak mengirim detak jantung" ke kanal notifikasi Anda).

**Eksekusi perbaikan**: perintah langkah dari rekomendasi diklasifikasi ulang (baca/ubah/blokir); yang diblokir tidak pernah disimpan. Langkah *ubah* yang gagal menghentikan sisa rencana; langkah *baca* yang gagal (alat tidak ada) tidak. Satu eksekusi per server pada satu waktu, persetujuan atomik, semua tercatat di jejak audit.

Uji nyata: `node scripts/e2e-agent.mjs` menjalankan agen Go sungguhan di kontainer Linux terhadap aplikasi Docker (25 pemeriksaan: pasang dari panduan, insiden, rekomendasi, persetujuan, eksekusi oleh agen yang benar-benar mengubah keadaan server, pulih otomatis). Butuh `ALLOWED_HOSTS` memuat `app` di `.env`.

Agar agen bisa menghubungi aplikasi, setel `PUBLIC_URL` (alamat yang terjangkau dari server) dan tambahkan hostname-nya ke `ALLOWED_HOSTS`; gunakan HTTPS (profil `lan` atau `lan-internal`, atau reverse proxy HTTPS Anda sendiri dengan `TRUST_PROXY=true`). Agen menolak `http://` kecuali `insecure_http=true` (hanya uji lokal).

## Pengembangan dan tes

```
# backend (Express + TypeScript)
cd server && npm ci
docker run -d --rm --name aiops-test-pg -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine -c fsync=off
npm run typecheck && npm test        # 249 tes terhadap PostgreSQL sungguhan (skema terisolasi per berkas uji)

# frontend (React + Vite)
cd web && npm ci
npm run typecheck && npm test        # 79 tes komponen/alur/lab/uji beban (jsdom, fetch dipalsukan)
npm run dev                          # http://localhost:5173, /api /agent /lab diteruskan ke server di :4317

node scripts/e2e-ui.mjs http://localhost:4317 "<password>"   # uji browser (Chrome headless); untuk langkah Uji beban jalankan stack dengan --profile demo --profile loadtest
```

`TEST_DATABASE_URL` bisa menunjuk Postgres lain. `docker build` menjalankan tes web dan tes agen Go sebelum membuat image. Tes memakai SSH dan model palsu serta penerima notifikasi lokal; belum ada tes ke server/penyedia sungguhan.

## Struktur

- `server/` backend (Express 5 + TypeScript): `src/` kode, `migrations/` skema, `test/` tes.
- `web/` UI (React 19 + Vite + TypeScript): dibangun saat `docker build` dan disajikan oleh server dari `/app/public`.
- `loadgen/` runner pembangkit beban (Go + k6): diuji (13 tes) dan dibangun lewat `loadgen/Dockerfile`; `demo/` aplikasi contoh sebagai target uji.
- `agent/` agen untuk server (Go): `go test ./...` (22 tes) berjalan saat `docker build`; biner linux amd64/arm64 diunduh dari aplikasi.
- `simulator/` (`src/` mesin + komponen eksperimen, `tools/` analyzer + worker lab + tes, `architectures/` contoh, `bin/` CLI, `knowledge/`): JavaScript tanpa dependensi, `npm test` di folder itu (58 tes). Dipakai server untuk halaman Arsitektur dan rencana setup dari folder proyek. CLI: `node simulator/bin/aiops.js scan|recommend <folder>`.

## Struktur kode dan konvensi

**Backend** (`server/src`). Logika bisnis ada di modul domain per fitur (`servers.ts`, `monitor.ts`, `incidents.ts`, `vault.ts`, `docs.ts`, `maintenance.ts`, ...) dan tidak mengenal HTTP. Semua yang berbau HTTP ada di `http/`:

```
app.ts                      merakit middleware dengan urutan yang disengaja (diberi komentar)
http/middleware/            security (helmet, penjaga Host, CSRF), session, rateLimit, errors, metrics
http/routes/<fitur>.ts      satu berkas per fitur: skema zod + rute tipis yang memanggil modul domain
http/routes/index.ts        daftar rute /api: CSRF -> login (publik) -> wajib sesi -> fitur
http/agentApi.ts            API agen (/agent/*): tanda tangan HMAC, badan mentah dipertahankan
http/handle.ts              handle() (kembalikan data = JSON), parse() zod, idParam()
```

Menambah endpoint: (1) tulis fungsi di modul domain, (2) tambahkan rute di `http/routes/<fitur>.ts` dengan `handle(...)` dan skema `zod`, (3) tulis tes di `server/test`. Rute di bawah `/api` otomatis wajib sesi dan header `X-AIOps`; jangan memasang rute `/api` di luar `routes/index.ts`. Galat: lempar `bad('pesan')` (400) atau `new HttpError(status, 'pesan')`; `errorHandler` mengubahnya menjadi `{ "error": "..." }`.

**Frontend** (`web/src`):

```
api/types.ts            bentuk data dari backend
api/queries.ts          semua query (kunci, interval polling) dan useAction() untuk aksi yang mengubah data
lib/                    api (klien fetch + header CSRF), format, toast
components/ui/          komponen dasar (Button, Badge, Field/useForm, Layout, DataTable, Modal, Charts, Async)
components/dialogs/     useDialogs(): confirm / askPassword / promptText / showSecret berbasis janji
components/icons.ts     satu-satunya tempat memilih ikon (react-icons/Lucide), tanpa emoji
features/<halaman>/     satu folder per halaman; berkas besar dipecah per panel
layout/, App.tsx        kerangka dan daftar rute
styles/                 token warna, dasar, tata letak, komponen
```

Konvensi: data server selalu lewat `useQuery(q.xxx())` (polling dan segar-ulang diatur di `queries.ts`, bukan di komponen); perubahan lewat `useAction(...)` yang menampilkan galat otomatis dan menyegarkan kunci query terkait (`invalidate`); tombol yang memicu aksi async memakai `<Button onClick={...}>` (terkunci saat berjalan, galat ditampilkan); pengganti `confirm()`/`prompt()` bawaan peramban adalah `useDialogs()`.

## Catatan jujur

- Agen dan pemeriksaan sudah teruji dengan SSH/model palsu; coba dulu dengan tujuan "Diagnosis awal (baca saja)" di satu server sebelum meminta perubahan.
- Klasifikasi perintah memakai daftar putih yang konservatif, bukan jaminan mutlak: tetap baca perintah sebelum menyetujui.
- Kunci SSH harus tanpa passphrase. Host key server baru diterima sekali (disimpan di volume `appdata`), setelah itu harus cocok.
- `node:sqlite` tidak lagi dipakai; PostgreSQL adalah satu-satunya basis data.
