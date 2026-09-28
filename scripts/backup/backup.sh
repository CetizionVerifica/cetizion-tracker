#!/usr/bin/env bash
# A second, independent backup copy (#33), for a machine that is not the
# server or a bucket with other credentials. Dokploy's own scheduled
# backups are the first copy.
#
#   DATABASE_URL=postgres://... BACKUP_DIR=/backups ./scripts/backup/backup.sh
#
# Optional:
#   BACKUP_GPG_PASSPHRASE   encrypt the dump (gpg symmetric, AES256)
#   BACKUP_S3_URI           s3://bucket/prefix to upload to (needs the aws CLI;
#                           AWS_ENDPOINT_URL for Backblaze B2 or Cloudflare R2)
#   BACKUP_KEEP_DAYS        local copies older than this are removed (default 30)
#   REPORT_DATABASE_URL     where to record the run (default DATABASE_URL)
#
# Exits non-zero on any failure, after recording it, so a scheduler can alert.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
REPORT_URL="${REPORT_DATABASE_URL:-$DATABASE_URL}"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/cetizion-$stamp.dump"

record() { # ok size location error
  psql "$REPORT_URL" -v ON_ERROR_STOP=1 -q \
    -v ok="$1" -v size="$2" -v loc="$3" -v err="$4" -v started="$started" <<'SQL' || echo "warning: could not record the run" >&2
INSERT INTO backup_runs (kind, ok, started_at, size_bytes, location, error)
VALUES ('backup', :'ok'::boolean, :'started'::timestamptz, NULLIF(:'size', '')::bigint, NULLIF(:'loc', ''), NULLIF(:'err', ''));
SQL
}
fail() { echo "backup failed: $1" >&2; record false "" "" "$1"; exit 1; }
trap 'fail "unexpected error on line $LINENO"' ERR

pg_dump --format=custom --no-owner --no-privileges --file="$file" "$DATABASE_URL" || fail "pg_dump failed"
# A dump that cannot be listed is not a backup.
pg_restore --list "$file" > /dev/null || fail "the dump cannot be read back"

if [[ -n "${BACKUP_GPG_PASSPHRASE:-}" ]]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_GPG_PASSPHRASE" --symmetric --cipher-algo AES256 -o "$file.gpg" "$file"
  rm -f "$file"
  file="$file.gpg"
fi

size="$(wc -c < "$file" | tr -d ' ')"
location="$file"
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  aws s3 cp "$file" "${BACKUP_S3_URI%/}/$(basename "$file")" --only-show-errors || fail "upload to $BACKUP_S3_URI failed"
  location="${BACKUP_S3_URI%/}/$(basename "$file")"
fi

find "$BACKUP_DIR" -name 'cetizion-*.dump*' -mtime "+$KEEP_DAYS" -delete || true
trap - ERR
record true "$size" "$location" ""
echo "backup ok: $location ($size bytes)"
