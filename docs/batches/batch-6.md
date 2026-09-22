# Batch 6 of 6: running it safely

Issues: #50 Claude (MCP) access, #38 monitoring, #34 security, #33 backups, #35 staging. With this batch every item under #32 (platform) is done. It also carries the bulk import improvements found in the final testing (#45).

Merge after batch 5.

## Before merging: check this first

**Production refuses to start if `AUTH_PASSWORD` is shorter than 14 characters or is the development password (#34).** Confirm the live value in Dokploy first, and change it if needed, or the new container will not boot (the old one keeps running until it does).

## What it does

- **Claude access (#50).** An MCP endpoint at `/api/mcp`. People create a personal token in Settings and ask Claude about the pipeline, a client's history, overdue invoices or their own numbers, from live data. A sales token sees only its owner's records. It can add notes, tasks and next steps, but never delete, change a status or touch money. Every call is logged. Guide: `docs/mcp.md`.
- **Monitoring (#38).** Structured logs without client data; error reports to Sentry (when `SENTRY_DSN` is set) with the release; `/api/health?deep=1` (database, migrations, backups, jobs, queue); `/metrics` for Prometheus (staff session or `METRICS_TOKEN`); alerts by email for failed jobs, missing backups, sign-in attacks, an expiring certificate or a full disk. Guide: `docs/operations.md`.
- **Security (#34).** Ten failed sign-ins from one address lock it for 15 minutes and raise an alert (both settable in Settings); the weak-password rule above; HSTS when cookies are secure, frame denial, strict referrer policy; a read-only database user script. **The database port 55432 is open to the internet today**: `docs/security.md` has the step-by-step fix and how to rotate every secret.
- **Backups (#33).** `scripts/backup/backup.sh` (independent copy, optional encryption and S3 upload), `verify.sh` (weekly restore into a throwaway database with row checks, recorded and alerted), `restore-table.sh` (bring back a few rows). A local drill took 2 seconds. Runbook: `docs/backups.md`.
- **Staging (#35).** A second copy for trying things, refreshed weekly from the newest backup with every client and contact name, email and phone replaced (`server/db/scrub.sql`, with a test that nothing real survives). With `APP_ENV=staging` it never emails clients, calls webhooks, syncs mail or touches the books, sits behind `STAGING_BASIC_AUTH`, and shows a STAGING band. A `deploy-staging` CI job stays off until `STAGING_ENABLED` is set. Guide: `docs/staging.md`.
- **Bulk import improvements (#45).** Rows that would fail at commit (a negative amount, a value too long) are errors on the review screen instead of stopping the whole commit. A duplicate matched only by client and service (typically Lost or Under Negotiation deals, which have no PO number) is marked not certain, with a warning, and can be imported as new; exact matches stay keep-or-replace, and re-importing a file changes nothing. The review resets when moving between imports, and banners and search boxes fit narrow screens.

## Deploying it

- **Migrations** 038 to 042, applied on start.
- **New packages:** @modelcontextprotocol/sdk, pino, pino-http, prom-client (morgan removed).
- **Environment (optional):** `SENTRY_DSN`, `RELEASE`, `ALERT_EMAIL`, `METRICS_TOKEN`, `LOG_FORMAT`, `LOG_LEVEL`; staging only: `APP_ENV=staging`, `STAGING_BASIC_AUTH`.
- New job: `ops.watch` every 15 minutes.
- **Lead's tasks:** close port 55432 and rotate secrets (`docs/security.md`); schedule backups and the weekly check with an off-site bucket (`docs/backups.md`); create staging in Dokploy (`docs/staging.md`); set up Sentry and Uptime Kuma on `/api/health` (`docs/operations.md`).

## How to check it

1. `/api/health?deep=1` while signed in: all checks listed (backups show not ok until the first backup runs).
2. Settings → API tokens → create one; follow `docs/mcp.md` to connect Claude; ask "what is in the pipeline?".
3. Sign in wrongly ten times from one machine: the eleventh attempt is refused and an alert appears.
4. Run `backup.sh` then `verify.sh` against a copy; the health page shows both.
5. Bulk import: a sheet with a Lost deal already on the site shows "Possible duplicate … Not certain" and the "Import as new" choice.

## Checks run before this PR

116 server tests, 4 browser tests, migration check and web build, all passing; a live walk through all 463 pages and every form with no errors. No conflicts with `main`, and merged together with the team's open PRs #54 and #55 the tests still pass.

## Rolling back

Revert the merge. Tokens can be revoked in Settings. The lockout clears
fifteen minutes after the last failed attempt, or as soon as the right
password is typed — **not** on restart: the failures are rows in
`auth_events`, so a redeploy does not clear them. To lift one by hand,
delete that account's recent failures from `auth_events`.

## Review round 2 (#62)

- **The sign-in lockout is keyed on the account, not only the address.** It
  counted failures per IP, and behind Traefik with `TRUST_PROXY=0` every
  request carries the proxy's address — so ten bad guesses from anywhere on
  the internet locked out the whole company for fifteen minutes, people
  typing the correct password included. The per-account count is what is
  enforced; the address-wide one is five times the limit and applies only
  when the address is genuinely the caller's (`TRUST_PROXY > 0`, or no proxy
  at all). A correct sign-in clears the count it belongs to.
- **Staff accounts are scrubbed on staging too.** The scrub replaced every
  client and contact detail but never touched `users`, so staging kept
  production's password hashes and the team's real addresses. Each account
  becomes an inactive attribution-only row — name kept, address and hash
  gone, `session_version` moved on so a copied cookie is dead — and staging
  is signed in to with the admin the bootstrap creates. Inactive as well as
  blank, because `users_active_needs_login` says an account that can sign in
  has something to sign in with.
- **A token can be read-only.** `role` said whose records a token sees and
  never whether it could change them, so both roles reached `create_task`,
  `add_note`, `log_touch` and `update_next_step` — a token issued to let an
  assistant answer questions could write on everything it could see. Writing
  is a separate choice now (`can_write`, migration 043), off unless asked
  for, and a reading token is not even offered the write tools.
- **The MCP rate limit is per token, not per address**, as #50 asks. Behind
  a proxy every client arrives from the same address, so one budget was
  shared by all of them and one busy client starved the rest. The token is
  hashed into the key, so the limiter never holds the plaintext.
- **`/metrics` and `/api/health?deep=1` re-read the account.** Both used
  `readSession`, which checks the signature and the expiry and nothing else,
  so a deactivated, deleted or demoted user kept reading them for up to
  twelve hours. Both now use `currentUser`, and the deep check — which names
  the migrations applied, the backup location and failing jobs — is
  restricted to admins, as #38 asks.
