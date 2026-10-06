# Issue #196: what was built, and how to use it

Issue #196 is the plan for an **HR** role and a bulk import of the travel desk's
records from Excel: trips with their legs, the travel agency's invoices with a
line per leg, its credit and cancellation notes, and the tickets and PDFs behind
them. This branch builds all six phases of it. The product owner's decisions
(§9) are followed throughout.

The code cites the plan by section ("§4.4"). Read the issue side by side with
this guide. The import itself has its own guide: [travel-import.md](travel-import.md).

---

## 1. At a glance

| Plan | What it does now | Where you see it |
|---|---|---|
| §3 HR role | A third role, `hr`, that reaches the travel desk and nothing else. Every other route answers 403. It sees POs and projects only as far as linking a trip needs: PO number, value, currency, client, project, service request no. | Users (admin) → role *HR (travel)*; HR lands on the travel dashboard |
| §4.1 vendors | GSTIN, PAN, contact, email, phone, address, payment terms, **invoice prefixes**. A trip names its vendor (`vendor_id`); the old typed name was matched or made into a vendor | Settings → Travel vendors (admin and HR) |
| §4.2 trips | Project without a PO, staff member, trip type, origin, booking date, cancelled, the payment stage that billed it, a client label for travel that is not a client's | Trips, trip page |
| §4.2a trip types | A Settings list with a chargeable flag: Chargeable, Non-chargeable, Marketing, Internal. In use, a type can be retired but not deleted | Settings → Trip types (admin and HR) |
| §4.2b service request no. | On the project, upper case without spaces, unique. Only used to find a trip's project | Project form |
| §4.3 legs | Flights, trains, buses, cabs and hotel stays; hotel nights are computed | Trip page → Legs |
| §4.4 invoice header and lines | One agency invoice covers several legs, trips and people. Its total follows its lines; payments and credits are shared over the lines | Vendor invoices; invoice page |
| §4.5 credit notes | Credit notes and cancellation notes against an invoice and a leg; recording one marks the leg | Vendor invoices → Credit notes |
| §4.6 documents | Trips and agency invoices hold files, each with a kind (ticket, boarding pass, hotel bill…); the invoice and credit note PDFs sit on the record | Trip page → Documents |
| §4.7 views | Trip cost from invoice lines net of credits; legs, documents, what is missing; project via the PO or directly; profitability counts trips linked to a project directly | Trips list, project profitability |
| §5 the importer | Every tab, columns by name, trips grouped from legs, PO/service request/client linking, invoices with lines, credit notes, red/amber/blue flags with the sales importer's filters and yellow duplicate rows, a Summary step, re-upload recognition, corrections remembered per vendor | Settings → Import travel |
| §5.4 bulk documents | Many files at once, each filed by the number in its name | *Upload documents* on the import review and on Trips |
| §6 dashboard | Trips missing documents; chargeable trips not yet billed; spend by mode and by trip type | Travel dashboard |
| §6 template | A workbook with every column the importer reads | Settings → Import travel → *Download the template* |
| §7 webhooks | `trip.created` and `vendor_invoice.created` when an import commits | Settings → Webhooks |
| §7 MCP | The new travel tables read-only: `search_records` and `aggregate` read them, `import_records` refuses them | MCP |

Migrations: `084_hr_role.sql`, `085_travel_records.sql`, `086_travel_import.sql`.

---

## 2. How to use it

### Give someone the HR role (admin)

Users → add or edit → role **HR (travel)**. They sign in to the travel
dashboard. Their sidebar is: travel dashboard, trips, vendor invoices, credit
notes, payables, and Settings → Travel vendors, Trip types, Import travel.

### Set up the vendors once (HR or admin)

Settings → Travel vendors: add each agency with its GSTIN, payment terms and
**invoice prefixes** (e.g. `HT/2627/, HTT/26-27/`). The prefixes let an upload
find its vendor by itself.

### Import a month (HR or admin)

Settings → Import travel → drop the workbook → review → Commit. See
[travel-import.md](travel-import.md) for the flags and what becomes what.
Then **Upload documents** with the tickets and invoice PDFs, named by their
numbers (`HT-2627-1877.pdf`, `TRV-2026-014-ticket.pdf`).

### Day to day

- **Trips**: a trip's page shows its legs, the invoices and lines that bill it,
  its credit notes and its documents. Edit the trip there; set **Billed in** to
  the payment stage that re-billed a chargeable trip to the client.
- **Vendor invoices**: the invoice page shows its lines (which trip and leg
  each one bills), its credit notes, net payable and payments. *Pay* records a
  payment against the net amount.
- **Travel dashboard**: what still needs a document, and which chargeable
  trips have not been billed to the client.

---

