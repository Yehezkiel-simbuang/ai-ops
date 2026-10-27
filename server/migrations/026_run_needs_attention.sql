-- Status baru: agen berhenti karena perintah perubahan gagal dan menunggu pengguna memeriksa.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN ('draft','running','waiting_approval','needs_attention','done','failed','stopped','interrupted'));
