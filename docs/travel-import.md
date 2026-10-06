# Travel import

The travel import turns a travel agency's monthly workbook into trips, their
legs (flights, trains, buses, cabs and hotel stays), the agency's invoices with
a line per leg, and its credit and cancellation notes. It reads every tab,
shows a review of everything it would write, and writes nothing until someone
presses **Commit**. The same workbook can be uploaded again as the month fills
in: what is already in the tracker is recognised, and only what is new is
added.

It lives under **Settings → Import travel**. Admins and the HR role only
(issue #196).

---

## Part 1 · Guide

### Importing a workbook

1. **Choose the travel vendor.** The whole workbook is from one agency. Leave
   it blank and the importer finds the vendor from the invoice numbers, using
   the **invoice prefixes** on each vendor under Settings → Travel vendors
   (`HT/2627/`, `HTT/26-27/`).
2. **Upload** the `.xlsx`, `.xls` or `.csv`. Every tab is read (one a month is
   fine), each with its own header row. A tab that is not a travel list, such
   as notes or a pivot, is passed over.
3. **Review**, tab by tab in the page: Tabs & columns → Travellers → Trips &
   legs → Vendor invoices → Credit notes.
4. **Commit.** It is one transaction: either everything ticked is written, or
   nothing is.

Afterwards, **Upload documents** on the review (or on the Trips list) takes
the tickets, boarding passes and invoice PDFs, many at once, and files each by
its name (below).

### Reading the review

| You see | It means | What to do |
| --- | --- | --- |
| A **red** flag | The row cannot be written as it is: no date or traveller, no amount, an amount that is not a number, an invoice number another vendor already has, a hotel stay without a check-out after its check-in, a trip type that is not on the list | **Edit** it, or untick it. Commit stays off until no ticked row has one |
| An **amber** flag | Worth a look: a total that is not fare + service charge + GST (beyond ₹1), GST or the total left blank, a PO that is not in the tracker, a trip linked by client name only, a chargeable trip with no PO or project, a date typed as text, a journey before its booking, the same leg twice | Check it; **Edit** if needed |
| A **blue** flag | What was decided: rows grouped into a trip, a traveller matched by first name, the vendor recognised from the number, a project found by service request no., the mode inferred, cancellation charges read from a remark | Read it, no action needed |
| **In the tracker** | A trip, leg, invoice or note already recorded, from an earlier upload | **Keep the original** (the default) or **Update from the sheet** |
| **Assumed: …** | A value the sheet did not give: the invoice date taken from the booking date, the trip type from the PO link, a blank total worked out | Edit it if you know better; the note goes into the record's remarks |

### What becomes what

- **Travellers.** Each person once, however they were typed ("Asha Rao",
  "asha rao"). Matched to **staff** by name, then by first name when exactly one
  staff member has it. Anyone not on the staff list gets a staff row, or **Edit**
  picks the existing one. The choice is remembered for that spelling.
- **Trips.** Rows of one person, for the same PO, service request or client
  (or none given, as return legs often are), within
  `travel_import_trip_gap_days` days (7 by default, under Settings) and that
  chain on (A → B, then B → A or B → C) are one trip with its legs. A hotel
  or a cab joins the trip it falls in. **Own trip** splits a leg off; **Move
  to…** puts it in another trip of the same person.
- **What a trip is billed to**, in this order: the PO number; else the project
  whose **service request no.** it gives (CV 108 and cv108 are the same); else
  the one open project of the client it names, with an amber flag; else
  nothing, with the client name kept as the trip's client. A PO No. cell
  holding a name ("Megafine Pharma") is read as the client.
- **Trip type.** The sheet's Types column, matched to Settings → Trip types by
  name; a wording that is not a type is red until one is chosen, and is
  remembered for the vendor. With no type given: Chargeable for a trip on a PO
  or project, Non-chargeable otherwise.
- **Mode.** A Mode column if there is one; else the tab's columns (Airlines:
  flight; Check-in or Hotel: hotel; Train or PNR: train; Cab or Vehicle: cab);
  else the tab's name ("Hotels Aug"); else a flight. Hotel rows read Check-in
  and Check-out.
