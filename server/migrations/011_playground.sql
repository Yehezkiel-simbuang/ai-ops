-- Playground: server khusus uji tempat susunan Docker Compose dipasang, diuji beban, lalu dicopot.

ALTER TABLE servers ADD COLUMN playground boolean NOT NULL DEFAULT false;

CREATE TABLE playground_deploys (
  id serial PRIMARY KEY,
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  compose_enc text NOT NULL,                  -- isi docker-compose.yml, terenkripsi (bisa memuat password uji)
  health_path text NOT NULL DEFAULT '',       -- mis. /health; kosong = hanya cek kontainer berjalan
  target_port integer NOT NULL DEFAULT 0,     -- port yang dipublikasikan sebagai target uji beban; 0 = yang pertama
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','deploying','running','failed','stopping','stopped')),
  target text NOT NULL DEFAULT '',            -- http://host:port, terisi setelah berjalan
  detail text NOT NULL DEFAULT '',            -- ringkasan hasil atau galat terakhir
  log text NOT NULL DEFAULT '',               -- keluaran perintah terakhir (dipotong)
  created bigint NOT NULL,
  updated bigint NOT NULL,
  deployed bigint,
  UNIQUE (server_id, name)
);
CREATE INDEX playground_server ON playground_deploys(server_id);
