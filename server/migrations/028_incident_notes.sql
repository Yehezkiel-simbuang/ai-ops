-- Buku solusi: catatan penyebab dan penyelesaian pada insiden, agar masalah serupa berikutnya tinggal mencontek.
-- closed_by/closed_reason terisi bila insiden ditutup manual (bukan oleh laporan pulih dari agen).
ALTER TABLE incidents
  ADD COLUMN cause text NOT NULL DEFAULT '',
  ADD COLUMN solution text NOT NULL DEFAULT '',
  ADD COLUMN noted_by text,
  ADD COLUMN noted_at bigint,
  ADD COLUMN closed_by text,
  ADD COLUMN closed_reason text;
CREATE INDEX incidents_kind_resolved ON incidents(kind, resolved_at DESC) WHERE status = 'resolved';
