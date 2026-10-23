-- Ambang pemeriksaan dasar per server (CPU, memori, swap, disk, I/O). Tanpa baris = pakai bawaan di kode.
CREATE TABLE server_limits (
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  key text NOT NULL,
  warn double precision,
  crit double precision,
  PRIMARY KEY (server_id, key)
);
