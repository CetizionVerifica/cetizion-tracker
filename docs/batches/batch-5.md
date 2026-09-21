# Batch 5 of 6: running the business

Issues: #39 project profitability, #42 visit scheduling, #49 webhooks and n8n, #47 client portal, #48 accounting.

Merge after batch 4.

## What it does

- **Profitability (#39).** Each project shows earnings against costs: travel bills, expense claims and new project costs (external auditors, lab fees) with their bills. Missing amounts are shown as gaps, not guessed. A report by service line, client and sector; a project whose costs pass 80% of its PO value gets a review task.
- **Visit scheduling (#42).** Audits and site visits on a calendar with the team, dates and site. Warnings when someone is already booked, on leave or off; each person's monthly load; a trip created from the visit; a reminder the evening before; finishing a visit can make its payment stage ready to invoice.
- **Webhooks (#49).** n8n or any system can be told when a deal is won, an invoice is issued or overdue, a payment arrives, and more. Calls are signed (HMAC), retried for about a day, and can be replayed; personal data is left out unless allowed. A website form can post enquiries in through a signed endpoint. Recipes: `docs/webhooks-n8n.md`.
- **Client portal (#47).** A client signs in with a one-time link sent to their email and sees only their own projects, documents, invoices (with a statement PDF) and certificates, and can send a message to the sales inbox. Off until switched on per company; every view is logged. Tests prove one client never sees another's data.
- **Accounting (#48).** Invoices and payments in the books are compared with the tracker and every difference is listed until fixed or explained; payments can be copied across. Draft invoices with the right GST split; TDS by client and quarter; a GSTR-1 sales file. Works today with Zoho Books or Tally export files.

## Deploying it

- **Migrations** 033 to 037, applied on start. `staff` is seeded from existing people for scheduling.
- **Environment (optional):** `INCOMING_WEBHOOK_SECRET` (for the website enquiry form); for a live Zoho link `ZOHO_DC`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORGANIZATION_ID`; for Tally `TALLY_URL`. Without them the file-based accounting works.
- **Public routes added:** `/portal` and `/api/portal/*` (own signed cookie, rate-limited), `/api/hooks/enquiries` (signature required).
- Webhook URLs must be https in production.
- New jobs: `visits.reminders`, `webhooks.deliver` (every minute), `accounting.sync`, and cost alerts inside `notifications.daily`.
- **Decision for the lead:** Zoho Books or Tally for a live connection.

## How to check it

1. A project → Costs → add a cost with a bill; the margin updates. Profitability page shows the report.
2. Schedule → add a visit for someone already booked that day; the warning shows.
3. Webhooks → add an endpoint (https://webhook.site works) → Send test; the delivery shows 200.
4. A company → Portal → switch on, give a contact access, send the link; open it in a private window.
5. Accounting → upload a Zoho or Tally invoice export; the differences are listed.

## Checks run before this PR

Server tests (including portal isolation, webhooks and accounting), browser tests, migration check and web build passing at this batch; no conflicts with `main` or the team's open PRs #54 and #55.

## Review round 1

- zod 4 preparation: updates to visits, staff and webhook endpoints save only the fields the request sent (`lib/sentFields.js`).
- The portal statement PDF takes `money()` from `reportFormat.js` and its fonts from the shared `lib/pdf.js`, instead of relying on the quotation PDF module.
- Carries the batch 2 review fixes (see `batch-2.md`).

## Review round 2 (#61)

**`TRUST_PROXY=1` is required when this deploys**, for the same reason as
batch 4: the portal's rate limits — link requests, failed logins, messages —
are one bucket for every client behind Traefik otherwise, and the audit trail
records the proxy's address instead of the contact's.

- **Foreign-currency projects no longer report a loss they have not made.**
  The view and the route both read the retired `fx_rate_%` settings, which
  migration 013 made unsettable, so revenue converted to NULL against real
  costs. Both now read `exchange_rates` at the rate in force on the PO's own
  date, the way the sales report does.
- **`v_project_profitability` is created inside the transaction.** The
  `COMMIT` was above it, so `rebuildViews` left a window on every redeploy
  where the view did not exist and the profitability page and cost-alert job
  answered "relation does not exist".
- **A webhook can no longer be pointed inside the network.** The destination
  is resolved and the *address* is judged — loopback, the private ranges,
  link-local (so cloud metadata), carrier NAT, multicast, and bare container
  names like `traefik` or `postgres.internal` are all refused, at the moment
  the URL is saved and again at delivery. It mattered because the response
  code and the first 2 KB of the body come back through the deliveries API,
  which made an endpoint a readable probe rather than a blind one.
- **Portal access is off by default.** `contacts.portal_access` defaulted to
  `true`, so turning a company on would have made every contact row on it —
  stale ones and shared addresses the quotation trigger created included —
  eligible for a login link at once.
- **`PATCH /api/visits/<not-a-number>` answers 404 instead of creating a
  visit.** `Number()` gave `NaN`, `NaN` is falsy, and the save fell into the
  insert branch and fired a `visit.scheduled` webhook for it.
- **`task.overdue` is announced on the day it goes overdue and at 7, 14 and
  30 days**, not every morning for ever. A 60-day-old task had been firing a
  receiving workflow 60 times, each with its own idempotency key.
- **GSTR-1 B2B reports each rate on its own line.** A mixed-rate invoice was
  reported at the weighted average of its rates — 16.82% for a 100,000 at 18%
  plus 10,000 at 5% — which is not a rate the GST offline tool accepts.

## Rolling back

Revert the merge. Switch off any portal companies and webhook endpoints first.
