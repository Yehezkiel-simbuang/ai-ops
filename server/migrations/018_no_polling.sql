-- Pemantauan berkala lewat SSH dihapus: kondisi server datang dari agen (mendorong kejadian) dan dari pemeriksaan manual ("Periksa sekarang").
-- SSH tetap dipakai untuk setup, eksekusi perbaikan yang disetujui, dan pemeriksaan manual.
ALTER TABLE servers DROP COLUMN monitor_on, DROP COLUMN monitor_every;
