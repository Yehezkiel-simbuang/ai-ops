-- Dokumentasi server: profil, alamat, layanan, dependensi, vault kredensial (terenkripsi, berversi), dan jadwal pemeliharaan.

ALTER TABLE servers
  ADD COLUMN purpose text NOT NULL DEFAULT '',
  ADD COLUMN environment text NOT NULL DEFAULT 'prod' CHECK (environment IN ('prod','staging','dev','lab','other')),
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN location text NOT NULL DEFAULT '',
  ADD COLUMN owner text NOT NULL DEFAULT '',
  ADD COLUMN runbook text NOT NULL DEFAULT '',
  ADD COLUMN facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN facts_at bigint,
  ADD COLUMN doc_updated bigint;

CREATE TABLE server_addresses (
  id bigserial PRIMARY KEY, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, label text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'ip' CHECK (kind IN ('ip','hostname','url','mac','other')), address text NOT NULL, is_primary boolean NOT NULL DEFAULT false, notes text NOT NULL DEFAULT ''
);
CREATE INDEX server_addresses_server ON server_addresses(server_id);
CREATE INDEX server_addresses_addr ON server_addresses(lower(address));

CREATE TABLE server_services (
  id bigserial PRIMARY KEY, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name text NOT NULL, port integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  protocol text NOT NULL DEFAULT 'tcp', url text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT ''
);
CREATE INDEX server_services_server ON server_services(server_id);

CREATE TABLE server_dependencies (
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, depends_on bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, note text NOT NULL DEFAULT '',
  PRIMARY KEY (server_id, depends_on), CHECK (server_id <> depends_on)
);

-- vault: rahasia dienkripsi AES-256-GCM (MASTER_KEY); tidak pernah dikirim ke UI kecuali lewat "ungkap" dengan konfirmasi password
CREATE TABLE credentials (
  id bigserial PRIMARY KEY, server_id bigint REFERENCES servers(id) ON DELETE CASCADE, label text NOT NULL,
  kind text NOT NULL DEFAULT 'password' CHECK (kind IN ('ssh','password','database','web','api_key','ssh_key','other')),
  username text NOT NULL DEFAULT '', secret_enc text NOT NULL DEFAULT '', url text NOT NULL DEFAULT '', port integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535), notes text NOT NULL DEFAULT '',
  rotate_every_days integer CHECK (rotate_every_days IS NULL OR rotate_every_days BETWEEN 1 AND 3650), rotated_at bigint NOT NULL, expires_at bigint,
  created bigint NOT NULL, updated bigint NOT NULL, last_revealed bigint
);
CREATE INDEX credentials_server ON credentials(server_id);
CREATE TABLE credential_versions (id bigserial PRIMARY KEY, credential_id bigint NOT NULL REFERENCES credentials(id) ON DELETE CASCADE, secret_enc text NOT NULL, changed_at bigint NOT NULL, changed_by text NOT NULL DEFAULT '');
CREATE INDEX credential_versions_cred ON credential_versions(credential_id, id DESC);

CREATE TABLE maintenance_tasks (
  id bigserial PRIMARY KEY, server_id bigint REFERENCES servers(id) ON DELETE CASCADE, title text NOT NULL, description text NOT NULL DEFAULT '', category text NOT NULL DEFAULT 'umum',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('rendah','normal','tinggi')), every_days integer CHECK (every_days IS NULL OR every_days BETWEEN 1 AND 3650),
  due_at bigint NOT NULL, last_done bigint, last_done_by text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true, created bigint NOT NULL, last_notified_day text NOT NULL DEFAULT ''
);
CREATE INDEX maintenance_due ON maintenance_tasks(enabled, due_at);
CREATE TABLE maintenance_log (id bigserial PRIMARY KEY, task_id bigint REFERENCES maintenance_tasks(id) ON DELETE SET NULL, server_id bigint REFERENCES servers(id) ON DELETE CASCADE, title text NOT NULL, done_at bigint NOT NULL, done_by text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '');
CREATE INDEX maintenance_log_server ON maintenance_log(server_id, done_at DESC);
