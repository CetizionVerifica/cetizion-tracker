# Issue plan

Every issue in the repository as of 17 September 2026, who holds it, and the
order we take the rest in. Update this file with every claim and every pull
request. WORKFLOW.md has the rules; PROGRESS.md is the plain-language summary.

## Not ours

| Issue | Title | Why not ours |
| --- | --- | --- |
| #6, #8, #9, #11, #12, #13, #14 | Bugs from the September pull-request reviews | Closed. PR #54 (shivam-balyan) carries the follow-up fixes. |
| #7 | Revenue report: Due now counts stages not invoiced | Assigned to PavithraCJ |
| #10 | Sales review PDF: exchange-rate line ignores quotation section | Assigned to PavithraCJ |
| #41 | Exchange rates with effective dates | Assigned to PavithraCJ |
| #15 | Clean up duplication in the sales review PDF code | Assigned to shivam-balyan |
| #18 | Sales KPIs, user accounts, activity log | Assigned to shivam-balyan |
| #19 | Epic: product flow from enquiry to cash to renewal | Container for #20 to #31; not a work item |
| #32 | Epic: platform | Container for #33 to #38; not a work item |

## Waiting on a decision from the lead

| Issue | Title | Decision needed |
| --- | --- | --- |
| #17 | Migrate the web app to Next.js 16, shadcn/ui, Tailwind 4 | Whether to rewrite now. Every UI issue below is built in the current app until decided. |
| #51 | Mobile app for field staff | Scope and priority |
| #52 | Timesheets and utilisation | The issue itself says: decide first whether time is billed |

## Our batches

Status values: `todo`, `claimed`, `in progress`, `PR open`, `merged`.

### Batch 1: land what is built, then the foundations everything else needs

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #45 | Bulk import, export and data fixes | done (checkpoint 1) | Importer with AI-assisted review and duplicate handling; CSV template; CSV and Excel exports that follow the list's filters; every import recorded as a batch with file, user, counts and time. |
| #20 | Companies and contacts instead of typed client names | done (checkpoint 1) | companies + contacts tables, records linked by trigger from the typed name, Companies page with look-alike merge, company page with contacts and records. Migration 011. |
| #21 | Background jobs and email sending | done (checkpoint 1) | pg-boss worker, email_log, EMAIL_MODE log/sandbox/live, kill switch in Settings, payment reminders and finance digest, Emails & jobs admin page. Migration 012. Plain HTML templates instead of react-email (no build step). Needs SMTP details from the lead to go live. |
| #36 | End-to-end tests (Playwright) for the critical flows | done (checkpoint 1) | Sign-in, quotation to company, import and commit. CI job on a fresh seeded database. PO and payment flows to be added as those screens change in Batch 2. |
| #37 | Dependency, container, code and secret scanning in CI | done (checkpoint 1) | npm audit, CodeQL, gitleaks, Trivy, Dependabot. Runs on the first push. |

### Batch 2: selling

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #23 | Quotations as real documents: catalogue, line items, GST, validity, revisions, PDF | done (checkpoint 2) | Services catalogue, quotation_lines with GST and computed totals, validity and terms from Settings, revisions with history, pdfmake PDF, send by email, acceptance; quotation page. Quotation templates (named line sets) not built: the catalogue covers the need for now. Migration 013. |
| #24 | Enquiries as leads: qualification, sources, follow-ups | done (checkpoint 2) | New/Contacted/Qualified/Nurture/Converted/Unqualified, lead sources, estimate carried to the quotation, follow-up and decision dates, first-response stamp, unqualified reasons. Owner stays the sales-person text until #18 lands. Migration 015. |
| #25 | Quotation pipeline: stages with probability, kanban, lost reasons, forecast | done (checkpoint 2) | Seven stages with probabilities, status kept in step by trigger, drag-and-drop board, lost reasons and competitor, weighted forecast by expected close month, expiry job. Migration 014. |
| #26 | PO received to project in one step, payment-schedule and onboarding templates | done (checkpoint 2) | Register PO dialog: project (new or existing of the same client), PO linked to the quotation, service lines from the quotation lines, stages from a template with credit days and milestone triggers, checklist with target dates. Templates admin page. Migration 016. |
| #46 | Discount and exception approvals on quotations | done (checkpoint 2) | Overall discount computed from the lines; above the Settings threshold the quotation waits for approval before sending; hand-raised exceptions; approve/reject with emails. Migration 017. |

