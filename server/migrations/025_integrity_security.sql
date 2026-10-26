-- Integritas referensi dan pengerasan keamanan.
--   1. Referensi yang tadinya hanya kolom biasa menjadi foreign key. Baris yatim dibersihkan dulu (NULL), lalu FK dipasang.
--      SET NULL (bukan CASCADE): riwayat perintah dan hasil uji tetap terbaca walau server/rekomendasi/susunannya sudah dihapus.
--   2. Rekomendasi insiden wajib punya incident_id; hanya rencana patch yang boleh tanpa insiden.
--   3. Kunci akun setelah banyak kegagalan masuk.
--   4. Anti-replay untuk permintaan agen (tanda tangan yang sama tidak diterima dua kali di jendela waktu).
-- Sengaja TANPA FK: usage.run_id dan notifications.channel_id adalah log historis yang harus bertahan walau induknya dihapus.

UPDATE commands SET server_id = NULL WHERE server_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = commands.server_id);
ALTER TABLE commands ADD CONSTRAINT commands_server_fk FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL;
CREATE INDEX commands_server ON commands(server_id) WHERE server_id IS NOT NULL;

UPDATE agent_commands SET rec_id = NULL WHERE rec_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recommendations r WHERE r.id = agent_commands.rec_id);
ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_rec_fk FOREIGN KEY (rec_id) REFERENCES recommendations(id) ON DELETE SET NULL;
CREATE INDEX agent_commands_rec ON agent_commands(rec_id) WHERE rec_id IS NOT NULL;

UPDATE load_tests SET playground_id = NULL WHERE playground_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM playground_deploys p WHERE p.id = load_tests.playground_id);
ALTER TABLE load_tests ADD CONSTRAINT load_tests_playground_fk FOREIGN KEY (playground_id) REFERENCES playground_deploys(id) ON DELETE SET NULL;
CREATE INDEX load_tests_playground ON load_tests(playground_id) WHERE playground_id IS NOT NULL;

ALTER TABLE recommendations ADD CONSTRAINT recommendations_kind_incident_check CHECK (kind = 'patch' OR incident_id IS NOT NULL);

ALTER TABLE users ADD COLUMN failed_logins integer NOT NULL DEFAULT 0, ADD COLUMN locked_until bigint;

-- UNLOGGED: sengaja tidak ditulis ke WAL (data sementara, hanya berlaku beberapa menit); kosong setelah crash tidak berbahaya karena jendela waktu tetap membatasi replay lama.
CREATE UNLOGGED TABLE agent_nonces (
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  sig text NOT NULL,
  seen bigint NOT NULL,
  PRIMARY KEY (server_id, sig)
);
CREATE INDEX agent_nonces_seen ON agent_nonces(seen);
