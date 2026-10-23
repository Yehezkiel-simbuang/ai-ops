-- Wajib ganti password: dipakai untuk admin awal yang masuk dengan password bawaan, dan setelah pemulihan password.
ALTER TABLE users ADD COLUMN must_change boolean NOT NULL DEFAULT false;