### Batch 3: getting paid

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #22 | Tasks, notes, files and a timeline on every record | done (checkpoint 3) | Tasks, notes and attachments on companies, contacts, enquiries, quotations, projects, POs and stages; one timeline per record; Tasks page. Owners stay usernames until #18. Migration 018. |
| #27 | Collections: due dates, automatic reminders, chasing log, payments | done (checkpoint 3) | Payments table with TDS and mode, stage totals kept by trigger, reminder levels 3/14/30 days, promise-to-pay and hold, chasing log, Collections page. Invoices stay on the stage (the team's #7 design). Migration 019. |
| #28 | Renewals for recurring services | done (checkpoint 3) | Engagements found from delivered renewable services, renewal quotation drafted inside the lead time, renewed or lapsed closed automatically, Renewals page, daily job. Migration 020. |
| #40 | Cash-flow forecast from payment schedules and pipeline | done (checkpoint 3) | Month-by-month forecast: invoiced by due date, scheduled stages by expected trigger, pipeline weighted by probability, vendor bills and claims out; foreign currencies listed apart. |
| #44 | Notification centre and a daily digest | done (checkpoint 3) | Notification centre with unread count in the sidebar, daily sweep with de-duplication, digest email, approval requests notify at once. Migration 021. |

### Batch 4: client communication

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #29 | Connected mailboxes: Microsoft 365 sync onto records | done (checkpoint 4) | Code complete and tested with a stand-in mailbox. Microsoft Graph sign-in, encrypted tokens, delta sync every five minutes plus push notifications, contact and company matching, links to the open deal, visibility levels, reply from the tracker, disconnect. Migration 025. Going live needs the lead to register the Entra app and set the MS_* and MAIL_* variables. |
| #30 | Shared sales inbox | done (checkpoint 4) | Inbox on top of #29: owner of the client, else round robin; reply deadlines; canned responses and signature; snooze and close; convert to enquiry; overdue replies notified. Migration 026. Live once the shared mailbox is connected. |
| #31 | One-click email, call and WhatsApp with every touch logged | done (checkpoint 4) | Phase 1: contact bar (email, call, WhatsApp) on every record, log-a-touch with next step as a task, last-contacted stamps, do-not-contact, No contact tab. Migration 022. Phase 2 (Exotel or Twilio, WhatsApp Business) waits on the lead's decisions. |
| #53 | Client acceptance of quotations, e-signature later | done (checkpoint 4) | Private single-use link per revision; client accepts with name and tick or asks for changes; snapshot and PDF hash kept; deal moves to Verbal yes; links die on revision or expiry; unopened links flagged. Migration 023. |
| #43 | Certificates and deliverables registry | done (checkpoint 4) | Register with reference, dates, scope, issuing body and file; expiry drives the renewal engagement; supersede and withdraw; reminders at 120/90/30 days with tasks; company and project panels. Migration 024. |

### Batch 5: extended

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #39 | Project profitability: delivery cost against PO value | done (checkpoint 5) | Margin per project from PO value against travel bills, claims and new manual costs (with documents), paid and committed, planned against actual; gaps never counted as zero; report by service, client, sector, owner; cost alert with a task. Migration 027. |
| #42 | Audit and site-visit scheduling with auditor availability | done (checkpoint 5) | Visits with team, dates, site and milestone; completing one makes an On Milestone stage invoiceable; working days and leave with clash warnings; trip created from a visit; calendar, agenda, capacity; reminders. Migration 028. |
| #47 | Client portal | done (checkpoint 5) | Magic-link portal scoped to one company: projects, documents, invoices with a statement, certificates, messages into the shared inbox; per-company and per-section switches; audit of every view; isolation tests. Migration 030. |
| #48 | Accounting integration (Tally or Zoho Books) and GST/TDS reports | done (checkpoint 5) | Export-file import from Zoho or Tally (and the Zoho API and Tally XML behind configuration), reconciliation with take-books-value or resolve, draft invoices with CGST/SGST/IGST, TDS by quarter and GSTR-1 B2B CSV. Migration 031. The system choice and credentials are the lead's. |
| #49 | Outgoing webhooks and n8n automation | done (checkpoint 5) | Signed webhooks for 13 events, delivered within a second by the worker, retried for a day, replayable, held or dropped while off, personal data stripped unless allowed; signed incoming enquiries; n8n recipes in docs. Migration 029. |

### Batch 6: platform and tooling, with the lead

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #50 | MCP server so Claude can answer questions from live tracker data | done (checkpoint 6) | MCP server at /api/mcp with hashed tokens (admin or one sales person), 9 read tools and 4 guarded writes, all logged; scoping tests; docs/mcp.md. Migration 032. |
| #38 | Error tracking, uptime checks and metrics | done (checkpoint 6) | pino request logs with masked tokens, SDK-free Sentry/GlitchTip reports, /metrics, deep health, alerts from an ops.watch job; docs/operations.md. Migration 033. The lead sets up Uptime Kuma and the Sentry project. |
| #35 | A staging environment with its own database | done (checkpoint 6) | Scrub script with a test that no real name, email or phone survives; refresh script that swaps in a scrubbed copy; APP_ENV=staging blocks email, webhooks, mailbox sync and the books; basic-auth gate; STAGING band; CI deploy-staging job (off until the lead enables it); docs/staging.md. The Dokploy set-up is the lead's. |
| #33 | Database backups, off-site, with a restore drill | done (checkpoint 6) | backup.sh, verify.sh (weekly restore check with row counts and views, recorded, alerts on failure or staleness), restore-table.sh; local drill passed in 2 s; docs/backups.md. Migration 035. The bucket, schedules and the production drill are the lead's. |
| #34 | Close the public database port, rotate secrets, harden the app | done (checkpoint 6) | Sign-in lockout with an alert, production password rule, HSTS, frame denial, referrer policy, read-only database user script, no secrets in the tracked files; docs/security.md. Migration 034. Closing port 55432 and rotating secrets are the lead's. |

