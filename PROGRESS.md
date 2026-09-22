# Cetizion Tracker: progress summary

A plain-language account of what has been built, what is being built, and what
is waiting on a decision. Updated with every pull request. Last update:
17 September 2026.

## Where things stand

The tracker holds the company's quotations, projects, purchase orders, payment
stages, invoices and travel spend. The team has logged 47 improvement items on
GitHub. Seven are fixed. Five are being handled by PavithraCJ and shivam-balyan.
Three need a decision from the lead. The remaining 30 are planned in six
batches below, and Sami is working through them in order.

## Delivered

### Bulk import of the sales sheet (issue #45)

**What it does.** An admin uploads the sales Excel sheet. The system turns every
row into the records the site needs, in the same order a person would enter
them: quotation, project, purchase order, payment stages, invoice, money
received. Nothing is written until the admin has reviewed each step and pressed
"Complete and commit".

**How it decides.** Every number and date comes from the rules agreed with the
sales lead in September: ISO work is left out, a won deal needs a PO number,
a missing PO date is the proposal date plus seven days, a missing invoice date
is the PO date plus one day, delivery is six months after the PO once that has
passed, and invoice numbers take the form CVPL / financial year / number.

**Where the AI helps.** The AI reads only the free-text remarks. It picks out
advance percentages ("invoice shared for 20% adv") and points at anything a
person should look at: a client who signed the quote instead of sending a PO,
a second invoice, a PO being revised, two currencies in one remark. It never
calculates anything. On a graded test set of about 1,500 rows across five
workbooks it caught every planted problem and raised no false alarms, three
runs in a row. A sheet takes 10 to 30 seconds and costs under one rupee.

**Duplicates.** Anything already on the site is found by its fixed identifier,
mainly the PO number, never by client name alone, so a shortened name does not
create a second record. Duplicates show in yellow with a choice: keep the
original (the default) or replace it with the sheet. A quotation entered by
hand without its PO gets the PO attached rather than duplicated.

**State.** Built, tested end to end, merged with the team's latest code, and
passing the same checks the deployment pipeline runs. Waiting to be pushed for
review. Three small additions from the issue remain: a downloadable template,
Excel export from lists, and an audit entry per import.

### Batch 1: foundations (done, checkpoint 1)

