#!/usr/bin/env bash
#
# Proves that this commit's migrations take the database of an earlier
# commit (the one in production) to exactly the schema schema.sql builds
# from scratch, applied the same way the container applies them on start.
#
#   TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres \
#     scripts/ci/check-migrations.sh <base git ref>
#
# TEST_DATABASE_URL must be allowed to create and drop databases.

set -euo pipefail

BASE_REF="${1:?usage: scripts/ci/check-migrations.sh <base git ref>}"
ADMIN_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a Postgres that may create databases}"

ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
UPGRADED="ci_upgraded_$$"
FRESH="ci_fresh_$$"

db_url() {
  # shellcheck disable=SC2016 # the backticks are a JavaScript template, not shell
  node -e 'const u = new URL(process.argv[1]); u.pathname = `/${process.argv[2]}`; console.log(u.toString())' "$ADMIN_URL" "$1"
}

cleanup() {
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $UPGRADED WITH (FORCE)" -c "DROP DATABASE IF EXISTS $FRESH WITH (FORCE)" || true
  git -C "$ROOT" worktree remove --force "$WORK/base" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $UPGRADED" -c "CREATE DATABASE $FRESH"

echo "::group::Deployed schema: $BASE_REF with its seed data"
git -C "$ROOT" worktree add --detach "$WORK/base" "$BASE_REF" >/dev/null
(
  cd "$WORK/base/server"
  npm ci --no-audit --no-fund --silent
  DATABASE_URL="$(db_url "$UPGRADED")" node scripts/db.js migrate
  DATABASE_URL="$(db_url "$UPGRADED")" node scripts/db.js seed
)
echo "::endgroup::"

cd "$ROOT/server"

echo "::group::Upgrade it with this commit's migrations"
DATABASE_URL="$(db_url "$UPGRADED")" node scripts/db.js upgrade
echo "::endgroup::"

echo "::group::Upgrade again: nothing may be left to do"
second_run="$(DATABASE_URL="$(db_url "$UPGRADED")" node scripts/db.js upgrade)"
echo "$second_run"
if ! grep -q 'up to date' <<<"$second_run"; then
  echo "::error::A second upgrade still changed the database; see the output above."
  exit 1
fi
echo "::endgroup::"

echo "::group::The same schema from scratch: schema.sql, views.sql and seed"
DATABASE_URL="$(db_url "$FRESH")" node scripts/db.js migrate
DATABASE_URL="$(db_url "$FRESH")" node scripts/db.js seed
echo "::endgroup::"

signature() {
  psql "$(db_url "$1")" -At -v ON_ERROR_STOP=1 -f "$ROOT/scripts/ci/schema-signature.sql"
}

if ! diff -u <(signature "$FRESH") <(signature "$UPGRADED") > "$WORK/schema.diff"; then
  echo "::error::schema.sql and db/migrations disagree. Lines with - exist only in a database built from schema.sql; + only in one upgraded with the migrations."
  cat "$WORK/schema.diff"
  exit 1
fi

echo "✓ Migrations bring $BASE_REF's database to the same schema as schema.sql."
