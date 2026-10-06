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
| §5 the importer | Every tab, columns by name, trips grouped from legs, PO/service request/client linking, invoices with lines, credit notes, red/amber/blue flags, re-upload recognition, corrections remembered per vendor | Settings → Import travel |
| §5.4 bulk documents | Many files at once, each filed by the number in its name | *Upload documents* on the import review and on Trips |
| §6 dashboard | Trips missing documents; chargeable trips not yet billed; spend by mode and by trip type | Travel dashboard |
| §6 template | A workbook with every column the importer reads | Settings → Import travel → *Download the template* |
| §7 webhooks | `trip.created` and `vendor_invoice.created` when an import commits | Settings → Webhooks |

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

## 4. Choices made, and open questions

Made here, for the lead to confirm:

1. **"Return ticket is cancelled (8,719 deducted)"** marks the leg **partly
   refunded**, not cancelled: the outbound leg was flown. The plan says
   "cancelled"; a cancellation note on the leg still marks it cancelled.
2. **A credit note marks a leg partly refunded**, a cancellation note
   cancelled — the same rule the database trigger applies to notes typed in by
   hand.
3. **A return leg with the client column blank joins the trip** of the
   outbound leg, if it chains and falls within the gap. The plan's "same client
   / service request / PO" is read as "nothing saying another one".
4. **Client-name linking** compares the project's client and its company's
   name. The schema has no company aliases, so "Megafine" does not find
   "Megafine Pharma Ltd".
5. **The service request no. cannot be set from the import review**: HR does
   not write projects (§9.7). An admin types it on the project, and the next
   upload matches by itself.
6. **The workbook is kept on the batch** (`import_batches.source_file`) until
   the commit, so a column correction can re-plan it later. It is removed on
   commit, and with the draft when the draft is deleted.
7. **No AI** in the travel import: rules only, nothing leaves the building.
8. **Mode inferred from the tab's columns** is said once, on the tab, not on
   every row.
9. `travel_logs.arranged_by` is kept for one release, as the plan says, and
   can be dropped after.
10. `ISSUE-PLAN.md` has not been kept since September and is left as it is.

Open:

- Should HR see **Settings → Webhooks**? Not now; an admin ticks the events.
- Reading invoice PDFs automatically (like the email PO reader) is out of
  scope (§5.4), as planned.

---

## 5. Tests

| Test | Covers |
| --- | --- |
| `server/test/travelDesk.test.js` | The HR role's reach and lookups; trip rules (PO and project, billed stage, default type); legs; one invoice over several trips with credits and payments shared; an invoice entered the old way; the trip page |
| `server/test/travelImport.test.js` | The importer end to end on a made-up workbook (`test/fixtures/travelWorkbook.js`) |
| `server/test/authzRoleMatrix.test.js` | An HR user is refused every route not marked for HR, and reaches every route that is |
| `server/test/recordAccess.test.js`, `documentPurge.test.js`, `authzDocs.test.js` | Travel files count as records' files; travel PDFs are not purged; the generated access document is current |

No client data is used by any test.
