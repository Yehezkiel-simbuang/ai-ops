-- Layanan standar buatan pengguna: melengkapi paket bawaan di kode (PACKS). Satu baris per layanan; pemeriksaannya disimpan sebagai JSON.
-- Ambang tiap pemeriksaannya tetap diatur lewat global_limits seperti paket bawaan.
CREATE TABLE custom_packs (
  id text PRIMARY KEY,                  -- 'custom-nginx-exporter'
  unit text NOT NULL UNIQUE,            -- nama unit systemd yang dikenali sebagai layanan ini
  label text NOT NULL,
  checks jsonb NOT NULL DEFAULT '[]',
  created bigint NOT NULL
);
