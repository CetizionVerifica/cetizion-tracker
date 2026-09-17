# Batch 1 of 6: foundations

Issues: #45 bulk import, #20 companies and contacts, #21 background jobs and email, #36 browser tests, #37 security scanning.

This is the first of six pull requests, one per batch of five issues. Merge them in order (1 to 6); each one builds on the one before and was tested on its own.

## What it does

- **Bulk import (#45).** An admin uploads the sales sheet (Excel or CSV). Every row becomes the records a person would enter (quotation, project, PO, payment stages, invoice, receipt), shown step by step for review; nothing is written until "Complete and commit", in one transaction. Duplicates are found by PO number or quotation number (certain) or by client, service and date (possible), and default to keeping the original. The AI reads only the free-text remarks and never calculates. There is also a template download, Excel export from every list, and exports that follow the list's filters.
- **Companies and contacts (#20).** A client exists once, with its sector, GSTIN, address and contacts. Quotations, enquiries and projects link to it whatever was typed; the Companies page points out look-alike names and merges them.
- **Background jobs and email (#21).** A worker process (pg-boss) runs scheduled jobs: weekday payment reminders to the client's billing contact (at most weekly per invoice) and a finance digest. Every composed email is logged. Nothing is really sent unless `EMAIL_MODE=live`.
- **Browser tests (#36).** Playwright signs in, quotes a client, imports a sheet and commits it.
- **Security scanning (#37).** CI scans dependencies, the container, the code and the history for leaked secrets; Dependabot proposes updates weekly.

## Deploying it

- **Migrations** 010 to 012 run on their own when the container starts (existing `start.js`). Existing client names are turned into companies by migration 011.
- **New packages:** multer, nodemailer, pg-boss, xlsx (server); @playwright/test (web, dev only).
- **Environment (optional, safe defaults):** `EMAIL_MODE` (default `log`: nothing is sent), `EMAIL_ALLOWLIST`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_BCC`. The import's AI review uses the existing `OPENROUTER_API_KEY`; without it the rules still apply.
- **Worker (needed for the scheduled jobs):** in Dokploy, add a second application from the same image with the command `node src/worker.js` and the same environment. Without it the site works; only the scheduled jobs do not run (they can still be run by hand under Emails → Jobs).
- **To switch real email on:** set the SMTP values, then `EMAIL_MODE=sandbox` with `EMAIL_ALLOWLIST=@cetizionverifica.com` to try it, then `live`.

## How to check it

1. Companies: open the page; each client appears once, with its quotations and projects.
2. Bulk import: upload the template with a few rows; review the six steps; commit; the records appear.
3. Emails → Jobs: run "reminders.payment"; the log shows what would have been sent.
4. `cd web && npx playwright install chromium && npm run test:e2e`.

## Checks run before this PR

Server tests, browser tests, the migration check (`scripts/ci/check-migrations.sh origin/main`) and the web build, all passing at this batch. No conflicts with `main`. With the team's open PRs #54 and #55 this batch merges cleanly (their `.gitignore` line and ours are kept apart on purpose).

## Rolling back

Revert the merge. The new tables are additive; nothing existing was dropped.
