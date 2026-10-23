-- Uji beban: definisi uji (target, skenario request, tahap pengguna, kriteria lulus), status, dan hasil per tahap yang dilaporkan runner.

CREATE TABLE load_tests (
  id serial PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  target text NOT NULL,                                  -- origin saja: skema + host + port
  allow_public boolean NOT NULL DEFAULT false,           -- true hanya bila host ada di LOADTEST_ALLOWED_HOSTS
  scenario jsonb NOT NULL,                               -- { requests: [...], thinkSeconds }
  headers_enc text NOT NULL DEFAULT '',                  -- header (mis. Authorization staging), terenkripsi; tidak pernah dikembalikan API
  stages jsonb NOT NULL,                                 -- [{ vus, seconds }]
  criteria jsonb NOT NULL,                               -- { p95Ms, errPct }
  scrape jsonb NOT NULL DEFAULT '[]',                    -- [{ label, url }] metrik server uji (teks Prometheus atau JSON) yang dibaca selama tahap
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','running','done','failed','cancelled')),
  cancel_requested boolean NOT NULL DEFAULT false,
  error text NOT NULL DEFAULT '',
  runner jsonb,                                          -- info runner (versi k6, jumlah CPU)
  approved_by text NOT NULL DEFAULT '',
  created bigint NOT NULL,
  started bigint,
  finished bigint,
  heartbeat bigint
);
CREATE INDEX load_tests_status ON load_tests(status, id);

CREATE TABLE load_stages (
  id serial PRIMARY KEY,
  test_id integer NOT NULL REFERENCES load_tests(id) ON DELETE CASCADE,
  idx integer NOT NULL,
  vus integer NOT NULL,
  seconds integer NOT NULL,
  reqs integer NOT NULL DEFAULT 0,
  rps real NOT NULL DEFAULT 0,
  p50 real NOT NULL DEFAULT 0,                           -- milidetik
  p95 real NOT NULL DEFAULT 0,
  p99 real NOT NULL DEFAULT 0,
  err_pct real NOT NULL DEFAULT 0,
  gen_cpu real NOT NULL DEFAULT 0,                       -- pemakaian CPU pembangkit beban (0..1): di atas 0,7 hasil tidak murni
  valid boolean NOT NULL DEFAULT true,
  scraped jsonb NOT NULL DEFAULT '{}',                   -- { label: { avg, max, last } }
  started bigint NOT NULL,
  ended bigint NOT NULL,
  UNIQUE (test_id, idx)
);
