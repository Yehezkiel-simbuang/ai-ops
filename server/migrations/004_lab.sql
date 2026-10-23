-- Lab arsitektur: skenario eksperimen yang disimpan (komponen yang ditambahkan + beban), per proyek.

CREATE TABLE lab_designs (
  id serial PRIMARY KEY,
  project text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  actions jsonb NOT NULL DEFAULT '[]',
  load jsonb NOT NULL,
  faults boolean NOT NULL DEFAULT true,
  seconds integer NOT NULL DEFAULT 120 CHECK (seconds BETWEEN 30 AND 300),
  created bigint NOT NULL,
  updated bigint NOT NULL
);
CREATE INDEX lab_designs_project ON lab_designs(project, updated DESC);
