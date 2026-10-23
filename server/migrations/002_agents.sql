-- Agen di server (mendorong kejadian kritis), insiden, rekomendasi perbaikan, dan antrean perintah untuk agen.

ALTER TABLE servers ADD COLUMN exec_via text NOT NULL DEFAULT 'auto' CHECK (exec_via IN ('auto','ssh','agent'));
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_source_check;

CREATE TABLE agents (
  server_id bigint PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  key_id text NOT NULL UNIQUE, secret_enc text NOT NULL, created bigint NOT NULL, rotated bigint,
  last_seen bigint, version text NOT NULL DEFAULT '', hostname text NOT NULL DEFAULT '', exec_enabled boolean NOT NULL DEFAULT false,
  open_keys jsonb NOT NULL DEFAULT '[]'::jsonb, online boolean NOT NULL DEFAULT false, last_ip text NOT NULL DEFAULT ''
);

-- idempotensi: agen memberi id unik tiap kejadian, jadi pengiriman ulang (retry/spool) tidak menggandakan insiden
CREATE TABLE agent_events (
  id text NOT NULL, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, ts bigint NOT NULL, type text NOT NULL, key text NOT NULL, received bigint NOT NULL,
  PRIMARY KEY (server_id, id)
);
CREATE INDEX agent_events_received ON agent_events(received);

CREATE TABLE incidents (
  id bigserial PRIMARY KEY, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, key text NOT NULL, kind text NOT NULL, title text NOT NULL,
  severity text NOT NULL DEFAULT 'critical', detail text NOT NULL DEFAULT '', value double precision, opened bigint NOT NULL, last_event bigint NOT NULL, resolved_at bigint,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), diag jsonb NOT NULL DEFAULT '[]'::jsonb, event_count integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX incidents_open_unique ON incidents(server_id, key) WHERE status = 'open';
CREATE INDEX incidents_status ON incidents(status, opened DESC);

CREATE TABLE recommendations (
  id bigserial PRIMARY KEY, incident_id bigint NOT NULL REFERENCES incidents(id) ON DELETE CASCADE, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created bigint NOT NULL, updated bigint NOT NULL, source text NOT NULL DEFAULT 'playbook' CHECK (source IN ('playbook','llm')),
  diagnosis text NOT NULL DEFAULT '', verify text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','executing','done','failed','rejected','superseded')),
  approved_by text, approved_at bigint, summary text NOT NULL DEFAULT '', verify_out text NOT NULL DEFAULT '', resolved_after boolean
);
CREATE INDEX recommendations_incident ON recommendations(incident_id, id DESC);

CREATE TABLE rec_steps (
  id bigserial PRIMARY KEY, rec_id bigint NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE, n integer NOT NULL, title text NOT NULL, command text NOT NULL,
  class text NOT NULL CHECK (class IN ('read','change','blocked')), risk text NOT NULL DEFAULT 'rendah' CHECK (risk IN ('rendah','sedang','tinggi')), rationale text NOT NULL DEFAULT '', rollback text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','running','done','failed','skipped','blocked')),
  exit_code integer, stdout text NOT NULL DEFAULT '', stderr text NOT NULL DEFAULT '', started bigint, finished bigint, via text NOT NULL DEFAULT '', UNIQUE (rec_id, n)
);

CREATE TABLE agent_commands (
  id text PRIMARY KEY, server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE, rec_id bigint, step_n integer, command text NOT NULL, timeout_s integer NOT NULL, expires bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','done','rejected','expired','cancelled')), created bigint NOT NULL, sent_at bigint, finished bigint,
  exit_code integer, stdout text NOT NULL DEFAULT '', stderr text NOT NULL DEFAULT '', rejected text NOT NULL DEFAULT ''
);
CREATE INDEX agent_commands_pending ON agent_commands(server_id, status) WHERE status IN ('queued','sent');
