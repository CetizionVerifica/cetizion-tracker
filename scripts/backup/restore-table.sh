#!/usr/bin/env bash
# Get one table (or some of its rows) back from a backup without touching
# the live database (#33). The table is restored into a scratch database,
# and the rows you want are written to a CSV you can check before loading.
#
#   ADMIN_DATABASE_URL=postgres://user:pass@host:5432/postgres \
#   ./scripts/backup/restore-table.sh /backups/cetizion-20260917.dump payment_stages "po_number = 'PO-77455'"
#
# Then, after checking the CSV, load the rows into the live table, e.g.:
#   \copy payment_stages FROM 'payment_stages.csv' CSV HEADER
# (delete or rename the damaged rows first, in a transaction).
set -euo pipefail
file="${1:?backup file}"; table="${2:?table name}"; where="${3:-TRUE}"
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required}"
[[ "$table" =~ ^[a-z_]+$ ]] || { echo "table name looks wrong: $table" >&2; exit 1; }
db="restore_$(date +%s)_$$"
scratch_url="$(printf '%s' "$ADMIN_DATABASE_URL" | sed -E "s#/[^/?]*(\?|$)#/$db\1#")"
trap 'psql "$ADMIN_DATABASE_URL" -q -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || true' EXIT

psql "$ADMIN_DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$db\""
# The whole schema, then just this table's data.
pg_restore --no-owner --no-privileges --schema-only -d "$scratch_url" "$file" > /dev/null 2>&1 || true
pg_restore --no-owner --no-privileges --data-only --disable-triggers -t "$table" -d "$scratch_url" "$file"
psql "$scratch_url" -v ON_ERROR_STOP=1 -c "\\copy (SELECT * FROM $table WHERE $where) TO '$table.csv' CSV HEADER"
echo "Wrote $(($(wc -l < "$table.csv") - 1)) rows to $table.csv"
