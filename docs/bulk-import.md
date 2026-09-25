# Bulk import

Bulk import turns a sales spreadsheet into quotations, projects, purchase
orders, payment stages, invoices and receipts. It reads the sheet, shows a
review of everything it would write, and writes nothing until someone presses
**Complete and commit**. The same sheet can be uploaded again whenever the team
updates it: the tracker updates the deals it already has and keeps their
history.

It lives under **Settings → Import** (or search "bulk import"). Admins only.

---

## Part 1 · Guide

### Importing a sheet

1. **Upload** an `.xlsx`, `.xls` or `.csv` file. Any reasonable sales sheet
   works, not just the template: the importer finds the header row and the
   tab that looks most like a sales register, and matches columns by their
   names ("Client Name", "Customer", "PO Recd On", "Amt (₹ L)"...).
2. **Review**, step by step: Quotations → Projects → Purchase orders →
   Payment stages → Invoices & receipts → Summary. Every row shows what will
   be written, and flags anything worth a look.
3. **Commit** on the Summary step. It is one transaction: either everything
   ticked is written, or nothing is.

### Reading the review

| You see | It means | What to do |
| --- | --- | --- |
| A **yellow row**, "Duplicate" | The record is already in the tracker, matched by PO number or quotation number | Nothing, usually. Choose **Keep original** or **Update from sheet** |
| "**Possible** duplicate" | Matched only by client, service and date, so it could be a different deal | Check it; choose **Import as new** if it is a different deal |
| A **blue flag** | Information: how a stage was read, an amount read in lakhs, a note added to the timeline, a reminder set | Read it, no action needed |
| An **amber flag** | Something the sheet says that disagrees with itself or with the tracker | Check it; fix with **Edit** if needed |
| A **red flag** | The row cannot be written as it is, e.g. a currency the tracker does not keep | Fix it with **Edit**, or untick the row. Commit stays off until then |
| **✦** in front of a reading or flag | The AI decided it, because the rules were unsure | Check it before committing |

Filters on each step: status, **New only**, **Duplicates only**, **Errors
only**, and **Flagged only**. If **Complete and commit** is greyed out, the
Summary lists the rows with errors; **Show it** opens them.

### The Summary step

- **What will be written**: counts per record type (new, kept, updated from
  the sheet, unticked).
- **Existing records updated from the sheet**: each one with what changed,
  e.g. "stage Submitted → Under Negotiation; value 450000 → 420000".
- **Added to the deals' history**: notes, follow-up reminders and
  last-contact dates the sheet brings in.
- **How the sheet's deal stages were read**: every wording in the stage
  column and what it was read as. Change any reading and press **Apply and
  read again**; the choice is remembered for that wording. A wording nobody
  understood is shown as "Not understood: choose", and its rows stay out until
  you choose.
- **Rules**, each a switch:
  - a won deal needs a PO number to be imported (agreed with the sales lead; on);
  - leave out ISO proposals (on);
  - deals already in the tracker take what changed in the sheet, when they
    are recognised for certain (on). A won deal is never moved back by a sheet.