## 3. Before it goes live (deploy checklist)

1. `npm run db:upgrade` in `server/` applies 084–086 and keeps the data
   (`npm run migrate` drops and rebuilds; do not use it on real data).
2. Check the backfill: every old trip has a trip type (Chargeable with a PO,
   Non-chargeable without), every old invoice has one line for its trip, and
   invoices that were entered once per trip with the same number and vendor
   are now one invoice with a line per trip (their payments kept).
3. Add the invoice prefixes to each travel vendor.
4. Give the HR person the role.
5. If a webhook endpoint should hear about imported trips, tick
   `trip.created` / `vendor_invoice.created` on it.

---

## 4. Questions for Shyam

Each one is built the way described, and is a small change if the answer is
different. A reply by number on the pull request is enough.

1. **"Return ticket is cancelled (8,719 deducted)."** The plan says such a
   row marks the leg **cancelled**. Built: the leg is marked **partly
   refunded**, because the leg on that row was flown and only the return was
   not; the charge is still read from the remark. Keep it, or mark it
   cancelled as the plan says?
2. **The service request no. from the import review.** §4.2b says a project
   without one "can be given it from the import review", but §3 and §9.7 give
   HR read-only access to projects. Built: an admin types it on the project
   form, and the next upload matches by itself. Should HR be allowed to set
   this one field from the review?
3. **"Linked by client name: company name or alias."** The tracker has no
   company aliases, so the importer matches the project's client and its
   company's name exactly (ignoring case and spaces): "Megafine" does not find
   "Megafine Pharma Ltd". Do you want an alias list, or is an exact name
   enough?
4. **When an agency invoice falls due.** Vendor bills are paid by the
   month-end after the invoice date (the rule already on `main`, in
   `v_travel_vendor_invoices`). The vendor's new **payment terms** are stored
   and copied onto each invoice, but they do not move that date. Should the
   due date be the invoice date plus the vendor's terms instead?
5. **A return leg with the client column blank** joins the outbound trip when
   it chains (B → A after A → B) within the gap. The plan says rows of the
   "same client / service request / PO" group; built as "nothing saying a
   different one", or every return flight becomes a trip of its own. Agreed?
6. **"Flagged only"** in the review shows items with an amber or red flag. The
   sales importer's also counts blue (information) flags; here almost every
   row has one ("Happy Tours's, by its number"), which would make the filter
   show everything. Agreed?
7. **One pull request.** §8 plans a PR per phase. This is all six phases in
   one PR (one commit for phases 1–3, one for 4–6, then fixes from testing).
   Fine to review as one, or would you like it split?
8. **Your sample workbook.** The importer was built from §1's description of
   `Travel excel sheet.xlsx` and tested on a made-up workbook of the same
   shape (`server/test/fixtures/travelWorkbook.js`); the real file was never
   used. Could you run it through Settings → Import travel on a local or
   staging copy (the review writes nothing until Commit) and note anything
   read wrongly?
9. **Who holds #195 and #196.** Both are assigned to you on GitHub; Sami's
   side built them. Please reassign, or say if you had started either.
10. **Webhooks.** Should HR see Settings → Webhooks to tick `trip.created` /
    `vendor_invoice.created`? Built: no, an admin does.
11. **`ISSUE-PLAN.md`** (§8 phase 6) has not been kept since September and is
    left as it is. Should it be brought up to date?

Decided here, no reply needed unless you disagree:

- **A credit note marks its leg partly refunded, a cancellation note
  cancelled**, the rule the database trigger applies to notes typed in by
  hand.
- **The workbook is kept on the batch** (`import_batches.source_file`) until
  the commit, so a column correction can plan it again later; it goes with
  the commit, or with the draft when the draft is deleted.
- **No AI** in the travel import: rules only, nothing leaves the building.
- **Mode read from a tab's columns** is said once, on the tab, not on every
  row.
- `travel_logs.arranged_by` is kept for one release, as the plan says.
- **Reading invoice PDFs automatically** is out of scope (§5.4), as planned.

---

## 5. Tests

| Test | Covers |
| --- | --- |
| `server/test/travelDesk.test.js` | The HR role's reach and lookups; trip rules (PO and project, billed stage, default type); legs; one invoice over several trips with credits and payments shared; an invoice entered the old way; the trip page |
| `server/test/travelImport.test.js` | The importer end to end on a made-up workbook (`test/fixtures/travelWorkbook.js`) |
| `server/test/authzRoleMatrix.test.js` | An HR user is refused every route not marked for HR, and reaches every route that is |
| `server/test/recordAccess.test.js`, `documentPurge.test.js`, `authzDocs.test.js` | Travel files count as records' files; travel PDFs are not purged; the generated access document is current |

No client data is used by any test.
