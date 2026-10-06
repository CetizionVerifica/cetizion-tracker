# Issue #188: what was built, and how to use it

Issue/PR #188 holds two plans written on 4 October 2026:
`docs/mis-briefing-fix-plan.md` (the Daily Sales Briefing) and
`docs/email-po-invoice-prompt-plan.md` (the email PO and invoice readers).
Both plan files live in PR #188 itself; this branch builds them. The code
comments cite them by section ("§3a"), so read them side by side with this
guide.

This guide says what changed, where a person sees it, how to switch it on
or off, how it was tested, and what is still open.

---

## 1. At a glance

| Plan | Section | What it does now | Where you see it |
|---|---|---|---|
| Briefing | §1 schedule visibility | **Not in this branch.** Shyam's branch `claude/project-thread-pj2nei` does it (and more: the API sends the briefing when the worker does not). See §8. | Reports → Scheduled reports |
| Briefing | §2 relevance | Newsletters, vendor pitches, our own reports, internal chatter and the same email in two mailboxes are kept out of the highlights; every shared mailbox is read; a footnote says what was left out and why | The briefing's highlights and footnote |
| Briefing | §3 reference format | The four-section briefing: at a glance (Metric / Count / Detail), key highlights with their source email and earlier emails, reminders carried forward, every pending row (no page cap), top 5 actions, a footer on every page | The PDF attached to the daily email; the email in short |
| Briefing | §3a receivables | Finance's emailed Sundry Debtors list is found, read once and reconciled with the tracker | The receivables table and the line under it |
| Readers | §1 GSTINs and partners | Both our GSTINs (Delhi, UP) and the partner companies are "us"; a PO to a partner is ours, marked as through it; an invoice from the wrong GSTIN goes to review | Settings → Company profile; "Through …" on PO and project pages |
| Readers | §2 reading rules | More date and amount formats, the GST rows read one by one, the amount in words checked | Fewer wrong readings and fewer needless reviews |
| Readers | §3 PO checks | The client's own reference kept apart from ours; a line on two rows is one line; revision wording and a changed re-sent PO go to review as amendments | PO review queue |
| Readers | §4 invoice checks | The PO number only from the boxes that hold it; the PO date checked | Invoice review queue |
| Readers | §5 split | A share of a PO with one 100% stage offers a one-click split | Payment stages → Invoice review |
| Readers | §6 client notes | Per-client notes for the AI, label aliases, PO-number patterns | Settings → Connections → Client document notes |
| Readers | §7 tests and rollout | Sample-document fixtures, an accuracy script, and a review-only switch | Settings → Mailboxes; `npm run readers:accuracy` |
| (extra) | Demo data | A demo database of made-up data, for showing the tracker | `npm run demo:data` |

---

## 2. The Daily Sales Briefing

### 2.1 Which mail it reads (briefing §2)

The highlights are written from yesterday's threads in **every shared
mailbox that shares everything**. Left out, each with its reason in the
footnote:

- automatic or bulk senders, and newsletters;
- vendors' sales pitches;
- our own reports (the briefing and the MIS, by subject and by the email log);
- internal-only mail, unless it is on a record;
- the same email in a second shared mailbox (counted once).

A shared mailbox shared only as *subject* or *metadata* cannot give the AI
any text: the footnote names it as "not read" so the gap is visible.
"New enquiries" counts only enquiries the reader judged new, plus the ones
people logged.

### 2.2 The reference format (briefing §3)

The PDF now follows the 03 Oct reference briefing:

1. **Header**: the date with its weekday, when it was generated, and the
   source line (the mailboxes read, their folders, 00:00–23:59 IST).
   A **day paragraph** under it, built in code from the counts.
2. **At a glance**: a Metric / Count / Detail table, with the clients
   behind each count, "Other sales activity" and the overdue breakdown.
