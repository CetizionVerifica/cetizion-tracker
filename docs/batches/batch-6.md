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

Revert the merge. Tokens can be revoked in Settings; the lockout clears after 15 minutes or on restart.