The lead's own order puts #33, #34 and #35 first. They are last here only
because they need server access we do not have; the moment the lead gives it,
they jump to the front.

## Review round 2: rebased onto main (21 September)

The lead asked on #58 for a rebase rather than a merge, one batch at a time:
rebase onto `main`, get it green, he merges it, then the next one rebases onto
`main`. That is what these branches now are.

**What main had moved on to** (29 commits since 17 September): the users table,
database sign-in and auth hardening (#71, #80, #81), shared report helpers and
status constants (#64, #70), dated exchange rates and reference counters (#79),
the import review label (#82), zod 4 and dotenv 18 (#84), React 19 and Vite 8
(#67). Zod 4 needed no changes here: the preparation done on 17 September holds.

**Migration numbers.** main held 013 to 016 when the lead asked for 018; #86 has since
merged and taken 017 and 018, so ours start at 019:

| Batch | Migrations |
| --- | --- |
| 2 | 019 to 023 |
| 3 | 024 to 027 |
| 4 | 028 to 032 |
| 5 | 033 to 037 |
| 6 | 038 to 041 |

**The 14 findings from the round 1 review are all fixed**, and each was checked
against the source again after the rebase, not just against this plan.

**Checks, per batch, on the new dependencies:** server tests 377 / 378 / 389 /
409 / 425, web build, and the migration check against `origin/main`, all green.
Browser tests 4/4. Every screen loads with no console errors, and the selling
and collecting flows were exercised end to end against the local database.

**Two collisions for the lead to sequence**, neither of which blocks these
branches:

- **#86** (sales report and country fields) merged on 21 September, taking 017
  and 018, so these branches were rebased onto it and renumbered once more.

**Not in these branches:** the follow-up reminder workflows asked for
separately on 20 September are held back on a local branch until these are
merged, and the country and turnaround fields built on 20 September were
removed once #86 turned out to cover them.

## Checkpoints

All work sits on the local branch `work/all-issues`, one commit per issue,
with a tag after every five issues. Nothing is pushed until Sami says so.

| Tag | Issues | State |
| --- | --- | --- |
| `checkpoint/batch-1` | #45, #20, #21, #36, #37 | server tests 59/59, browser tests 4/4, migration check green, web build clean |
| `checkpoint/batch-2` | #23, #24, #25, #26, #46 | server tests 59/59, browser tests 4/4, migration check green, web build clean |
| `checkpoint/batch-3` | #22, #27, #28, #40, #44 | server tests 60/60, browser tests 4/4, migration check green, web build clean |
| `checkpoint/batch-4` | #31, #53, #43, #29, #30 | server tests 70/70, browser tests 4/4, migration check green, web build clean |
| `checkpoint/batch-5` | #39, #42, #49, #47, #48 | server tests 100/100 (with the database suites), browser tests 4/4, migration check green, web build clean |
| `checkpoint/batch-6` | #50, #38, #34, #33, #35 | server tests 113/113 (with the database suites), browser tests 4/4, migration check green, web build clean |

## Log

- 2026-09-17: plan written. Bulk import merged with today's `main` and green on
  all four checks. #45 claimed on this branch.
- 2026-09-17: Batch 1 done and tagged `checkpoint/batch-1`.
- 2026-09-17: Batch 2 done and tagged `checkpoint/batch-2`.
- 2026-09-17: Batch 3 done and tagged `checkpoint/batch-3`. The migration check caught a fresh-install ordering bug in the #28 schema; fixed before tagging.
- 2026-09-17: Batch 4 done and tagged `checkpoint/batch-4`. #29 and #30 are built and tested against a stand-in mailbox; they go live when the lead registers the Microsoft app. Also fixed: the orphan-file sweep would have removed timeline attachments after a day.
- 2026-09-17: Batch 5 done and tagged `checkpoint/batch-5`. Also fixed: the background worker could not start (pg-boss 12 import), found while testing webhooks.
- 2026-09-17: Paused mid Batch 6 at the end of the session. #50 and #38 done and committed; #35, #33, #34 next, then checkpoint 6. README already links docs/backups.md, docs/security.md and docs/staging.md, which those issues add.
- 2026-09-18: Batch 6 done and tagged `checkpoint/batch-6`. Every planned issue is now built. Next: a full testing pass, then #17 (Next.js).
