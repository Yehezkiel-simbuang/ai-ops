-- Analisis bottleneck: uji beban dari susunan Playground mencatat pemakaian tiap kontainer (dan server) selama uji berjalan,
-- supaya terlihat komponen mana yang jenuh. Tanpa susunan Playground, analisis hanya berdasar kurva hasil.
ALTER TABLE load_tests ADD COLUMN playground_id bigint;

CREATE TABLE load_samples (
  id bigserial PRIMARY KEY,
  test_id integer NOT NULL REFERENCES load_tests(id) ON DELETE CASCADE,
  ts bigint NOT NULL,
  service text NOT NULL,            -- nama layanan compose, atau '_host' untuk server uji secara keseluruhan
  cpu real NOT NULL,                -- layanan: persen CPU docker (100 = satu core penuh); _host: load average 1 menit
  mem_mb real NOT NULL,
  mem_limit_mb real NOT NULL DEFAULT 0,   -- batas memori (layanan) atau total memori (_host); 0 = tidak diketahui
  cores real NOT NULL DEFAULT 0     -- hanya _host: jumlah core
);
CREATE INDEX load_samples_test ON load_samples(test_id, ts);
