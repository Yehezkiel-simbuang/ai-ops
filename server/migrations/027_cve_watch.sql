-- CVE yang dipantau: aplikasi mengecek tracker Ubuntu berkala dan mengabari saat status perbaikannya berubah (mis. perbaikan dirilis).
-- snapshot = status per "paket@rilis" pada pengecekan terakhir; pkgs = paket yang relevan bagi server pada saat dipantau (kosong = semua paket).
CREATE TABLE cve_watch (
  cve text PRIMARY KEY CHECK (cve ~ '^CVE-[0-9]{4}-[0-9]{4,7}$'),
  created bigint NOT NULL,
  last_check bigint,
  snapshot jsonb NOT NULL DEFAULT '{}',
  pkgs jsonb NOT NULL DEFAULT '[]',
  notified bigint
);