- **Agency invoices.** Rows sharing an invoice number (the "if yes, invoice
  number" column) are one invoice with a line per leg, across legs and people.
  Its total is the sum of its lines; its date is the booking date until the
  PDF says otherwise; its payment terms are the vendor's.
- **Cancellations.** A row whose remark says cancel, or that carries a credit
  note number or an Against Invoice, is a credit note (`…/CN/…`) or a
  cancellation note (`…/CNT/…`) against the invoice it reverses. A
  cancellation note marks the leg cancelled, a credit note partly refunded.
  "Return ticket is cancelled (1,500 deducted)" keeps the leg, reads 1,500 as
  the cancellation charge, and marks it partly refunded.
- **Dates.** Real dates as they are. A date typed with a month's name ("20
  july,22") takes the day and month as typed and the tab's year.

### Correcting a column

Under **Tabs & columns** every header shows what it was read as. Change one
and the workbook is planned again; the correction is remembered for the
vendor, so its next workbook starts from it. Untick a tab to leave it out.
Columns no row fills, the reconciliation columns (Checking, Difference) and
unnamed ones are listed as not read.

### Uploading the workbook again

A leg is recognised by its traveller, date, from and to; an invoice by its
vendor and number; a credit note by its number. Those show **In the tracker**
and are kept unless you choose **Update from the sheet**. A new leg joins the
trip already recorded; a new line goes onto the invoice already recorded. An
updated invoice takes the sheet's lines in place of its own.

### Documents by file name

| File name | Filed as |
| --- | --- |
| `HT-2627-1877.pdf`, `HT_2627_1877 invoice.pdf` | Agency invoice HT/2627/1877: its PDF (a second file goes beside it as an attachment) |
| `HT-2627-CN-349.pdf` | Credit note HT/2627/CN/349: its PDF |
| `TRV-2026-014-ticket.pdf`, `TRV-2026-014 boarding.jpg` | Trip TRV-2026-014, as a ticket or a boarding pass |

The `/` in a number may be written `-`, `_`, a space, or left out. The kind of
a trip's file comes from a word in its name: ticket, boarding, hotel, visa,
approval. Files that name nothing the tracker has are listed back, to attach
from the trip itself. Nothing is read from inside the files.

### The template

**Download the template** gives a workbook with every column the importer
reads (the sheet's columns plus Mode, Trip type, Project ID, Service Request
No., Check-in and Check-out, Provider, PNR, Credit note No., Against Invoice and
Travel ID) and a tab on how to fill it. A workbook made from it needs no
column corrections.

---

## Part 2 · How it works

### Files

| File | Job |
| --- | --- |
| `server/src/import/travel/fields.js` | The fields and the header wordings for each; the header matcher, per tab |
| `server/src/import/travel/parse.js` | Reads every tab: its header row, duplicated and unnamed headers, repeated header rows |
| `server/src/import/travel/plan.js` | The workbook and the tracker's records in, the plan out: travellers, trips, legs, invoices, lines, notes, with flags. Pure |
| `server/src/import/travel/batches.js` | What the plan needs from the tracker for a vendor, the vendor's remembered corrections, storing and loading a batch |
| `server/src/import/travel/commit.js` | Writes a reviewed batch in one transaction, step by step; emits `trip.created` and `vendor_invoice.created` |
| `server/src/import/travel/files.js`, `documents.js` | Which record a file's name names; uploading and filing the files |
| `server/src/routes/travelImport.js` | `/api/import/travel`: upload, review edits, split, duplicates, commit, documents, the template |
| `web/src/pages/TravelImport.jsx`, `TravelImportReview.jsx` | Upload list and the review |
| `web/src/components/TravelDocumentsUpload.jsx` | Many files at once, on the review and the Trips list |

The batches are the sales importer's tables: `import_batches.kind = 'travel'`,
with `vendor_id` and the workbook itself in `source_file` until the commit
(so a column correction can plan it again the next day), and items in
`import_items` with the steps `traveller`, `trip`, `segment`,
`vendor_invoice`, `invoice_line`, `credit_note`. Items refer to each other by
`seq` (`trip_seq`, `invoice_seq`, `segment_seq`). Migration `086`.

### What is remembered

Per vendor, in each batch's `mapping.memory`, merged oldest to newest:
`columns` (a header's meaning), `staff` (a spelling's staff member) and
`tripTypes` (a wording's trip type). Corrections made in a review are saved
with that batch, and a commit saves every traveller's spelling.

### No AI

Nothing leaves the building: the travel import is rules only. The sales
importer's model is not called.

### Access

`requireRole('admin', 'hr')` on the router, mounted ahead of the sales
importer (whose router is administrator-only). Every route is declared in
`server/src/lib/authz/policy.js` as admin and listed in `HR_ROUTES`, so the
role matrix test proves sales users are refused and HR users reach it.

### Tests

| Test | Covers |
| --- | --- |
| `server/test/travelImport.test.js` | Reading the drifting tabs; travellers, grouping, invoices across trips and people, text dates, service requests, a name in PO No., cancellations and charges, trip types and their memory, re-upload recognition, another vendor's number; file names; and on a real database: access, upload, red blocking the commit, commit, the same workbook again writing nothing, splitting a leg, a column correction remembered |
| `server/test/fixtures/travelWorkbook.js` | The made-up workbook those tests read: no client data |

The database part needs `TEST_DATABASE_URL`.