3. **Key highlights**, numbered: action and owner, the source email
   (Outlook's link, else the thread in the Inbox), up to three earlier
   emails on the same thread or record. **Reminders carried forward**:
   visits and meetings in the next three days, and POs received by email
   and not yet registered.
4. **Pending tasks**: how days are counted and what Overdue means; every
   row, overdue rows in red; columns Client, Reference, Amount ("not
   stated" when there is none), Last activity, Days, Owner, Next action,
   Email. Invoices in three tables: to check, to raise, receivables (with a
   grand total). A closing line under each table.
5. **Action items for today (top 5)**, each with its owner and a link.
6. A footer on every page naming the mailboxes and the report.

The email carries the same sections in short. The **weekly MIS is
unchanged** (two pages), except "Enquiry to PO" and "Quote to contract",
which printed a missing glyph before.

**Owner** falls back to the salesperson (enquiries, quotations) or the
project manager (invoices) when a record has no owner account.

### 2.3 Finance's debtors list (briefing §3a)

**Settings → Reports → Scheduled reports → Finance's debtors list**:

- *Subject or file name has*: the words that find the list (default:
  sundry debtors, debtors, outstanding, receivable).
- *Sent by*: Finance's addresses; blank means anyone at our own domains.

How it works:

1. The newest such email in a shared mailbox, in the last 14 days, is the list.
2. It is **read once**: an Excel or CSV file in code; a PDF by the AI (one
   call, only on the scheduled send or a preview that asks for the AI).
   Tally's "Dr" and "Cr" balances are understood (a Cr is the client's
   credit).
3. It is used only when **every amount is in the file and the rows add up
   to the grand total**. Otherwise it is stored as not used, with the
   reason, and the briefing says so. A protected or damaged file is stored
   as "could not be opened".
4. It is **reconciled client by client** ("M/s." and "Pvt Ltd" do not
   matter): equal amounts match; otherwise both figures show ("list:
   2,44,530; tracker: 2,10,000"); a line only on the list is a Finance
   action, "record in tracker", linked to the list's email; a tracker row
   not on the list says so. "Pending for invoicing" lines go with the
   invoices to raise.

With no list in 14 days, or the newest one not used, the receivables are the
tracker's alone and the line under the table says which.

---

## 3. The email PO and invoice readers

### 3.1 Our GSTINs and partner companies (readers §1)

**Settings → Company profile**:

- **All our GSTINs**: every state we are registered in, comma-separated.
  Seeded with Delhi `07AAKCC0860B1Z2` and UP `09AAKCC0860B1ZY`. A GSTIN with
  our PAN is "us" even if it is not listed.
- **Partner companies**: one per line, `name | GSTIN | other names`.
  Seeded with `Innovative CSR Solutions India Pvt. Ltd. | 07AACCI8342L1ZA`.
  Write `none` for no partners.

What it changes:

- A PO to our UP GSTIN (Alembic) or to a partner (Hindalco → Innovative CSR)
  is registered as ours. The PO keeps the GSTIN it was addressed to and, for
  a partner, the partner's name: a **"Through <partner>"** chip on the PO and
  project pages, and a remark on the PO.
- An invoice raised from another GSTIN than its PO was addressed to goes to
  review: **wrong_gstin**.
- The AI prompts name both GSTINs, the PAN and the partners.

### 3.2 Reading rules (readers §2)

- Dates: `03.08.2026`, `08-AUG-2026`, `25-03-2026`, `22-May-26` (20YY).
- Amounts: three decimals (`500,000.000`) and labels glued to the figure
  (`Indian Rupee24,63,840.00`).
- **GST rows** (`tax_breakup`: IGST, CGST, SGST) are read one by one and
  added in code, so a PO printing only CGST and SGST no longer loses its tax.
  A printed tax figure must agree with them.
- **Amount in words** is turned into a number (crore, lakh, thousand,
  hundred, paise, written any of the usual ways) and must equal the total or
  the value before tax. A line it cannot read is ignored, never held against
  the document.

A disagreement is `totals_do_not_add_up`; no new reason.

### 3.3 PO checks (readers §3)

- **Whose reference is whose**: "Your Ref" is ours; "Our Ref", "Our
  Contact", "Buyer", "Budget" are the client's. The client's own number goes
  to `client_reference` and onto the PO's remarks, never taken for our
  quotation (Dasami).
- A line printed on **two rows** (description and code, same amount) is one
  line, when only that adds up (Aragen).
- Payment terms only from the order's own terms block; charges "at actuals"
  go to the PO's remarks.
- **Amendments**: revision wording on the order ("Amendment 1", "Rev 2",
  "Revised", "supersedes") sends it to review. "Rev 0" / "Revision No. 00"
  is the original and does not. A PO number **already registered for the
  same client with another value, or another number or split of lines**
  goes to review as an amendment, with the figures side by side
  ("Registered: INR 24,63,840, 5 lines. This email: INR 26,14,880, 5
  lines."). The same values are still linked.
- "50% Advance Against PI & 50% Against work Completion" now gives 50/50
  stages ("&" is read as "and").

### 3.4 Invoice checks (readers §4)

- `po_reference` only from "Buyer's Order No.", "PO No.", "Order Ref",
  "Work Order No." or "Your Ref"; never "Reference No. & Date", "Other
  References", "Delivery Note" or "Dispatch Doc No." unless they say PO.
- The PO date printed beside it must be the matched PO's date, or the
  invoice goes to review, **po_date_mismatch**, saying both dates.

### 3.5 Splitting a 100% stage (readers §5)

When an invoice is a share of a PO whose only stage is an open 100% one
(Alembic: "50% Advance Payment As Per P.O." against "Against delivery"),
the review item says so and offers **"Split 50% and record"** in
**Payment stages → Invoice review**. One click splits the stage (the share
first, the rest keeping its trigger) and opens the usual invoice dialog on
the new stage; nothing is recorded until it is saved. It is never applied
automatically. The share comes from the invoice's wording, else from the
advance in the quotation's terms.

### 3.6 Client document notes (readers §6)

**Settings → Connections → Client document notes** (admins):

| Field | Meaning |
|---|---|
| Client, Documents | Which client, POs or invoices; one note each |
| Sent from | The client's email domains, to pick the note |
| PO number pattern | A regular expression; a PO number that does not fit goes to review, **po_number_pattern** |
| Labels it prints | e.g. "Work Order No." for the PO number |
| Note for the readers | Up to 500 characters, added to the AI prompt as "Notes on documents from <client>" |

A note is picked before the AI call (no extra call): by the sender's domain,
then the thread's client, then the client's GSTIN in the document. **Saving
a note approves it.** When reviewers settle three of a client's items by
hand in 90 days, the tracker suggests a note; a suggested note is not used
until an admin saves it. Migration 081 seeds notes for the four sample
clients, only where exactly one company in the tracker has that name.

### 3.7 Review-only rollout (readers §7)

**Settings → Mailboxes → Automatic enquiries, POs and invoices →
Review only**:

- **On**: every PO and invoice the readers would register goes to review
  instead, as **review_only**, saying what it would have done ("would be
  registered against CTZ/QT/2026/014", "would be recorded on Advance (50%)
  of PO …"). Compare these with what you enter by hand.
- **Automatic again for**: client names, comma-separated, registered
  automatically while review-only is on.
- **Off**: the readers register as before.

**Migration 082 switches review-only ON when an existing tracker
upgrades**, as the plan ships it (two weeks). A new database starts with it
off. Switch it off on the same screen if that is not wanted.

### 3.8 Fixtures and the accuracy script (readers §7)

- `server/test/fixtures/email-docs/`: the five samples (Alembic PO,
  invoice CVPL/2026-27/037, Aragen PO, Dasami work order, Hindalco PO), each
  with its text, the correct reading and what the checks must make of it.
  `test/emailDocFixtures.test.js` runs them offline. **The text is
  reconstructed from the plan's description of each sample**; replace it
  with the real extracted text (see the README there).
- `npm run readers:accuracy` (in `server/`) reads each fixture with the
  live model (one AI call each) and reports accuracy per field and whether
  the checks agree. Needs `OPENROUTER_API_KEY`.

---

## 4. Demo data (for showing the tracker)

`server/scripts/demo-data.js`, as `npm run demo:data`:

```bash
DEMO_DATABASE_URL=postgres://user:pass@localhost:5432/cetizion_demo npm run demo:data
```

- Drops and rebuilds a **local** database whose name **ends in `_demo`**
  (it refuses anything else) from `schema.sql` and `views.sql`. It **never
  loads `seed.sql`** (the real workbook).
- Fills it through the app's own API: 14 invented companies with contacts,
  17 enquiries, 12 quotations from Draft to Lost (INR, EUR, USD), 5 POs with
  stages, invoices (one overdue), payments, visits, tasks, travel, an
  expense claim, a renewal, exchange rates, and a demo inbox
  (`sales@demo.example.com`, a Sales team inbox, seven client emails, each
  linked to its company and deal by the tracker). Every email address is on
  `example.com`. Dates are relative to the day it runs.
- The automatic readers are left off in the demo database, and the seeder
  clears the AI key for its run: nothing makes AI calls while it is shown.
- It signs in with a login made up for the run, in its own process.

To show it: point `server/.env` at the demo database (`EMAIL_MODE=log`),
`npm run build` in `web/`, start the API, and open http://localhost:4000
(the API serves the built app). Reset it before each demo by running the
script again.

---

## 5. Migrations and settings

| Migration | What it adds |
|---|---|
| 078_receivable_lists | `receivable_lists`, `receivable_list_lines`; settings `receivables_list_phrases`, `receivables_list_senders` |
| 079_po_addressed_to | `purchase_orders.addressed_gstin`, `partner_name`; review reason `wrong_gstin`; settings `company_gstins`, `partner_companies` |
| 080_review_notes | `review_note` on both decision tables; `email_invoice_decisions.split_suggestion`; reason `po_date_mismatch` |
| 081_company_document_profiles | `company_document_profiles`, `document_profile_corrections`; reason `po_number_pattern`; four seeded notes |
| 082_readers_review_only | settings `email_readers_review_only` (on), `email_readers_auto_clients`; reason `review_only` |

The plan named its migrations "077" and "078". **077 is left free** for the
unpushed notification fix (`fix/notification-email-delivery`). The runner
applies pending migrations by name, so the gap is harmless.

New routes, in the access policy and `docs/issue-18-authorization.md`:
`POST /api/payment-stages/invoice-review/:id/split` and the
`document-profiles` resource.

---

## 6. How it was tested

- Server: the full suite, with new tests for every part and for edge cases
  (`briefingEdgeCases`, `readerEdgeCases`, `receivablesList`,
  `misBriefing`, `ourParties`, `readingRules`, `poReading`,
  `documentProfiles`, `emailDocFixtures`, and new cases in
  `emailPurchaseOrders`, `emailInvoices`, `misAiThreads`, `misReportsSql`,
  `misPdf`, `misSend`).
- Type checks (server and web), web unit tests and build.
- CI's migration check: main's database with its seed, upgraded by these
  migrations, has the same schema as a fresh build; a second upgrade does
  nothing.
- In a browser, on the demo data: every screen of the route smoke test
  (including Scheduled reports and Client document notes), and by hand the
  company GSTINs, adding a client note (and a duplicate), the review-only
  switch, the debtors-list settings, PO and project pages, the inbox.
- The daily briefing and weekly MIS PDFs built from the demo data and read
  page by page.

Edge cases found and fixed on the way: Tally's Dr/Cr balances, damaged or
protected spreadsheets, "M/s." names, unconverted amounts shown as ₹0,
"Rev 0" read as an amendment, "… and Ninety Nine Paise", "Paise Fifty",
plural scales, a "(100 %)" stage label, real client names in two examples,
a technical message for a duplicate note, a blank Owner column, and the
weekly report's missing arrow glyph.

---

## 7. Open questions for review

These need a person's decision or information; nothing here blocks the
merge.

1. **Briefing §1 (the schedule)** is not in this branch: Shyam's
   `claude/project-thread-pj2nei` covers it, and both branches merge cleanly
   in either order. If that branch does not go in, §1 needs a branch of its
   own (an earlier one exists locally: `feat/briefing-run-visibility`).
2. **Production checks (briefing §1)** are not code: the read-only queries
   on `pgboss.schedule`, `settings`, `job_runs`, `report_runs` and
   `email_log`, then *Run now* on Settings → Emails & jobs. Someone with
   production access runs them.
3. **Review-only on at deploy** (migration 082): confirm, or switch it off
   after deploy.
4. **The seeded values** in 079 (both GSTINs, the partner and its GSTIN) and
   the four notes in 081: confirm they are right.
5. **The sample documents**: the fixtures' text is reconstructed from the
   plan. With the real PDFs, replace the text and run
   `npm run readers:accuracy` once.
6. **Compare the new briefing PDF with the 03 Oct reference** before merging
   (the plan's order of work, step 4).
7. **Migration numbers**: 078–082 here, 077 kept for the notification fix.
   Renumber at merge if anything else takes these numbers first.
8. Choices made where the plan left room:
   - the vendor block is read as the existing `vendor` field rather than a
     new `addressed_to` (the same thing);
   - a client note's "labels it prints" is plain text, not JSON;
   - "PO not acknowledged" in the reminders means a PO received by email
     and still in review (the tracker has no "acknowledged" mark);
   - the project's primary service stays as today (the quotation's
     services); the plan calls it "the largest line";
   - the day paragraph is written in code; the AI does not reword it.
9. **Not built, as the plan says**: the accounting providers working out
   CGST+SGST or IGST from the issuing GSTIN's state (a separate change).
10. **Seen on the way, not changed (on main)**: the cash-flow page is
    INR-only by design, but its hint says to set exchange rates on the
    sales report; Settings → Mailboxes warns "Microsoft 365 is not set up"
    on a local install (avoid it in a demo).
11. **Two small overlaps with other branches, identical on purpose**: the
    follow-up test fix (`e2b22dd5`, from Shyam's `My Today` branch) is
    included as the same one-line change, so CI passes today and either
    branch merges cleanly first.
12. **The demo-data script** is in this branch because the team needs it
    for the client demo. It can move to its own PR if preferred.
