-- Fakta pembaruan sistem yang dilaporkan agen (jumlah pembaruan, reboot tertunda, versi OS). Tingkat keparahannya dihitung saat dibaca, menurut halaman Standar.
ALTER TABLE agents ADD COLUMN patch jsonb, ADD COLUMN patch_ts bigint;
