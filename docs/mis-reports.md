# The Daily Sales Briefing and the Weekly Sales MIS

The tracker emails management two reports, built from its own records:
the enquiries, quotations, POs, invoices and payments the email readers
and the team have entered. The plan is in
[mis-reports-plan.md](mis-reports-plan.md).

| Report | When | Covers |
| --- | --- | --- |
| **Daily Sales Briefing** | every day at 08:56 IST | the previous day |
| **Weekly Sales MIS Report** | every Monday at 08:54 IST | the previous Monday to Sunday |

Both go to the same recipients, **from the shared sales mailbox** with the
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

## Running and checking

**Reports → Scheduled reports** (admins):

- each report's **on/off switch**, a **preview** of the figures and the
  email as of any date, the **PDF**, and **Send now**;
- the recipients (To, Cc), the **sender mailbox** (a connected shared
  mailbox; otherwise the server's SMTP sender), and the Overdue threshold;
- the **run history**: every report generated, how it went (sales mailbox,
  SMTP, or logged only), to whom, the PDF, and **Resend**.

The schedule sends each period once; Send now and Resend always send. The
two jobs also appear under Settings → Emails & jobs with **Run now**. Every
email goes through the usual switches (`emails_enabled`, `EMAIL_MODE`, the
sandbox allowlist, checked per recipient) and is in the email log. If the
sales mailbox cannot send, the report goes by SMTP and admins are told; if
nothing can send, the run is recorded as failed and an alert is raised.

## Cut-over

Both reports start **off**. For a week, set the recipients to one person
and switch them on beside the Claude routines; every difference should be
explainable from the tracker's records. Then set the real recipients and
switch the two routines off on the claude.ai account. Earlier reports used
fixed rates of USD 88 and EUR 103; these use the rate on each record's date,
and the email says so.
