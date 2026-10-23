-- Empat tingkat keparahan menggantikan dua (kritis, peringatan): info, minor, major, critical.
--   critical : tindak sekarang       major : tindak hari ini      minor : lihat kalau sempat      info : hanya jejak, tanpa tindakan
-- Data lama dipetakan: kritis -> critical, peringatan -> major.

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_level_check;
UPDATE alerts SET level = CASE level WHEN 'kritis' THEN 'critical' WHEN 'peringatan' THEN 'major' ELSE level END;
ALTER TABLE alerts ADD CONSTRAINT alerts_level_check CHECK (level IN ('info', 'minor', 'major', 'critical'));

-- kanal: min_level = tingkat terendah yang dikirim SEGERA. Bawaan major (minor masuk ringkasan harian, info hanya tercatat).
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_min_level_check;
UPDATE channels SET min_level = CASE min_level WHEN 'kritis' THEN 'critical' WHEN 'peringatan' THEN 'major' WHEN 'semua' THEN 'minor' ELSE min_level END;
ALTER TABLE channels ALTER COLUMN min_level SET DEFAULT 'major';
ALTER TABLE channels ADD CONSTRAINT channels_min_level_check CHECK (min_level IN ('info', 'minor', 'major', 'critical'));

-- cek HTTP memakai kosakata yang sama
ALTER TABLE web_checks DROP CONSTRAINT IF EXISTS web_checks_last_status_check;
ALTER TABLE web_checks DROP CONSTRAINT IF EXISTS web_checks_alert_level_check;
UPDATE web_checks SET last_status = CASE last_status WHEN 'kritis' THEN 'critical' WHEN 'peringatan' THEN 'major' ELSE last_status END,
                      alert_level = CASE alert_level WHEN 'kritis' THEN 'critical' WHEN 'peringatan' THEN 'major' ELSE alert_level END;
ALTER TABLE web_checks ADD CONSTRAINT web_checks_last_status_check CHECK (last_status IN ('belum', 'sehat', 'minor', 'major', 'critical'));
ALTER TABLE web_checks ADD CONSTRAINT web_checks_alert_level_check CHECK (alert_level IN ('', 'minor', 'major', 'critical'));

-- Standar global: batas minor (opsional). warn tetap batas MAJOR dan crit batas CRITICAL, jadi kolom lama tidak berubah arti.
ALTER TABLE global_limits ADD COLUMN minor double precision;

-- peringatan yang ditunda karena jam tenang (belum diberitahukan); dikirim sebagai ringkasan saat jam tenang berakhir
ALTER TABLE alerts ADD COLUMN deferred boolean NOT NULL DEFAULT false;
