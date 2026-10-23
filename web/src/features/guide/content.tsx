// Isi panduan. Dipisah dari halaman agar mudah diperbarui tanpa menyentuh tata letak.
// Setiap langkah ditulis sampai ke perintah yang bisa disalin, termasuk versi Windows.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Hint, Note } from '@/components/ui/Layout';
import { IconAlert } from '@/components/icons';
import { CodeBlock } from './CodeBlock';
import { AgentFlow, KeyMap, KeyPair } from './diagrams';

export interface GuideSection { id: string; title: string; body: ReactNode }

const KEYGEN_WIN = `mkdir $env:USERPROFILE\\.ssh -Force
ssh-keygen -t ed25519 -f "$env:USERPROFILE\\.ssh\\aiops_key" -C "aiops"
# Saat ditanya passphrase: tekan Enter dua kali (kosongkan)`;
const KEYGEN_NIX = `mkdir -p ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/aiops_key -C "aiops"
# Saat ditanya passphrase: tekan Enter dua kali (kosongkan)`;
const COPY_PRIV_WIN = `Get-Content "$env:USERPROFILE\\.ssh\\aiops_key" -Raw | Set-Clipboard`;
const COPY_PRIV_MAC = `pbcopy < ~/.ssh/aiops_key`;
const SHOW_PUB_WIN = `Get-Content "$env:USERPROFILE\\.ssh\\aiops_key.pub"`;
const SHOW_PUB_NIX = `cat ~/.ssh/aiops_key.pub`;

const LOGIN = `ssh PENGGUNA_ANDA@IP-SERVER
# contoh: ssh root@203.0.113.10   atau   ssh ubuntu@192.168.1.20`;
const SAME_USER = `mkdir -p ~/.ssh && chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
# tempel isi aiops_key.pub di baris baru (satu baris penuh), simpan: Ctrl+O, Enter, Ctrl+X
chmod 600 ~/.ssh/authorized_keys`;
const NEW_USER = `sudo adduser --disabled-password --gecos "" aiops
sudo -u aiops -H bash -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
sudo nano /home/aiops/.ssh/authorized_keys
# tempel isi aiops_key.pub di baris baru, simpan: Ctrl+O, Enter, Ctrl+X`;
const TEST_WIN = `ssh -i "$env:USERPROFILE\\.ssh\\aiops_key" -o IdentitiesOnly=yes PENGGUNA@IP-SERVER "uname -a && uptime"`;
const TEST_NIX = `ssh -i ~/.ssh/aiops_key -o IdentitiesOnly=yes PENGGUNA@IP-SERVER "uname -a && uptime"`;
const NOPASS = `sudo sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload ssh || sudo systemctl reload sshd`;

const ENV_AGENT = `# berkas .env di folder AIOpsAgent
PUBLIC_URL=https://aiops.contoh.com
ALLOWED_HOSTS=localhost,127.0.0.1,aiops.contoh.com`;
const AGENT_CHECK = `systemctl status aiops-agent --no-pager
journalctl -u aiops-agent -n 50 --no-pager
curl -fsS https://aiops.contoh.com/health`;
const AGENT_REMOVE = `systemctl disable --now aiops-agent
rm -f /usr/local/bin/aiops-agent /etc/aiops-agent.json /etc/systemd/system/aiops-agent.service
systemctl daemon-reload`;

