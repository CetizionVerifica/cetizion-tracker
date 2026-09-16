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
