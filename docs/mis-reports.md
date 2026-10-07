# The Daily Sales Briefing and the Weekly Sales MIS

The tracker emails management two reports, built from its own records:
the enquiries, quotations, POs, invoices and payments the email readers
and the team have entered. The plan is in
[mis-reports-plan.md](mis-reports-plan.md).

| Report | When | Covers |
| --- | --- | --- |
| **Daily Sales Briefing** | every day at 08:56 IST | the previous day |
| **Weekly Sales MIS Report** | every Monday at 08:54 IST | the previous Monday to Sunday |

Both go to the same recipients, **from the chosen sender** (see below) with the
**PDF attached**. The weekly PDF is two A4 pages. The daily PDF follows the
reference briefing ([mis-briefing-fix-plan.md](mis-briefing-fix-plan.md) §3):
at a glance (Metric / Count / Detail), key highlights with their source
email and earlier emails, reminders carried forward (visits and meetings in
the next three days, POs received by email and not registered), every
pending row with its last email (overdue rows in red; invoices in three
tables: to check, to raise, receivables with a grand total), and the top
five actions, over as many pages as that takes. The email carries the same
sections in short; the PDF carries the tables.

## Where the numbers come from

Every figure uses the definition the Reports and Insights pages use, so the
report and the screen agree. Every amount is in ₹ at the exchange rate on
the record's own date; an amount with no rate for its date is listed as
*not converted*, never guessed.

**Daily:** yesterday's new enquiries, quotations sent, POs received (by PO
date; POs registered late are counted separately), invoices raised,
payments received; the three pending tables — invoices (to raise, due or
overdue, in the invoice review queue), POs (quotations awaiting a PO, won
without one, in the PO review queue) and quotations (unquoted enquiries,
sent quotations with no reply) — each row with days waited and **Overdue**
once that passes the threshold (default 7 days, Settings → Scheduled
reports); the **top five actions**, picked by the tracker (days × value, one
per client); and what the email readers made yesterday.

**Weekly:** the eight management questions — enquiries per day with a
table (client, country, sector, service, source, first-response time),
outcomes, sector-wise POs, service-wise sales, customer analysis, invoiced
and received for the week and month to date, receivables over 90 days and
pending follow-ups, and conversion and speed (enquiry → PO %, quote →
contract %, average PO ticket, open pipeline, median first response and
quote-to-PO days).

The first-response time runs from the enquiry (or its first email) to our
first reply. Enquiries the readers made from **our own** quotation or PO
email have none: their response time would be artificial.

## Finance's debtors list

The receivables in the daily briefing are the tracker's (every invoiced
stage not fully paid, aged from its invoice date, with its last reminder,
part payment or promise), reconciled with the Sundry Debtors list Finance
emails ([mis-briefing-fix-plan.md](mis-briefing-fix-plan.md) §3a):

- **Found:** the newest email in a shared mailbox, in the last 14 days,
  from Finance (Settings → Scheduled reports → Finance's debtors list; by
  default anyone at our own domains) whose subject or attachment name has
  one of the words there.
- **Read once:** an Excel file in code; a PDF by the AI, one call, only on
  the scheduled send or a preview that asks for the AI. Every amount must be
  in the file and the rows must add up to the grand total, or the list is
  not used and the briefing says why.
- **Reconciled** client by client: equal amounts match; otherwise both
  figures are shown ("list: 2,44,530; tracker: 2,10,000"); a line only on
  the list is a Finance action, "record in tracker", linked to the list's
  email; a tracker row not on the list says so. Lines under "Pending for
  invoicing" go with the invoices to raise.

With no list in 14 days, or the newest one not used, the receivables are
the tracker's alone, and the line under the table says which.

## What the AI does, and cannot do

With an AI key set, one call per report words what the tracker computed:

- **Daily:** the "Key highlights" from the threads in the
  **shared** mailboxes that store everything (a personal mailbox is never
  read), and the wording of the five actions already chosen.
- **Weekly:** four headline bullets and a short paragraph per section, from
  the figures only.

Everything it returns is checked: a highlight must name one of the threads
given, every number in it must appear in that thread, and every number in
a commentary sentence must be a figure in the report — otherwise it is
dropped. The AI cannot pick different actions or change a figure. Without
an AI, or once the readers' daily AI ceiling is reached, the briefing lists
what the readers made and the MIS uses the Reports page's own sentences.
The report goes either way.

