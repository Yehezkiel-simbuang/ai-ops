-- Kunci publik server (bukan rahasia): ditampilkan lagi di UI supaya mudah dipasang di server. Terisi bila kunci dibuat oleh aplikasi.
ALTER TABLE servers ADD COLUMN ssh_pub text NOT NULL DEFAULT '';
