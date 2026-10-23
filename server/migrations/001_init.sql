-- Skema awal AI Ops. Waktu disimpan sebagai epoch milidetik (BIGINT) agar sederhana, terindeks, dan bebas jebakan zona waktu.

CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);

CREATE TABLE users (
  id bigserial PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL, created_at bigint NOT NULL, last_login bigint
);
CREATE TABLE sessions (
  id text PRIMARY KEY,                      -- sha256 dari token sesi (token asli hanya ada di cookie)
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at bigint NOT NULL, expires_at bigint NOT NULL, last_seen bigint NOT NULL, ip text NOT NULL DEFAULT '', ua text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_exp ON sessions(expires_at);

CREATE TABLE providers (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'), label text NOT NULL, type text NOT NULL CHECK (type IN ('anthropic','openai','google')),
  base_url text NOT NULL, keyless boolean NOT NULL DEFAULT false, api_key_enc text NOT NULL DEFAULT ''
);
CREATE TABLE roles (role text PRIMARY KEY CHECK (role IN ('setup','monitor')), provider text NOT NULL REFERENCES providers(id) ON DELETE CASCADE, model text NOT NULL);
CREATE TABLE prices (key text PRIMARY KEY, in_price double precision NOT NULL DEFAULT 0, out_price double precision NOT NULL DEFAULT 0);
CREATE TABLE usage (
  id bigserial PRIMARY KEY, ts bigint NOT NULL, role text NOT NULL DEFAULT '-', provider text NOT NULL, model text NOT NULL, input integer NOT NULL DEFAULT 0, output integer NOT NULL DEFAULT 0, run_id text
);
CREATE INDEX usage_ts ON usage(ts);
CREATE INDEX usage_run ON usage(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE servers (
  id bigserial PRIMARY KEY, name text NOT NULL UNIQUE, host text NOT NULL, port integer NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535), username text NOT NULL,
  key_path text NOT NULL DEFAULT '', ssh_key_enc text NOT NULL DEFAULT '', use_sudo boolean NOT NULL DEFAULT false, services text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  monitor_on boolean NOT NULL DEFAULT false, monitor_every integer NOT NULL DEFAULT 60 CHECK (monitor_every BETWEEN 15 AND 86400), os_info text NOT NULL DEFAULT '',
  last_seen bigint, last_status text NOT NULL DEFAULT 'belum', created bigint NOT NULL
);

CREATE TABLE runs (
  id text PRIMARY KEY, name text NOT NULL, server_id bigint REFERENCES servers(id) ON DELETE SET NULL, goal text NOT NULL DEFAULT '', dir text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','waiting_approval','done','failed','stopped','interrupted')),
  summary text NOT NULL DEFAULT '', turns integer NOT NULL DEFAULT 0, max_turns integer NOT NULL DEFAULT 30, token_budget integer NOT NULL DEFAULT 200000, created bigint NOT NULL, updated bigint NOT NULL
);
CREATE INDEX runs_created ON runs(created DESC);
CREATE TABLE steps (
  id bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE, n integer NOT NULL, title text NOT NULL, detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')), note text NOT NULL DEFAULT '', UNIQUE (run_id, n)
);
CREATE TABLE commands (
  id bigserial PRIMARY KEY, run_id text REFERENCES runs(id) ON DELETE CASCADE, server_id bigint, ts bigint NOT NULL, command text NOT NULL, purpose text NOT NULL DEFAULT '',
  class text NOT NULL CHECK (class IN ('read','change','blocked')), status text NOT NULL CHECK (status IN ('approved','pending_approval','rejected','running','done','failed','blocked')),
  exit_code integer, stdout text NOT NULL DEFAULT '', stderr text NOT NULL DEFAULT '', started bigint, finished bigint, decided_by text, reason text NOT NULL DEFAULT ''
);
CREATE INDEX commands_run ON commands(run_id, id);
CREATE INDEX commands_pending ON commands(status) WHERE status = 'pending_approval';
CREATE TABLE messages (id bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE, ts bigint NOT NULL, role text NOT NULL CHECK (role IN ('user','assistant')), content text NOT NULL);
CREATE INDEX messages_run ON messages(run_id, id);

CREATE TABLE metrics (id bigserial PRIMARY KEY, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, ts bigint NOT NULL, name text NOT NULL, value double precision NOT NULL);
CREATE INDEX metrics_lookup ON metrics(server_id, name, ts);
CREATE INDEX metrics_ts ON metrics(ts);

CREATE TABLE alerts (
  id bigserial PRIMARY KEY, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, ts bigint NOT NULL, level text NOT NULL CHECK (level IN ('kritis','peringatan')),
  key text NOT NULL, title text NOT NULL, detail text NOT NULL DEFAULT '', resolved boolean NOT NULL DEFAULT false, acked boolean NOT NULL DEFAULT false, notified_ts bigint, source text NOT NULL DEFAULT 'resource'
);
-- satu peringatan terbuka per (server, kunci): mencegah duplikat walau ada pemeriksaan bersamaan
CREATE UNIQUE INDEX alerts_open_unique ON alerts(server_id, key) WHERE NOT resolved;
CREATE INDEX alerts_server ON alerts(server_id, resolved, ts DESC);

CREATE TABLE reports (id bigserial PRIMARY KEY, server_id bigint REFERENCES servers(id) ON DELETE CASCADE, ts bigint NOT NULL, text text NOT NULL);
CREATE INDEX reports_server ON reports(server_id, ts DESC);

CREATE TABLE checks (
  id bigserial PRIMARY KEY, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name text NOT NULL, type text NOT NULL, params jsonb NOT NULL DEFAULT '{}'::jsonb,
  warn double precision, crit double precision, dir text NOT NULL DEFAULT 'gt' CHECK (dir IN ('gt','lt')), delta boolean NOT NULL DEFAULT false, confirm integer NOT NULL DEFAULT 2 CHECK (confirm BETWEEN 1 AND 10),
  enabled boolean NOT NULL DEFAULT true, pack text NOT NULL DEFAULT '', last_status text NOT NULL DEFAULT 'belum', last_value double precision, last_raw double precision, last_detail text NOT NULL DEFAULT '',
  last_run bigint, fail_count integer NOT NULL DEFAULT 0, created bigint NOT NULL, UNIQUE (server_id, name)
);
CREATE INDEX checks_srv ON checks(server_id);

CREATE TABLE channels (
  id bigserial PRIMARY KEY, type text NOT NULL CHECK (type IN ('telegram','ntfy','webhook','email')), name text NOT NULL, config_enc text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  min_level text NOT NULL DEFAULT 'kritis' CHECK (min_level IN ('kritis','peringatan','semua')), created bigint NOT NULL
);
CREATE TABLE notifications (id bigserial PRIMARY KEY, ts bigint NOT NULL, channel_id bigint, channel_name text NOT NULL DEFAULT '', kind text NOT NULL, title text NOT NULL, ok boolean NOT NULL, error text NOT NULL DEFAULT '');
CREATE INDEX notifications_ts ON notifications(ts DESC);

CREATE TABLE audit (id bigserial PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL, action text NOT NULL, detail text NOT NULL DEFAULT '');
CREATE INDEX audit_ts ON audit(ts DESC);
