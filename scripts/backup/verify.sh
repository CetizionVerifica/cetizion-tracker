#!/usr/bin/env bash
# The weekly restore check (#33): restore the newest backup into a
# throwaway database, check the main tables have rows and the views build,
# record the result, drop the database. Exits non-zero on failure.
#
#   ADMIN_DATABASE_URL=postgres://user:pass@host:5432/postgres \
#   REPORT_DATABASE_URL=postgres://.../cetizion_tracker \
#   BACKUP_FILE=/backups/cetizion-20260917-020000.dump ./scripts/backup/verify.sh
#
# Instead of BACKUP_FILE: BACKUP_DIR (the newest file in it) or BACKUP_S3_URI
# (the newest object under the prefix; needs the aws CLI). Dokploy's backups
# are .sql.gz files; those are restored with psql. BACKUP_GPG_PASSPHRASE
# decrypts .gpg files. MIN_ROWS sets the smallest acceptable row counts,
# e.g. MIN_ROWS="quotations=50 projects=5" (defaults: at least one row).
set -euo pipefail

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL (a user that may create databases) is required}"
: "${REPORT_DATABASE_URL:?REPORT_DATABASE_URL (where to record the result) is required}"
here="$(cd "$(dirname "$0")" && pwd)"
views="$here/../../server/db/views.sql"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
t0=$(date +%s)
work="$(mktemp -d)"
db="verify_$(date +%s)_$$"
scratch_url="$(printf '%s' "$ADMIN_DATABASE_URL" | sed -E "s#/[^/?]*(\?|$)#/$db\1#")"

record() { # ok detail-json error location
  psql "$REPORT_DATABASE_URL" -q -v ON_ERROR_STOP=1 -v ok="$1" -v detail="$2" -v err="$3" -v loc="$4" -v started="$started" <<'SQL' || echo "warning: could not record the result" >&2
INSERT INTO backup_runs (kind, ok, started_at, location, detail, error)
VALUES ('verify', :'ok'::boolean, :'started'::timestamptz, NULLIF(:'loc', ''), :'detail'::jsonb, NULLIF(:'err', ''));
SQL
}
cleanup() { psql "$ADMIN_DATABASE_URL" -q -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
fail() { echo "restore check FAILED: $1" >&2; record false '{}' "$1" "${source:-}"; exit 1; }

# 1. Find the newest backup.
if [[ -n "${BACKUP_FILE:-}" ]]; then
  source="$BACKUP_FILE"; file="$BACKUP_FILE"
elif [[ -n "${BACKUP_DIR:-}" ]]; then
  file="$(ls -t "$BACKUP_DIR"/* 2>/dev/null | head -1)"; source="$file"
  [[ -n "$file" ]] || fail "no backup files in $BACKUP_DIR"
elif [[ -n "${BACKUP_S3_URI:-}" ]]; then
  key="$(aws s3 ls "${BACKUP_S3_URI%/}/" --recursive | sort | tail -1 | awk '{print $4}')"
  [[ -n "$key" ]] || fail "no backups under $BACKUP_S3_URI"
  bucket="$(printf '%s' "$BACKUP_S3_URI" | sed -E 's#s3://([^/]+).*#\1#')"
  source="s3://$bucket/$key"; file="$work/$(basename "$key")"
  aws s3 cp "$source" "$file" --only-show-errors || fail "download of $source failed"
else
  fail "set BACKUP_FILE, BACKUP_DIR or BACKUP_S3_URI"
fi
age_hours=$(( ( $(date +%s) - $(date -r "$file" +%s 2>/dev/null || date +%s) ) / 3600 ))

# 2. Decrypt if needed.
if [[ "$file" == *.gpg ]]; then
  : "${BACKUP_GPG_PASSPHRASE:?the backup is encrypted; BACKUP_GPG_PASSPHRASE is required}"
  gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_GPG_PASSPHRASE" -o "$work/dump" -d "$file" || fail "decryption failed"
  file="$work/dump"
fi

# 3. Restore into a throwaway database.
psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$db\"" || fail "could not create the scratch database"
if [[ "$file" == *.sql.gz || "$file" == *.gz ]]; then
  gunzip -c "$file" | psql "$scratch_url" -q -v ON_ERROR_STOP=1 > "$work/restore.log" 2>&1 || fail "restore failed: $(tail -3 "$work/restore.log" | tr '\n' ' ')"
elif [[ "$file" == *.sql ]]; then
  psql "$scratch_url" -q -v ON_ERROR_STOP=1 -f "$file" > "$work/restore.log" 2>&1 || fail "restore failed: $(tail -3 "$work/restore.log" | tr '\n' ' ')"
else
  pg_restore --no-owner --no-privileges --exit-on-error -d "$scratch_url" "$file" > "$work/restore.log" 2>&1 || fail "restore failed: $(tail -3 "$work/restore.log" | tr '\n' ' ')"
fi

# 4. Check it: the main tables have rows, and the views build on top.
counts="$(psql "$scratch_url" -At -F= -c "
  SELECT 'companies', count(*) FROM companies UNION ALL SELECT 'quotations', count(*) FROM quotations
  UNION ALL SELECT 'projects', count(*) FROM projects UNION ALL SELECT 'purchase_orders', count(*) FROM purchase_orders
  UNION ALL SELECT 'payment_stages', count(*) FROM payment_stages UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations" | tr -d '')" || fail "the restored database could not be queried"
declare -A min=( [companies]=1 [quotations]=1 [projects]=1 [purchase_orders]=1 [payment_stages]=1 [schema_migrations]=1 )
for pair in ${MIN_ROWS:-}; do min[${pair%%=*}]=${pair#*=}; done
json="{"
for line in $counts; do
  t="${line%%=*}"; n="${line#*=}"; n="${n//[^0-9]/}"
  json+="\"$t\":$n,"
  (( n >= ${min[$t]:-1} )) || fail "$t has $n rows, expected at least ${min[$t]:-1}"
done
psql "$scratch_url" -q -v ON_ERROR_STOP=1 -f "$views" > "$work/views.log" 2>&1 || fail "views do not build on the restored data: $(tail -2 "$work/views.log" | tr '\n' ' ')"
psql "$scratch_url" -q -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM v_payment_stages; SELECT count(*) FROM v_quotations; SELECT count(*) FROM v_projects;" > /dev/null || fail "views do not answer"
elapsed=$(( $(date +%s) - t0 ))
json+="\"restore_seconds\":$elapsed,\"backup_age_hours\":$age_hours}"

record true "$json" "" "$source"
echo "restore check ok: $source in ${elapsed}s $json"
