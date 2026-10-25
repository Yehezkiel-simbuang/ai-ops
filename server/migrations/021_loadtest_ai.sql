-- Penjelasan AI untuk hasil uji beban dikerjakan di server dan disimpan, supaya tetap selesai walau pengguna pindah halaman atau menutup tab.
-- ai_status: '' (belum pernah diminta) | running | done | failed.
ALTER TABLE load_tests
  ADD COLUMN ai_status text NOT NULL DEFAULT '',
  ADD COLUMN ai_text text NOT NULL DEFAULT '',
  ADD COLUMN ai_model text NOT NULL DEFAULT '',
  ADD COLUMN ai_error text NOT NULL DEFAULT '',
  ADD COLUMN ai_ts bigint;
