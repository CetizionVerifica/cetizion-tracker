# Staging

Staging is a second copy of the tracker for trying things: new features
before production, migrations on realistic data, training. **Production is
never used for trying things.**

## What makes it safe

- **Its own database**, restored weekly from the newest production backup and
  then scrubbed (`server/db/scrub.sql`): every client and contact gets a
  realistic fake name, email (`@example.test`) and phone; notes, email bodies
  and call summaries are removed; amounts, dates and statuses stay, so reports
  look right. A test proves no real name, email or phone survives.
- **Nothing leaves it.** With `APP_ENV=staging` the app itself refuses to send
  real email (sandbox to the team still works), deliver webhooks, sync
  mailboxes, or talk to Zoho or Tally, whatever the settings say. The scrub
  also switches off webhooks, the client portal, API tokens and mailboxes.
- **Files stay in production's storage.** Document rows are cut loose, so
  staging cannot open production files; use its own Cloudinary folder
  (`CLOUDINARY_FOLDER`) for anything uploaded there.
- **Not public.** `STAGING_BASIC_AUTH=user:password` puts the whole site behind
  a shared credential (the plain health check stays open for Dokploy). An IP
  allow-list in Traefik works too.
- **Obvious.** A striped STAGING band sits on every page, client-facing ones
  included, and the tab title starts with [STAGING].

## Setting it up (the lead, once)

1. Dokploy → the CetizionVerifica project → add environment **staging**.
2. A Postgres service `staging-postgres` (a small one); database
   `cetizion_staging` (never a name containing "prod").
3. An application from this repository, branch **`staging`**, same Dockerfile.
   Environment: everything production has, except
   `DATABASE_URL` (the staging database), `APP_ENV=staging`,
   `STAGING_BASIC_AUTH`, `EMAIL_MODE=log` (or `sandbox` with
   `EMAIL_ALLOWLIST=@cetizionverifica.com`), a new `SESSION_SECRET` and
   `AUTH_PASSWORD`, `CLOUDINARY_FOLDER=cetizion-staging`, no `ZOHO_*`,
   `MS_*`, `TALLY_URL` or `SENTRY_DSN` production values.
4. The worker, as a second application from the same image with
   `node src/worker.js` and the same environment.
5. Domain `staging.tracker.cetizionverifica.com` with TLS.
6. GitHub → Settings → Variables: `STAGING_ENABLED=true`,
   `STAGING_URL=https://staging.tracker.cetizionverifica.com`.
7. A weekly Dokploy schedule on staging running `scripts/staging/refresh.sh`
   (below), then restarting the staging app.

## How it is deployed

Every push to `main` that passes CI moves the `staging` branch to that commit
(the `deploy-staging` job) and waits for the new container. Production moves
in its own job, as before. Migrations therefore run on staging within minutes
of the same commit reaching production.

A stronger order, which the lead may choose: make the production job wait
for `deploy-staging` (`needs: [deploy-staging]`) or trigger production by
hand (`workflow_dispatch`), so every migration is rehearsed on staging first.

## Refreshing the data

```bash
STAGING_ADMIN_URL=postgres://<admin>@staging-postgres:5432/postgres \
STAGING_DB=cetizion_staging \
BACKUP_S3_URI=s3://<bucket>/<prefix> AWS_ENDPOINT_URL=<endpoint> \
./scripts/staging/refresh.sh
```

It restores into a new database, scrubs it, checks no real email remains, and
only then swaps it in, keeping the previous copy as `cetizion_staging_previous`.
Restart the staging app afterwards; it applies any newer migrations as it
starts. Everyone's staging sign-in is the staging `AUTH_PASSWORD`.

To scrub by hand: `psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/scrub.sql`.
