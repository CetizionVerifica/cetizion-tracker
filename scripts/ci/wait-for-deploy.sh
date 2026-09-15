#!/usr/bin/env bash
#
# Waits until the app at <url> is served by a new container: /api/health
# answers ok with a started_at other than <previous started_at>. The
# container only starts listening once its migrations are applied, so this
# is the moment the deploy, migrations included, is live.
#
#   scripts/ci/wait-for-deploy.sh https://tracker.example.com "2026-09-15T12:52:10.000Z"

set -euo pipefail

URL="${1:?usage: scripts/ci/wait-for-deploy.sh <app url> [previous started_at]}"
PREVIOUS="${2:-}"
TIMEOUT_SECONDS="${DEPLOY_TIMEOUT_SECONDS:-900}"
INTERVAL_SECONDS=10

deadline=$((SECONDS + TIMEOUT_SECONDS))
last_seen=""

while (( SECONDS < deadline )); do
  body="$(curl -fsS --max-time 10 "$URL/api/health" 2>/dev/null || true)"
  status="$(jq -r '.status // empty' <<<"$body" 2>/dev/null || true)"
  started="$(jq -r '.started_at // empty' <<<"$body" 2>/dev/null || true)"

  if [[ "$status" == "ok" && -n "$started" && "$started" != "$PREVIOUS" ]]; then
    echo "✓ New container serving since $started"
    exit 0
  fi

  if [[ "$started" != "$last_seen" ]]; then
    echo "… waiting (health: ${status:-no answer}, started_at: ${started:-none})"
    last_seen="$started"
  fi
  sleep "$INTERVAL_SECONDS"
done

echo "::error::No new container answered $URL/api/health within ${TIMEOUT_SECONDS}s."
echo "Open the deployment in Dokploy for its build and start logs. A migration that fails stops the new"
echo "container before it listens, and Dokploy rolls back, so the previous version should still be serving."
exit 1
