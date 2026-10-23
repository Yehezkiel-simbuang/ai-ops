-- Cek HTTP untuk layanan tanpa SSH (situs, API, aplikasi di Vercel/Supabase/dll): uptime, kecepatan, masa berlaku sertifikat.

CREATE TABLE web_checks (
  id serial PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  url text NOT NULL CHECK (char_length(url) <= 500),
  interval_s integer NOT NULL DEFAULT 60 CHECK (interval_s BETWEEN 30 AND 3600),
  timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  expect_status integer NOT NULL DEFAULT 0 CHECK (expect_status = 0 OR expect_status BETWEEN 100 AND 599),   -- 0 = status 2xx/3xx dianggap sehat
  slow_ms integer NOT NULL DEFAULT 2000 CHECK (slow_ms BETWEEN 100 AND 60000),
  confirm integer NOT NULL DEFAULT 2 CHECK (confirm BETWEEN 1 AND 10),                                       -- berapa pemeriksaan berturut-turut sebelum notifikasi
  enabled boolean NOT NULL DEFAULT true,
  last_status text NOT NULL DEFAULT 'belum' CHECK (last_status IN ('belum','sehat','peringatan','kritis')),
  last_title text NOT NULL DEFAULT '',
  last_detail text NOT NULL DEFAULT '',
  last_code integer,
  last_ms integer,
  last_run bigint,
  cert_expires bigint,
  bad_count integer NOT NULL DEFAULT 0,
  alert_level text NOT NULL DEFAULT '' CHECK (alert_level IN ('','peringatan','kritis')),                   -- peringatan yang sudah diberitahukan
  alert_title text NOT NULL DEFAULT '',
  created bigint NOT NULL
);

CREATE TABLE web_results (
  id bigserial PRIMARY KEY,
  check_id integer NOT NULL REFERENCES web_checks(id) ON DELETE CASCADE,
  ts bigint NOT NULL,
  ok boolean NOT NULL,                 -- terjangkau dan status sesuai harapan (lambat tetap ok)
  code integer,
  ms integer NOT NULL,
  error text NOT NULL DEFAULT ''
);
CREATE INDEX web_results_lookup ON web_results(check_id, ts DESC);
CREATE INDEX web_results_ts ON web_results(ts);