- **Read from the tab**: pick another tab of the workbook.
- **Rows left out**, each with its reason, and **Assumptions** made (every
  assumed value is also written into the record's remarks).

### Uploading the updated sheet again

Upload the same sheet each week, or whenever the team updates it:

- Deals written by an earlier upload are recognised (same client and service)
  and take what changed: stage, value, proposal date, contact, salesperson.
- **Remarks** and **follow-up comments** go onto the deal's timeline as notes.
  Text already there is not added again; if the team wrote more after an old
  comment, only the new part is added.
- **Last follow-up** date → the deal's last contact.
- **Next follow-up** date → a follow-up task for the deal's salesperson, which
  the daily reminders pick up. A later sheet with a new date moves the task
  rather than adding a second one; a deal that turns Lost closes it. A date
  already in the past is mentioned, not set.
- Remarks someone wrote in the tracker itself are kept on the timeline before
  the sheet's remarks replace them.

### What is read, and what is not

Read: client, contact, industry, deal stage (and a status-detail column),
service, proposal date, quotation number, quoted value, currency, PO number,
PO date, PO amount, invoice number, amount received, pending amount,
salesperson, remarks, follow-up comments, last and next follow-up dates.

Not read, or not turned into a deal:

- One tab per upload (choose it on the Summary step). An invoices tab or an
  action-tracker tab in the same workbook is not read.
- Early leads with no proposal yet (they belong in Enquiries), won deals with
  no PO number, ISO proposals, and total rows. Each is listed with its reason.
- Columns the importer does not know are ignored; columns holding sign-in
  details (user ID, password) are dropped on upload and never stored or sent.
- A sheet that is not a sales sheet (a project status report, a contact list)
  is refused with the reason, rather than turned into invented deals.
- Currencies other than INR, EUR, USD, GBP, AED and SGD are an error to fix.

### Tips

- Upload the `.xlsx` itself, not a CSV export: Excel writes a CSV with the
  **displayed** values, so an amount shown rounded loses its paise.
- A quotation number in the sheet makes duplicate matching exact.
- A column headed "(₹ Lakhs)", "(Cr)", "(Mn)" or "('000)" is counted in that
  unit, never for a dollar or euro amount.

---

## Part 2 · How it works

### Files

| File | Job |
| --- | --- |
| `server/src/import/parse.js` | Reads the workbook: picks the tab and header row, cleans cells, reads dates (month-first columns detected per column), money (₹/Rs, lakh/crore, currency from the cell format), references with notes ("4501234567 dtd 22.09.2026") |
| `server/src/import/fields.js` | The fields and every header wording for each; the header matcher (`heuristicMapping`), units in headers (`unitOf`), sign-in columns (`SECRET_HEADER`) |
| `server/src/import/stages.js` | Reads a deal-stage wording: company conventions first (e.g. "PO awaited" and "final offer" are negotiations), then the vocabulary; typos and CRM exports ("Closed Won (100%)") included |
| `server/src/import/rules.js` | One row → a plan: which records, duplicates, assumptions, flags, the history to add (`tracking`), what a re-upload changes |
| `server/src/import/ai.js` | The model's three jobs (below) |
| `server/src/import/commit.js` | Writes a reviewed batch in one transaction, including timeline notes, last contact, next step and follow-up tasks |
| `server/src/routes/import.js` | Upload, re-plan, item edits, commit; the snapshot of what the tracker already holds |
| `web/src/pages/BulkImport.jsx`, `ImportReview.jsx` | Upload list and the review |

### The AI, and what it may not do

The AI (OpenRouter, `OPENROUTER_API_KEY`) does three things. Without a key the
importer runs on rules alone and says so ("rules only").

1. **Columns** (`mapColumns`): when a named column is left unplaced and a field
   is still free, the model places it. It may only fill gaps; it never moves a
   column the rules placed.
2. **Deal stages** (`readStages`): a wording the rules read nothing in, or one
   that points two ways or is negated ("Quotation not accepted"), gets the
   model's reading, shown with ✦. Company conventions and the rules decide
   over the model; the admin decides over both. Readings are kept with the
   batch, so **Apply and read again** does not ask twice.
3. **Remarks** (`reviewRows`): flags what free text reveals (an advance
   percentage, a reissued invoice, a remark the figures contradict).

Every number and date that is written is computed in code, never by the model.

### Re-uploads

The latest committed import item for each quotation is the memory of what the
sheet said last time (`import_items.payload.tracking.sheet`). A deal an earlier
upload wrote, with the same client and service, is a certain match; its
changed fields (`status`, `quotation_value`, `currency`, `quotation_date`,
`contact_person`, `sales_person`, `service_quoted`) default the item to
**update** when `update_from_sheet` is on. Notes and follow-up tasks written by
the importer carry the author / `created_by` **Bulk import**, which is how they
are found again.

### Batch rules

Stored on the batch (`import_batches.rules`), defaults in `DEFAULT_RULES`:
`won_requires_po`, `exclude_iso`, `update_from_sheet`, `stage_map` (the
admin's readings), `ai_stage_map` (the model's), plus date offsets, the default
50/50 payment split and 30-day terms.

### Tests

| Test | Covers |
| --- | --- |
| `server/test/importParse.test.js` | Dates, money, references, headers, workbooks, CSV encodings, a messy sheet end to end |
| `server/test/importStages.test.js` | Stage wordings, conventions, negations, the AI reading as a fallback |
| `server/test/importTracking.test.js` | Timeline notes, reminders, re-upload changes, never moving a won deal back |
| `server/test/importAnySheet.test.js` | Through the routes on a real database: a workbook with a summary tab, stage readings, commit, the weekly re-upload cycle, a non-sales sheet refused |

`importAnySheet` needs `TEST_DATABASE_URL`. No client file is used by any test.

### Accuracy (September 2026)

Measured against the three sales sheets the team uses, checked row by row, and
against four sets of stage wordings and headers written independently, the
last of them never used to tune the importer:

| Measure | Result |
| --- | --- |
| The team's three sales sheets, rows entirely right | 481 of 483 (99.6%); 50.9% before this work |
| Unseen stage wordings, with the AI | 97.6% right, none left unread |
| Unseen stage wordings, rules only | 86.8% right, 9.2% shown as not understood |
| 30 synthetic sheets from unseen wordings, rows entirely right, with the AI | 97.6% |

The two rows left on the team's sheets are a convention question: "Proposal
being revised" is read as Under Negotiation; the company's MIS register files
it as Proposal Sent.
