-- Lab arsitektur: skenario kegagalan (matikan node X pada detik T) ikut tersimpan di skenario.
ALTER TABLE lab_designs ADD COLUMN failure jsonb;