**Every client once (#20).** The tracker used to hold the client only as
typed text, so "Hindalco Alupuram" and "Hindalco - Alupuram" were two
clients. Now a company record exists once for each client, with its sector,
GSTIN, address and the people we deal with there. Every quotation, enquiry
and project links to it automatically, whatever was typed, and a Companies
page shows everything held per client. Where two spellings slipped through,
the page points them out and merges them in one click.

**Reminders that run on their own (#21).** A worker process now runs
scheduled jobs. Each weekday morning it emails every client with overdue
invoices, once a week at most per invoice, to the billing contact they
named, and sends finance a digest of what to invoice and what is overdue.
Nothing is sent until the server is switched to live; until then every email
is only recorded, and an admin can stop all sending with one switch. Every
email the system composes is kept in a log with its full text.

**Import finished (#45).** A downloadable template, Excel export from every
list, and exports that carry the same filters as the screen.

**Safety nets (#36, #37).** Automated browser tests now sign in, quote a
client, import a sheet and commit it, on every change. The build also scans
dependencies, the container image, the code and the history for known
vulnerabilities and leaked secrets, and proposes dependency updates weekly.

### Batch 2: selling (done, checkpoint 2)

**Quotations are now real documents (#23).** A quotation is priced line by
line from a service catalogue, with GST, a validity date and terms. The
total follows the lines. It can be revised, with each earlier version kept;
turned into a PDF; emailed to the client; and marked accepted. A quotation
sent from the tracker that runs past its validity is marked lost as
expired after a grace period.

**Enquiries are leads (#24).** Each enquiry records where it came from, who
owns it, what it is worth, when to follow up and when the client will
decide. It moves New, Contacted, Qualified, Converted, or is parked or
dropped with a reason. Converting creates the quotation with the estimate
already filled in. Overdue follow-ups and slow first responses are called
out at the top of the page.

**A pipeline board (#25).** Every open quotation sits in a stage with a
probability: Draft, Sent, Negotiation, Verbal yes, On hold. Cards are
dragged between stages; marking one lost asks why. The board shows the
weighted value of the pipeline, a forecast by expected close month, and
the last ninety days' wins and losses with their reasons.

**PO to project in one step (#26).** Registering a PO from a quotation
now creates or joins the project, records the PO against the quotation,
lists the services, builds the payment stages from a saved schedule such
as 50/50 or 30/70, and adds the onboarding checklist with target dates, in
one save. Schedules and checklists are edited under Admin.

**Discount approvals (#46).** A quotation discounted beyond the threshold
set in Settings waits for approval before it can be sent; special terms
can be put up for approval by hand. The approver and the sales person are
emailed.

### Smaller fixes made along the way

- The project page's onboarding checklist can be edited, reordered and extended.
- The sidebar shrinks to icons on narrow screens instead of disappearing, and
  hides only from the menu button.
- Page headers, tabs and card headers wrap on small windows instead of
  squeezing text into one word per line.
- A purchase-order number made only of digits no longer crashes its page.

## Planned, in order

Each batch is five issues. A batch is finished when all five are reviewed.

1. **Foundations.** Finish the import (#45). Companies and contacts instead of
   typed names (#20), so a client exists once. Background jobs and email (#21),
   so reminders can run on their own. Automated browser tests of the main flows
   (#36). Security scanning of dependencies in the build (#37).
2. **Selling.** Quotations with line items, GST, validity and a PDF (#23).
   Enquiries as real leads with sources and follow-ups (#24). A pipeline board
   with probabilities and lost reasons (#25). PO to project in one step with
   payment templates (#26). Discount approvals (#46).
3. **Getting paid.** Tasks, notes and a timeline on every record (#22).
   Collections: due dates, automatic reminders, a chasing log and proper
   payment records (#27). Renewals for recurring services (#28). Cash-flow
   forecast (#40). Notifications and a daily digest (#44).
4. **Client communication.** Microsoft 365 mail on the records (#29). A shared
   sales inbox (#30). One-click email, call and WhatsApp with each contact
   logged (#31). Client acceptance of quotations (#53). Certificates registry
   (#43).
5. **Extended.** Project profitability (#39). Audit scheduling (#42). Client
   portal (#47). Accounting integration and GST/TDS reports (#48). Webhooks and
   n8n (#49).
6. **Platform, with the lead.** Ask-the-tracker for Claude (#50). Error
   tracking and uptime (#38). Staging (#35). Backups with a restore drill (#33).
   Closing the public database port and rotating secrets (#34).

## Decisions needed

- **Rewrite the front end now or later (#17)?** The lead proposes moving to
  Next.js. Until decided, everything is built in the current app; a rewrite
  afterwards would redo that UI work.
- **Server access for the platform items (#33, #34, #35).** The lead's own
  notes rank backups and closing the database port as the most urgent items in
  the whole list. They need access we do not have.
- **Accounts:** an SMTP mailbox for reminders, a Microsoft 365 app registration
  for mail sync, and Cloudinary keys for documents in the local environment.

## Update log

- 2026-09-17: Bulk import merged with the team's latest code (invoice
  documents, migrations on start-up, CI/CD). All checks green. Plan and
  working rules written.
- 2026-09-17: Batch 1 finished (companies, reminders, import extras, browser
  tests, security scanning). Checkpoint 1 tagged locally; nothing pushed yet.
- 2026-09-17: Batch 2 finished (quotation documents, leads, pipeline board,
  one-step PO registration with templates, approvals). Checkpoint 2 tagged.
