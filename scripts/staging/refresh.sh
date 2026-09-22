#!/usr/bin/env bash
# Refresh staging from the newest production backup, then scrub it (#35).
# Run weekly as a Dokploy schedule on staging, in a postgres:17 container
# with the aws CLI and this repository's scripts/ and server/db/.
#
#   STAGING_ADMIN_URL=postgres://<admin>@staging-postgres:5432/postgres \
#   STAGING_DB=cetizion_staging \
#   BACKUP_S3_URI=s3://<bucket>/<prefix> AWS_ENDPOINT_URL=<endpoint> \
#   ./scripts/staging/refresh.sh
#
# BACKUP_FILE can name a local dump instead. The staging app should be
# stopped or restarted afterwards: it applies any newer migrations on start.
# The staging database's name must not contain "prod"; the scrub refuses it.
set -euo pipefail
: "${STAGING_ADMIN_URL:?STAGING_ADMIN_URL is required}"
: "${STAGING_DB:?STAGING_DB is required}"
[[ "$STAGING_DB" =~ ^[a-z0-9_]+$ ]] || { echo "STAGING_DB must be lower-case letters, digits and _" >&2; exit 1; }
[[ "$STAGING_DB" != *prod* ]] || { echo "STAGING_DB looks like production; refusing" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
new="${STAGING_DB}_incoming"
db_url() { printf '%s' "$STAGING_ADMIN_URL" | sed -E "s#/[^/?]*(\?|$)#/$1\1#"; }

# 1. The newest backup.
if [[ -n "${BACKUP_FILE:-}" ]]; then
  file="$BACKUP_FILE"
else
  : "${BACKUP_S3_URI:?set BACKUP_FILE or BACKUP_S3_URI}"
  key="$(aws s3 ls "${BACKUP_S3_URI%/}/" --recursive | sort | tail -1 | awk '{print $4}')"
  [[ -n "$key" ]] || { echo "no backups under $BACKUP_S3_URI" >&2; exit 1; }
  bucket="$(printf '%s' "$BACKUP_S3_URI" | sed -E 's#s3://([^/]+).*#\1#')"
  file="$work/$(basename "$key")"
  aws s3 cp "s3://$bucket/$key" "$file" --only-show-errors
fi
if [[ "$file" == *.gpg ]]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase "${BACKUP_GPG_PASSPHRASE:?}" -o "$work/dump" -d "$file"; file="$work/dump"
fi
echo "Restoring $(basename "$file") into $new"

# 2. Restore into a fresh database, scrub it, and only then swap it in, so a
#    failure leaves the current staging data as it was.
psql "$STAGING_ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$new\" WITH (FORCE)" -c "CREATE DATABASE \"$new\""
if [[ "$file" == *.gz ]]; then
  gunzip -c "$file" | psql "$(db_url "$new")" -q -v ON_ERROR_STOP=1 > "$work/restore.log"
else
  pg_restore --no-owner --no-privileges --exit-on-error -d "$(db_url "$new")" "$file"
fi
psql "$(db_url "$new")" -q -v ON_ERROR_STOP=1 -f "$here/../../server/db/scrub.sql"

# 3. A quick proof the scrub worked: no contact email outside example.test.
leaks="$(psql "$(db_url "$new")" -At -c "SELECT count(*) FROM contacts WHERE email IS NOT NULL AND email NOT LIKE '%@example.test'" | tr -d '\r')"
[[ "$leaks" == "0" ]] || { echo "scrub check failed: $leaks real-looking emails remain" >&2; exit 1; }

# The app's connections to the old copy are closed so it can be renamed.
psql "$STAGING_ADMIN_URL" -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$STAGING_DB' AND pid <> pg_backend_pid()" > /dev/null
psql "$STAGING_ADMIN_URL" -q -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"${STAGING_DB}_previous\" WITH (FORCE)" \
  -c "ALTER DATABASE \"$STAGING_DB\" RENAME TO \"${STAGING_DB}_previous\"" \
  -c "ALTER DATABASE \"$new\" RENAME TO \"$STAGING_DB\"" 2>/dev/null \
|| psql "$STAGING_ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$new\" RENAME TO \"$STAGING_DB\""
echo "Staging refreshed. Restart the staging app so it reconnects and applies newer migrations."
