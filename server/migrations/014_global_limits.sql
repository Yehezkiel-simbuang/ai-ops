-- Standar pemantauan global: menggantikan ambang per server. Satu baris per pemeriksaan yang nilainya diubah pengguna;
-- tanpa baris = pakai bawaan di kode. Berlaku untuk semua server.
DROP TABLE IF EXISTS server_limits;
CREATE TABLE global_limits (
  key text PRIMARY KEY,                 -- 'base:disk' atau 'pack:mysql:MySQL: koneksi terpakai %'
  warn double precision,
  crit double precision,
  confirm integer CHECK (confirm IS NULL OR confirm BETWEEN 1 AND 10),
  updated bigint NOT NULL
);
