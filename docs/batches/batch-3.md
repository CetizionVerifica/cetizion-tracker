# Batch 3 of 6: after the sale

Issues: #22 tasks, notes and timeline, #27 collections, #28 renewals, #40 cash-flow forecast, #44 notifications.

Merge after batch 2.

## What it does

- **Tasks, notes, files and a timeline (#22).** Every company, enquiry, quotation, project, PO and payment stage carries tasks, notes and files, and one timeline of everything that happened to it. A Tasks page lists what is due.
- **Collections (#27).** Payments are recorded with date, mode, TDS and reference, and stage totals follow. Reminders go out at 3, 14 and 30 days overdue (through the batch 1 worker). Finance can log a chase, record a promise to pay, or put a stage on hold. The Collections page shows who owes what.
- **Renewals (#28).** Delivered recurring services (annual audits and the like) become engagements. A renewal quotation is drafted before the due date; renewed or lapsed work is closed automatically by a daily job.
- **Cash-flow forecast (#40).** Money expected in and out by month: invoices, the payment schedule, the weighted pipeline, vendor bills and expense claims.
- **Notifications (#44).** A bell count in the sidebar and a Notifications page: tasks due, follow-ups, approvals, newly overdue invoices, renewals, quotations about to expire. A digest email each morning.

## Deploying it

- **Migrations** 022 to 025, applied on start.
- No new environment variables or packages.
- New scheduled jobs (worker): `renewals.daily`, `notifications.daily`; `reminders.payment` now follows the 3/14/30-day levels.

## How to check it

1. Open a company: add a task and a note; both show on its timeline and the task on Tasks.
2. Collections: record a part payment with TDS on an overdue stage; the totals update. Log a chase.
3. Cash flow: the months show expected money in and out.
4. Notifications: the bell count matches the page.

## Checks run before this PR

Server tests, browser tests, migration check and web build passing at this batch; no conflicts with `main` or the team's open PRs #54 and #55.

## Rolling back

Revert the merge. Migrations only add tables and columns.
