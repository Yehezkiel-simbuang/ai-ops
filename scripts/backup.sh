#!/usr/bin/env sh
# Cadangan database ke berkas bertanggal. Jalankan dari folder repo: sh scripts/backup.sh [folder-tujuan]
set -eu
dest="${1:-./backups}"; mkdir -p "$dest"; f="$dest/aiops-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T db pg_dump -U aiops -d aiops --no-owner | gzip > "$f"
echo "Cadangan: $f ($(wc -c < "$f") byte). Simpan juga secrets/master_key.txt (tanpa itu data terenkripsi tidak bisa dibuka)."
