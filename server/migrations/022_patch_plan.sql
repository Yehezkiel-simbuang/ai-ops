-- Rencana patch memakai tabel rekomendasi yang sama dengan perbaikan insiden (persetujuan per langkah, eksekusi lewat SSH atau agen).
-- Bedanya: tidak terikat insiden (incident_id boleh kosong), punya judul, dan menyimpan ringkasan dampak di meta.
ALTER TABLE recommendations ALTER COLUMN incident_id DROP NOT NULL;
ALTER TABLE recommendations
  ADD COLUMN kind text NOT NULL DEFAULT 'incident' CHECK (kind IN ('incident', 'patch')),
  ADD COLUMN title text NOT NULL DEFAULT '',
  ADD COLUMN meta jsonb;
CREATE INDEX recommendations_patch ON recommendations(server_id, id DESC) WHERE kind = 'patch';
