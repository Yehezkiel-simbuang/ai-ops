-- Kerentanan yang ditutup patch yang tertunda: hasil pencocokan paket ke OSV.dev (per server) dan CISA KEV (daftar yang sedang dieksploitasi).
ALTER TABLE agents ADD COLUMN patch_vulns jsonb, ADD COLUMN patch_vulns_ts bigint;

-- Cache jawaban OSV per (ekosistem, paket sumber, versi); berlaku 24 jam supaya server yang sama tidak menanyakan hal yang sama berulang.
CREATE TABLE vuln_cache (
  key text PRIMARY KEY,
  vulns jsonb NOT NULL,
  fetched bigint NOT NULL
);

-- Daftar CVE yang sedang dieksploitasi (CISA KEV); diganti seluruhnya tiap kali diperbarui.
CREATE TABLE kev (cve text PRIMARY KEY);