export const SECTIONS: GuideSection[] = [
  {
    id: 'mulai', title: 'Ringkasan: menambah server pertama',
    body: (
      <>
        <p>Ada tiga pihak. Gambar ini menunjukkan siapa memegang apa:</p>
        <KeyMap />
        <p>Intinya: kunci dibuat sekali di komputer Anda, <b>privat ke AI Ops</b>, <b>publik ke server</b>. Setelah itu AI Ops bisa masuk ke server sendiri.</p>
        <Hint icon={IconAlert}><span><b>Login pertama:</b> pengguna <code>admin</code>, password <code>123456</code>. Aplikasi langsung <b>memaksa Anda membuat password baru</b> (minimal 12 karakter) dan tidak membuka fitur apa pun sebelum itu. Lupa password? Di komputer tempat Docker berjalan: <code>docker compose exec app node dist/admin-cli.js reset-password</code> (mengembalikan ke 123456 dan memaksa ganti lagi).</span></Hint>
        <p>Untuk memantau satu server Linux Anda cukup melakukan <b>enam langkah</b>. Agen (langkah di bagian 6) <b>tidak wajib</b>; tanpa agen, monitoring tetap jalan lewat SSH.</p>
        <ol>
          <li>Siapkan kunci SSH (bagian 2). <b>Cara termudah: biarkan aplikasi yang membuatnya</b> lewat tombol "Buat kunci otomatis" di formulir Server, tanpa perintah apa pun.</li>
          <li>Pasang <b>kunci publik</b> di server (bagian 3).</li>
          <li>Uji login dengan kunci dari komputer Anda (bagian 3).</li>
          <li>Tambahkan server di menu <b>Server</b>, tempel <b>kunci privat</b> (bagian 4).</li>
          <li>Tekan <b>Uji koneksi</b>. Bila muncul sistem operasi server, selesai.</li>
          <li>Isi model AI di <b>Pengaturan</b> bila ingin rekomendasi dan setup oleh AI (bagian 5).</li>
        </ol>
        <p>Selain server SSH, ada <b>Layanan</b> untuk situs/API tanpa server (bagian 7), serta <b>Arsitektur</b> dan <b>Uji beban</b> (bagian 8).</p>
        <Note>Semua perubahan pada server menunggu persetujuan Anda. Perintah baca berjalan otomatis, perintah yang mengubah sesuatu butuh klik setuju, perintah merusak diblokir.</Note>
      </>
    )
  },
  {
    id: 'kunci', title: 'Buat kunci SSH di komputer Anda',
    body: (
      <>
        <p>Komunikasi ke server <b>hanya memakai kunci SSH</b>. Login dengan password tidak didukung dan tidak pernah disimpan. Kunci terdiri dari dua berkas: <b>privat</b> (rahasia, ditempel ke aplikasi) dan <b>publik</b> (dipasang di server). Buat kunci khusus untuk AI Ops, jangan memakai kunci pribadi Anda.</p>
        <h3>Cara termudah: aplikasi yang membuat kunci</h3>
        <ol>
          <li>Buka menu <b>Server</b>, isi nama, host, dan pengguna SSH, lalu tekan <b>Buat kunci otomatis</b>.</li>
          <li>Tekan <b>Simpan</b>. Aplikasi membuat pasangan kunci, menyimpan yang <b>privat</b> terenkripsi (tidak pernah ditampilkan), dan menampilkan satu baris <b>kunci publik</b>.</li>
          <li>Salin baris itu, lalu pasang di server (bagian 3). Kunci publik bisa dibuka lagi kapan saja lewat tombol <b>Kunci publik</b> pada baris server.</li>
        </ol>
        <p>Dengan cara ini Anda tidak perlu <code>ssh-keygen</code>, tidak perlu menyalin kunci privat, dan tidak ada berkas rahasia tertinggal di komputer Anda. Cocok untuk pemula.</p>
        <h3>Cara lain: Anda sudah punya kunci</h3>
        <p>Di formulir Server tekan <b>Pilih berkas kunci</b> dan pilih berkas kunci <b>privat</b> Anda (tanpa <code>.pub</code>). Berkas dibaca di browser, lalu disimpan terenkripsi oleh aplikasi. Berkas yang bukan kunci privat ditolak.</p>
        <h3>Cara manual: membuat kunci sendiri</h3>
        <p>Pasangan kunci terdiri dari dua berkas:</p>
        <KeyPair />
        <p>Kunci dibuat <b>tanpa passphrase</b> karena aplikasi berjalan otomatis dan tidak bisa mengetik passphrase.</p>
        <h3>Windows (PowerShell, OpenSSH sudah bawaan Windows 10/11)</h3>
        <CodeBlock title="Windows: buat kunci">{KEYGEN_WIN}</CodeBlock>
        <h3>macOS atau Linux</h3>
        <CodeBlock title="macOS / Linux: buat kunci">{KEYGEN_NIX}</CodeBlock>
        <p>Hasilnya dua berkas di folder <code>.ssh</code> milik Anda: <code>aiops_key</code> (privat) dan <code>aiops_key.pub</code> (publik).</p>
        <h3>Menyalin kunci privat untuk ditempel ke aplikasi</h3>
        <p>Perintah ini menyalin seluruh isi kunci privat ke clipboard, jadi Anda tinggal menempel (Ctrl+V) di formulir server pada bagian 4:</p>
        <CodeBlock title="Windows: salin kunci privat ke clipboard">{COPY_PRIV_WIN}</CodeBlock>
        <CodeBlock title="macOS: salin kunci privat ke clipboard">{COPY_PRIV_MAC}</CodeBlock>
        <p>Di Linux, buka <code>~/.ssh/aiops_key</code> dengan editor teks lalu salin semuanya. Isinya harus diawali <code>-----BEGIN OPENSSH PRIVATE KEY-----</code> dan diakhiri <code>-----END OPENSSH PRIVATE KEY-----</code>.</p>
        <Hint icon={IconAlert}>Kunci privat tidak boleh dikirim lewat chat atau email, dan jangan dibagikan. Aplikasi menyimpannya terenkripsi dan tidak pernah menampilkannya lagi. Kunci <b>publik</b> (<code>.pub</code>) aman dibagikan.</Hint>
      </>
    )
  },
  {
    id: 'server', title: 'Pasang kunci publik di server dan uji',
    body: (
      <>
        <p>Tujuan bagian ini hanya satu: memasukkan <b>satu baris kunci publik</b> (diawali <code>ssh-ed25519</code>) ke berkas <code>~/.ssh/authorized_keys</code> milik pengguna SSH di server. Dari mana baris itu didapat tergantung cara Anda membuat kunci di bagian 2. <b>Pilih salah satu dari dua cara di bawah, jangan keduanya.</b></p>
        <h3>Cara 1 (disarankan): kunci dibuat oleh aplikasi</h3>
        <p>Dipakai bila Anda menekan <b>Buat kunci otomatis</b>. Di cara ini <b>tidak ada berkas <code>aiops_key.pub</code> di komputer Anda</b>, jadi perintah <code>cat</code> atau <code>Get-Content</code> di Cara 2 tidak berlaku.</p>
        <ol>
          <li>Setelah menekan <b>Simpan dan buat kunci</b>, muncul jendela berisi <b>perintah siap tempel</b>. Tekan <b>Salin</b>. Jendela itu bisa dibuka lagi lewat tombol <b>Kunci publik</b> di baris server.</li>
          <li>Masuk ke server, sebagai pengguna <b>Pengguna SSH</b> di formulir (mis. <code>ubuntu</code>) <b>atau sebagai root</b>. Perintahnya sendiri yang memasang kunci ke berkas milik pengguna di formulir, jadi tidak masalah Anda login sebagai siapa:</li>
        </ol>
        <CodeBlock title="Masuk ke server (dari komputer Anda)">{LOGIN}</CodeBlock>
        <ol start={3}>
          <li>Tempel perintah yang tadi disalin, lalu Enter. Perintah itu memeriksa bahwa pengguna ada, membuat folder <code>.ssh</code> bila belum ada, menambahkan kunci <b>tanpa menghapus kunci lain</b>, mengatur izin dan kepemilikannya, lalu menulis "Kunci terpasang untuk ...".</li>
          <li>Kembali ke aplikasi dan tekan <b>Uji koneksi</b> pada baris server. Bila muncul sistem operasi server, selesai.</li>
        </ol>
        <h3>Cara 2: Anda membuat kunci sendiri dengan ssh-keygen</h3>
        <p>Dipakai bila Anda memilih cara manual di bagian 2, sehingga ada berkas <code>aiops_key.pub</code> di komputer Anda. Tampilkan kunci publik lalu salin:</p>
        <CodeBlock title="Windows: tampilkan kunci publik">{SHOW_PUB_WIN}</CodeBlock>
        <CodeBlock title="macOS / Linux: tampilkan kunci publik">{SHOW_PUB_NIX}</CodeBlock>
        <p>Masuk ke server dengan cara yang Anda pakai sekarang (password atau kunci yang sudah ada). Bila VPS Anda punya kolom "SSH keys" di panel penyedia, Anda juga bisa menempel kunci publik di sana dan melewati langkah di bawah.</p>
        <CodeBlock title="Masuk ke server (dari komputer Anda)">{LOGIN}</CodeBlock>
        <h4>Pilihan A: pakai pengguna yang sudah ada (paling cepat)</h4>
        <p>Di server, jalankan ini sebagai pengguna yang tadi Anda pakai login:</p>
        <CodeBlock title="Di server: pasang kunci publik">{SAME_USER}</CodeBlock>
        <h4>Pilihan B: pengguna khusus <code>aiops</code> (lebih rapi dan aman)</h4>
        <p>Di server, sebagai root atau pengguna dengan sudo:</p>
        <CodeBlock title="Di server: buat pengguna dan pasang kunci publik">{NEW_USER}</CodeBlock>
        <h4>Uji login memakai kunci dari komputer Anda (hanya Cara 2)</h4>
        <p>Pertama kali akan ditanya "Are you sure you want to continue connecting": ketik <code>yes</code>. Ganti <code>PENGGUNA</code> dengan <code>aiops</code> (pilihan B) atau pengguna Anda (pilihan A).</p>
        <CodeBlock title="Windows: uji login dengan kunci">{TEST_WIN}</CodeBlock>
        <CodeBlock title="macOS / Linux: uji login dengan kunci">{TEST_NIX}</CodeBlock>
        <p>Bila keluar informasi server tanpa meminta password, kunci berfungsi. Setelah itu tekan <b>Uji koneksi</b> di aplikasi. Bila diminta password atau muncul <code>Permission denied</code>, lihat bagian 10.</p>
        <h3>Sudo dan keamanan tambahan</h3>
        <ul>
          <li><b>Sudo:</b> mulailah tanpa sudo; pemantauan dasar tetap jalan. Bila nanti perbaikan butuh hak root, beri sudo tanpa password hanya untuk perintah yang perlu, lalu centang opsi sudo di formulir server.</li>
          <li><b>Firewall:</b> port SSH (biasanya 22) harus bisa dijangkau dari komputer tempat AI Ops berjalan. Untuk server di internet, batasi hanya ke alamat Anda bila bisa.</li>
          <li><b>Matikan login password</b> di server setelah kunci terbukti berfungsi (opsional, lebih aman):</li>
        </ul>
        <CodeBlock title="Di server: matikan login password">{NOPASS}</CodeBlock>
        <Note>AI Ops berjalan di dalam Docker, jadi server harus bisa dijangkau dari kontainer. Alamat LAN atau internet biasanya langsung bisa; alamat yang hanya ada di dalam VPN komputer Anda bisa gagal. Karena itu kunci <b>ditempel</b> ke formulir, bukan ditunjuk lewat path berkas di Windows (kontainer tidak melihat folder Windows Anda).</Note>
      </>
    )
  },
  {
    id: 'tambah', title: 'Tambahkan server di aplikasi',
    body: (
      <>
        <ol>
          <li>Buka menu <b>Server</b>. Formulir "Tambah server" ada di sebelah kanan.</li>
          <li><b>Nama</b>: bebas, mis. <code>srv-database</code>. <b>Host / IP</b>: alamat server. <b>Port</b>: biasanya 22. <b>Pengguna SSH</b>: <code>aiops</code> (pilihan B) atau pengguna Anda (pilihan A).</li>
          <li><b>Kunci SSH</b>: pilih salah satu: tekan <b>Buat kunci otomatis</b> (disarankan), tekan <b>Pilih berkas kunci</b>, atau tempel (Ctrl+V) isi kunci privat dari bagian 2. Tombol Simpan terkunci sampai salah satunya dipilih.</li>
          <li><b>Layanan yang dipantau</b>: nama layanan systemd, mis. <code>nginx,mysql,php8.2-fpm</code>. Kosongkan bila belum tahu.</li>
          <li><b>Catatan untuk agen</b>: peran server dan hal yang tidak boleh disentuh. Dibaca AI saat menyusun rekomendasi.</li>
          <li>Tekan <b>Simpan</b>. Bila memakai kunci otomatis, pasang kunci publik yang muncul di server lebih dulu (bagian 3). Lalu tekan <b>Uji koneksi</b> pada baris server. Bila berhasil, muncul sistem operasi, CPU, dan RAM server.</li>
        </ol>
        <Note>Pertama kali tersambung, aplikasi mencatat sidik jari host server dan menolak bila nanti berubah. Itu perlindungan terhadap penyadapan, bukan galat.</Note>
      </>
    )
  },
  {
    id: 'ai', title: 'Isi model AI (untuk rekomendasi dan setup)',
    body: (
      <>
        <p>Monitoring dasar tidak butuh AI. Rekomendasi perbaikan, ringkasan, dan setup oleh AI butuh model:</p>
        <ol>
          <li>Buka <b>Pengaturan</b>, bagian "Penyedia dan API key", tekan <b>Tambah penyedia</b>, pilih preset (Anthropic, OpenAI, dan lainnya), isi API key.</li>
          <li>Di "Model per peran", pilih penyedia dan model untuk peran <b>Setup</b> (model kuat) dan <b>Monitoring</b> (boleh yang murah).</li>
          <li>Tambahkan kanal notifikasi (Telegram, ntfy, webhook, email) bila ingin diberi tahu saat ada peringatan.</li>
        </ol>
        <p>Pemakaian token tercatat di menu <b>Pemakaian token</b>.</p>
      </>
    )
  },
  {
    id: 'agen', title: 'Pasang agen di server (opsional)',
    body: (
      <>
        <p>Agen adalah program kecil di server yang mengirim kondisi dan kejadian kritis ke aplikasi, sehingga insiden terdeteksi seketika dan rekomendasi dibuat otomatis. Tanpa agen, aplikasi tetap memantau lewat SSH secara berkala.</p>
        <Hint icon={IconAlert}><span><b>Syarat penting:</b> agen berjalan di server Anda lalu menghubungi aplikasi lewat <b>HTTPS</b>. Agen menolak alamat <code>http://</code>, dan alamat <code>localhost</code> tidak terjangkau dari server lain. Jadi aplikasi harus punya alamat HTTPS yang bisa dibuka dari server tersebut.</span></Hint>
        <p>Dua jalur komunikasi berbeda arah. SSH dimulai oleh AI Ops, laporan agen dimulai oleh agen:</p>
        <AgentFlow />
        <h3>Langkah 1: sediakan alamat HTTPS untuk aplikasi</h3>
        <ul>
          <li><b>Server dan aplikasi satu jaringan (LAN):</b> pakai profil <code>lan</code> atau <code>lan-internal</code> (HTTPS dengan domain Anda). Langkahnya ada di README bagian "HTTPS di jaringan lokal".</li>
          <li><b>Aplikasi dijalankan di VPS atau server publik:</b> letakkan di belakang reverse proxy HTTPS milik Anda sendiri (Caddy atau Nginx), lalu setel <code>TRUST_PROXY=true</code> dan <code>COOKIE_SECURE=true</code> di <code>.env</code>.</li>
          <li><b>Hanya ingin mencoba tanpa HTTPS:</b> lewati agen dan pakai SSH saja.</li>
        </ul>
        <h3>Langkah 2: beri tahu aplikasi alamatnya</h3>
        <CodeBlock title="Ubah berkas .env lalu jalankan: docker compose up -d">{ENV_AGENT}</CodeBlock>
        <h3>Langkah 3: buat agen</h3>
        <ol>
          <li>Buka menu <b>Server</b>, pada baris server tekan lencana <b>Agen</b>.</li>
          <li>Tekan <b>Buat kunci agen</b>. Biarkan opsi eksekusi <b>mati</b> dulu: agen hanya melapor.</li>
          <li>Muncul skrip pemasangan. <b>Salin sekarang</b>, rahasianya hanya tampil sekali. Bila terlewat, tekan "Rotasi kunci dan cetak ulang panduan".</li>
          <li>Masuk ke server sebagai root dan tempel skrip itu. Skrip mengunduh biner, memeriksa checksum, menulis konfigurasi (mode 600), membuat layanan systemd, lalu menjalankan pemeriksaan.</li>
          <li>Kembali ke halaman agen. Status berubah menjadi <b>online</b> dalam beberapa detik.</li>
        </ol>
        <h3>Bila agen tidak online (jalankan di server)</h3>
        <CodeBlock title="Di server: periksa agen">{AGENT_CHECK}</CodeBlock>
        <p>Ganti alamat pada baris terakhir dengan <code>PUBLIC_URL</code> Anda. Bila <code>curl</code> gagal, server tidak bisa menjangkau aplikasi. Jam server juga harus akurat (selisih lebih dari 5 menit ditolak).</p>
        <h3>Mencopot agen</h3>
        <CodeBlock title="Di server: copot agen">{AGENT_REMOVE}</CodeBlock>
        <Note>Agen berkomunikasi lewat HTTPS bertanda tangan HMAC, bukan SSH, dan tidak membuka port untuk koneksi masuk.</Note>
      </>
    )
  },
  {
    id: 'layanan', title: 'Layanan tanpa SSH (Vercel, Supabase, hosting biasa)',
    body: (
      <>
        <p>Untuk situs atau API yang tidak punya server untuk di-SSH, buka <b>Layanan</b>:</p>
        <ul>
          <li><b>Situs atau API:</b> isi alamat. Aplikasi membukanya berkala dan mencatat hidup atau mati, kecepatan, dan masa berlaku sertifikat HTTPS.</li>
          <li><b>Vercel:</b> isi nama proyek dan token. Token dibuat di Vercel (Account Settings, Tokens); buat token khusus dan batasi ke tim yang perlu. Aplikasi menanyakan status deploy produksi terakhir dan memperingatkan bila gagal atau macet.</li>
        </ul>
        <p>Notifikasi dikirim setelah beberapa kali gagal berturut-turut (bisa diatur) dan sekali lagi saat pulih. Tidak ada perintah yang dijalankan ke layanan itu.</p>
      </>
    )
  },
  {
    id: 'lab', title: 'Arsitektur dan uji beban',
    body: (
      <>
        <ul>
          <li><b>Arsitektur:</b> lab seperti permainan. Pilih proyek, tambah komponen (Redis, load balancer, replika, HA), ubah beban, dan lihat animasinya. Panel "Potensi bottleneck" menunjukkan komponen mana yang jenuh lebih dulu. Ini model, bukan kenyataan: pakai untuk membandingkan pilihan, bukan meramal angka.</li>
          <li><b>Asumsi</b> (tab di lab): parameter yang masih tebakan. Tombol AI membaca berkas konfigurasi proyek dan mengusulkan nilai beserta keyakinan dan buktinya. Hanya untuk proyek dari folder (butuh <code>PROJECTS_DIR</code> di <code>.env</code>).</li>
          <li><b>Uji beban:</b> pengujian nyata dengan pembangkit beban ke server <b>non-produksi</b> Anda. Aplikasi menolak alamat publik kecuali Anda daftarkan sendiri. Tombol AI menjelaskan angkanya.</li>
        </ul>
        <Hint icon={IconAlert}>Jangan pernah mengarahkan uji beban ke server produksi atau milik orang lain. Itu setara serangan DoS.</Hint>
      </>
    )
  },
  {
    id: 'playground', title: 'Playground: pasang susunan di server uji',
    body: (
      <>
        <p>Playground adalah <b>server khusus uji</b> tempat Anda memasang susunan Docker Compose (aplikasi, database, Redis, load balancer), menguji bebannya dengan <b>Uji beban</b>, lalu mencopotnya. Hasilnya <b>diukur nyata</b>, bukan simulasi seperti halaman Arsitektur.</p>
        <Hint icon={IconAlert}><span>Pakai <b>server uji</b>, bukan produksi. Compose dijalankan sungguhan di server itu, dan data di volumenya <b>dihapus</b> saat dicopot. Jangan memakai data produksi atau data pelanggan.</span></Hint>
        <h3>Yang dibutuhkan</h3>
        <ul>
          <li>Server Linux yang bisa di-SSH (ikuti bagian 2 sampai 4), dengan <b>Docker dan Docker Compose</b> terpasang.</li>
          <li>Pengguna SSH-nya boleh memakai Docker (anggota grup <code>docker</code>): <code>sudo usermod -aG docker aiops</code>, lalu login ulang.</li>
          <li>Server itu bisa menarik image dari internet, atau dari registry Anda bila image privat (login registry di server dilakukan manual).</li>
          <li>Port yang dipublikasikan harus bisa dijangkau dari aplikasi. Alamat privat (LAN) paling mudah.</li>
        </ul>
        <h3>Langkah</h3>
        <ol>
          <li>Di menu <b>Server</b>, ubah server uji Anda dan centang <b>Server playground</b>. Server tanpa tanda ini tidak bisa dipasangi.</li>
          <li>Buka <b>Playground</b>, tekan <b>Susunan baru</b>. Pilih server, beri nama, lalu pilih contoh atau tempel <code>docker-compose.yml</code> Anda. Aplikasi langsung menganalisis dan menunjukkan layanan, port, dan masalah.</li>
          <li>Tekan <b>Pasang</b>. Aplikasi menampilkan ringkasan (image yang ditarik, port yang dibuka) untuk Anda setujui. Setelah itu server menarik image, menjalankan susunan, dan menunggu semua layanan sehat. Statusnya berubah menjadi <b>Berjalan</b>.</li>
          <li>Tekan <b>Uji beban</b> pada susunan yang berjalan. Formulir uji beban terbuka dengan alamat target sudah terisi. Atur tahapnya, lalu setujui seperti biasa.</li>
          <li>Bandingkan hasilnya antar susunan. Misalnya pasang "tanpa Redis", ukur, copot, lalu pasang "dengan Redis" dan ukur lagi.</li>
          <li>Selesai: tekan <b>Copot</b>. Kontainer, jaringan, dan volume dihapus, dan berkas di server dibersihkan.</li>
        </ol>
        <h3>Aturan Compose yang berlaku</h3>
        <ul>
          <li>Wajib memakai <code>image</code> yang sudah jadi. <code>build</code> tidak didukung karena kode sumber tidak ada di server.</li>
          <li>Diblokir demi keamanan: <code>privileged</code>, <code>network_mode: host</code>, <code>pid/ipc: host</code>, <code>cap_add</code>, <code>devices</code>, <code>container_name</code>, <code>env_file</code>, volume yang menunjuk folder di luar proyek (termasuk <code>docker.sock</code>), dan port 22, 2375, 2376.</li>
          <li>Volume bernama dan path relatif (<code>./data</code>) boleh.</li>
          <li>Beri <code>healthcheck</code> pada layanan supaya status "siap" benar-benar berarti siap. Tanpa itu, siap hanya berarti kontainer berjalan.</li>
          <li>Pakai versi image yang tetap (<code>postgres:17</code>, bukan <code>latest</code>) agar hasil uji bisa dibandingkan.</li>
        </ul>
        <Note>Tahap ini belum membangun image dari kode sumber dan belum mengirim image dari komputer Anda. Image harus sudah ada di registry. Susunan hanya bisa diubah bila sudah dicopot, dan yang gagal perlu dicopot dulu sebelum diubah.</Note>
      </>
    )
  },
  {
    id: 'masalah', title: 'Bila ada masalah',
    body: (
      <>
        <ul>
          <li><b>Diminta password atau "Permission denied (publickey)":</b> kunci publik belum ada di <code>~/.ssh/authorized_keys</code> pengguna itu, atau salah baris (harus satu baris utuh). Izin: folder <code>.ssh</code> harus 700 dan <code>authorized_keys</code> harus 600. Pastikan pengguna yang Anda isi di aplikasi sama dengan pemilik <code>authorized_keys</code>. <b>Cara memastikan kunci benar-benar terpasang:</b> pesan galat di aplikasi menyebut sidik jari kunci yang ditawarkan (<code>SHA256:...</code>); di server jalankan <code>ssh-keygen -lf ~/.ssh/authorized_keys</code> sebagai pengguna itu, dan sidik jari yang sama harus ada di daftar. Bila tidak ada, kunci belum terpasang di berkas yang benar atau yang terpasang kunci lama (tiap menekan Simpan dengan Buat kunci otomatis membuat kunci baru). Bila ada tetapi tetap ditolak, penyebabnya izin berkas atau konfigurasi sshd: lihat <code>sudo journalctl -u ssh -n 30 --no-pager</code>.</li>
          <li><b>"Kunci SSH wajib" saat menyimpan:</b> tekan Buat kunci otomatis, pilih berkas kunci, atau tempel kunci privat. Password tidak didukung.</li>
          <li><b>Kunci publik hilang dari layar:</b> bila kuncinya dibuat aplikasi, tombol <b>Kunci publik</b> di baris server menampilkannya lagi. Bila kuncinya Anda tempel atau pilih dari berkas, ambil dari berkas <code>.pub</code> Anda.</li>
          <li><b>"Kunci privat tidak valid":</b> tempel seluruh isi berkas, termasuk baris BEGIN dan END, tanpa spasi tambahan.</li>
          <li><b>Waktu habis atau tidak terjangkau:</b> port SSH tidak terjangkau dari aplikasi (firewall, alamat salah, server mati, atau alamat hanya ada di VPN komputer Anda).</li>
          <li><b>Host key berubah:</b> server dipasang ulang atau ada pihak lain di tengah. Pastikan penyebabnya sebelum menghapus catatan di <code>known_hosts</code> milik aplikasi.</li>
          <li><b>Agen offline:</b> lihat langkah pemeriksaan di bagian 6. Penyebab umum: alamat bukan HTTPS, <code>PUBLIC_URL</code> atau <code>ALLOWED_HOSTS</code> belum diisi, atau jam server meleset.</li>
          <li><b>Fitur AI menolak:</b> isi penyedia dan model di Pengaturan, lalu pilih untuk peran Monitoring atau Setup.</li>
        </ul>
        <p>Belum menemukan jawabannya? Lihat juga <Link to="/server">halaman Server</Link> untuk status koneksi tiap server.</p>
      </>
    )
  }
];