## The personal daily MIS (preview)

Being built (`/mnt/project-files/plans/mis-report-sender-plan.md` Part B). Nothing is sent yet: the
**Personal daily MIS** card on Scheduled reports shows, for one person and day, the facts the report
is written from beside the report the AI writes from them.

* **The facts** (`server/src/lib/misPersonal.js`, `personalFacts`): the person's acts in the tracker
  (activity rows, notes, tasks made and completed, calls and meetings, collection follow-ups, visits
  planned, reassignments), the email they sent and received with clients in their own mailbox, the
  overdue rows that are theirs with **no action yesterday** worked out by code, and their tasks and
  visits for the day. Internal-only mail, automatic replies, bulk mail and blocked senders are left
  out and counted. A body the mailbox does not store is read live and never written back. Every
  fact has an id (`act:…`, `msg:…`, a thread, a pending row's key, `task:…`, `visit:…`).
* **The checks** (`server/src/lib/misAi.js`, `checkPersonal`): a line citing what is not in the
  facts, with a number the cited facts do not carry, or at a time that is not the act's, is
  dropped. Every act and sent email must be cited, every overdue row and every reply owed must be
  there; the AI is asked once more for what it missed, and a report still missing any is refused.
  Wrong counts refuse it. Who owes a reply and "no action yesterday" are code's. Something "in
  email, not in the tracker" is dropped when the tracker has it.
* **Its own AI ceiling**: `personal_mis_ai_limit` (default 30 a day), counted as `mis_personal`,
  apart from the email readers' ceiling.
* **Privacy**: the preview never shows another person's mail text, nor the subject when their
  mailbox shares only metadata.

## Running and checking

**Reports → Scheduled reports** (admins):

- each report's **on/off switch**, a **preview** of the figures and the
  email as of any date, the **PDF**, and **Send now**;
- the recipients (To, Cc) and the Overdue threshold;
- the **Sender**: the mailbox the reports go through (a connected shared
  mailbox, a personal mailbox whose owner allowed it, or the server's SMTP
  sender), an optional **Send as** address and **display name**, a line
  saying what the next report will go from, and **Send a test to me**;
- the **run history**: every report generated, how it went (which From,
  through which mailbox or SMTP, or logged only), to whom, the PDF, and
  **Resend**.

### The sender

- **A shared mailbox** can always send. **A personal mailbox** can only when
  its owner turns on *Allow scheduled reports to be sent from this mailbox*
  on the Mailboxes page; sending from it puts the report in their Sent Items.
- **Send as** (e.g. `mis@`) shows another address in From. Through a
  mailbox, Exchange must grant that mailbox (or the person who connected it)
  **Send As** or **Send on Behalf** on the address; the Microsoft 365 admin
  does this in the Exchange admin centre. Without it Graph refuses, and the
  report goes by SMTP with an alert that says so. By SMTP, the address must be
  `EMAIL_FROM` or one listed in `EMAIL_FROM_ALLOWED`; otherwise the SMTP
  sender uses `EMAIL_FROM`.
- **Send a test to me** sends a short email with a small PDF to the admin
  pressing it, by exactly the reports' path, and says what happened. It
  mails nobody else and records no run.

The schedule sends each period once; Send now and Resend always send. The
two jobs also appear under Settings → Emails & jobs with **Run now**. Every
email goes through the usual switches (`emails_enabled`, `EMAIL_MODE`, the
sandbox allowlist, checked per recipient) and is in the email log. If the
chosen mailbox cannot send — Graph refuses, or the mailbox needs
reconnecting, is disconnected, or its owner withdrew the permission — the
report goes by SMTP, the run says why, and admins are told (at most once a
day). If nothing can send, the run is recorded as failed and an alert is
raised.

## Cut-over

Both reports start **off**. For a week, set the recipients to one person
and switch them on beside the Claude routines; every difference should be
explainable from the tracker's records. Then set the real recipients and
switch the two routines off on the claude.ai account. Earlier reports used
fixed rates of USD 88 and EUR 103; these use the rate on each record's date,
and the email says so.
