-- Tingkat bawaan kejadian dari agen (akun baru, kunci SSH berubah, port baru, dst.) yang bisa diubah dari halaman Standar.
-- Tanpa baris = pakai bawaan di kode (AGENT_EVENTS). Batas angka agen (mis. login SSH gagal) memakai tabel global_limits dengan kunci 'agent:*'.
CREATE TABLE global_events (
  key text PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('info', 'minor', 'major', 'critical')),
  updated bigint NOT NULL
);
