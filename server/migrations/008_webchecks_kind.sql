-- Jenis cek: 'http' (buka URL) atau 'vercel' (tanya API Vercel soal deploy produksi terakhir). Kredensial penyedia disimpan terenkripsi.
ALTER TABLE web_checks
  ADD COLUMN kind text NOT NULL DEFAULT 'http' CHECK (kind IN ('http','vercel')),
  ADD COLUMN provider_enc text NOT NULL DEFAULT '';
