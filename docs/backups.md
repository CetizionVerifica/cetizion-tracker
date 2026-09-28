# Backups and restores

The database holds every client, quotation, PO and payment. Files (quotation
PDFs, POs, certificates) are in Cloudinary, **not** in the database dump:
a lost file has to be uploaded again from the original (email, the client).

## Where backups are

| Copy | How | Schedule | Kept |
| --- | --- | --- | --- |
| 1. Dokploy | Dokploy → Databases → `cetizion-postgres` → Backups, to an S3 bucket (Backblaze B2 or Cloudflare R2) set up under Settings → Destinations | every 6 hours | 30 daily, 6 monthly (bucket lifecycle rule; versioning on) |
| 2. Second copy | `scripts/backup/backup.sh` from a machine that is not the server, or to a bucket at another provider, encrypted with `BACKUP_GPG_PASSPHRASE` | weekly | 30 days |

The backup bucket's key is write-and-list only where the provider allows it,
and is not a key the app has. The dump is about 400 KB today.

## The weekly restore check

`scripts/backup/verify.sh` restores the newest backup into a throwaway
database, checks that companies, quotations, projects, POs, payment stages and
the migration history have rows, builds the views on top, records the result
in the tracker, and drops the database. It exits non-zero on any failure.

Run it weekly as a Dokploy schedule, in a `postgres:17` container (the
tracker's image has no Postgres client of that version) with the aws CLI and
the repository's `scripts/` and `server/db/views.sql`:

```bash
ADMIN_DATABASE_URL=postgres://<admin>@cetizion-postgres:5432/postgres \
REPORT_DATABASE_URL=postgres://<app>@cetizion-postgres:5432/cetizion_tracker \
BACKUP_S3_URI=s3://<bucket>/<prefix> AWS_ENDPOINT_URL=<provider endpoint> \
MIN_ROWS="quotations=60 projects=5" \
./scripts/backup/verify.sh
```

The tracker alerts (see docs/operations.md) when a backup or check fails,
when no good backup is recorded for 8 hours, and when the check has not
passed for 8 days. The last runs show in `/api/health?deep=1`.

Dokploy's own backup job does not write to the tracker. Either run
`backup.sh` as the scheduled job instead (it records each run), or add this
to the end of the Dokploy schedule:

```bash
psql "$REPORT_DATABASE_URL" -c "INSERT INTO backup_runs (kind, ok, location) VALUES ('backup', true, 'dokploy')"
```

## Restoring everything (disaster)

Measured in the drill: **about 2 seconds** to restore and check today's data
locally; allow 15 minutes end to end including finding the file and
repointing the app.

1. Find the newest good backup: the bucket listing, or `/api/health?deep=1`.
2. Create a new database next to the old one (never restore over it):

   ```bash
   psql "$ADMIN_URL" -c 'CREATE DATABASE cetizion_restore'
   ```

3. Restore. For a custom-format dump (`.dump`):

   ```bash
   pg_restore --no-owner --no-privileges --exit-on-error -d "$ADMIN_URL_BASE/cetizion_restore" cetizion-YYYYMMDD-HHMMSS.dump
   ```

   For Dokploy's `.sql.gz`: `gunzip -c backup.sql.gz | psql "$ADMIN_URL_BASE/cetizion_restore"`.
   Encrypted copies: `gpg -d file.dump.gpg > file.dump` first.
4. Check it: `ADMIN_DATABASE_URL=... BACKUP_FILE=... ./scripts/backup/verify.sh`
   does the same checks on a scratch copy.
5. Point the app at it: in Dokploy change `DATABASE_URL` to
   `.../cetizion_restore` and redeploy. On start the app applies any
   migrations the backup is missing.
6. Sign in, open a recent quotation and the payment schedule, and compare
   with what people remember doing since the backup. Anything entered after
   the backup must be entered again.
7. Keep the old database until everyone is satisfied, then drop it.

## Restoring one table or a few rows (the usual case)

Someone deleted or overwrote records. Get just those rows back, without
touching anything else:

```bash
ADMIN_DATABASE_URL=postgres://<admin>@host:5432/postgres \
./scripts/backup/restore-table.sh cetizion-20260917-020000.dump payment_stages "po_number = 'PO-77455'"
```

That writes `payment_stages.csv` from the backup. Check it, then load the rows
in a transaction:

```sql
BEGIN;
DELETE FROM payment_stages WHERE po_number = 'PO-77455';   -- the damaged rows
\copy payment_stages FROM 'payment_stages.csv' CSV HEADER
COMMIT;
```

Child rows (payments of a stage, lines of a quotation) are restored the same
way, parent first.

## Drill log

| Date | Backup | Where restored | Time | Result | By |
| --- | --- | --- | --- | --- | --- |
| 2026-09-17 | local dump of the development database | scratch database on the same machine | 2 s | passed; a check made to fail on purpose raised an alert | Sami (with Claude) |
| | production, newest Dokploy backup | scratch database on the server | | to do once the bucket is set up | the lead |
