# Email PO and invoice readers: prompt and check improvements (plan)

Status: plan, not built. It extends the readers described in
`email-po-plan.md` (client POs from the inbox, our invoices from Sent Items).
Nothing here adds a new reader; supplier bills sent to us are out of scope.

The model reads, the code decides. Every prompt change below comes with the
check that refuses a wrong reading, and with a fixture test that fails first.

## Decisions taken

| Question | Decision |
|---|---|
| Which invoices? | Our tax invoices to clients (Sent Items), as today. |
| Our GSTINs | Settings holds both: Delhi `07AAKCC0860B1Z2` and UP `09AAKCC0860B1ZY` (PAN `AAKCC0860B`). |
| POs addressed to a partner company (e.g. Innovative CSR Solutions India Pvt. Ltd.) | Not rejected: registered like our own POs, marked as through that partner. |
| Amendment example | The uploaded Dasami work order DL26SW060-1132 ("PO_Dasami_amended.pdf") carries no amendment mark; it is the fixture for an unlabelled amendment. |
| A PO with several services | One PO, one project. Every line is a `po_services` row on that project. |

## What the samples showed

| Document | What it shows | What happens today |
|---|---|---|
| Alembic PO 3700101318 (SAP, 3 pages) | To our UP GSTIN. "YOUR REF: QTN-04/2026" is our quotation. ₹5,00,000 + IGST ₹90,000 = ₹5,90,000. Terms: "Against delivery". Amounts printed with three decimals. Goods boilerplate (COA, batch, marine policy). | Registers with one 100% on-delivery stage. |
| Our invoice CVPL/2026-27/037 to Alembic | From the UP GSTIN. "Buyer's Order No. 3700101318, Dated 20-May-26". "50% Advance Payment As Per P.O." ₹2,50,000 + IGST ₹45,000 = ₹2,95,000. Amount in words printed. | `pickStage` finds no ₹2,95,000 stage: review `amount_not_a_stage`. If `company_gstin` holds the Delhi GSTIN: rejected `not_from_us`. |
| Aragen PO 9010018889 (10 pages, 9 of T&C) | To our Delhi GSTIN. One service printed on two rows with the same ₹2,50,000. "Payment Terms: Invoice Date, 45 days". Dates `03.08.2026`. Words line "…Ninety Five Thousand Paise". | Two lines read, summing to twice the taxable value: `lines_not_used`. |
| Dasami work order DL26SW060-1132 (amended, unlabelled) | Five services, LCA at qty 2. CGST and SGST printed separately, IGST row blank. "Grand Total Indian Rupee24,63,840.00". Terms "50% Advance Against PI & 50% Against work Completion". "Quotation No & Date DL26SWR60-1317" is the client's own number. Vendor GSTIN blank. | When the PO number is already registered: silently `linked`; the changed value and lines are lost. Otherwise the client's quotation number is taken for ours and the match fails. |
| Hindalco PO 13522317007 (Oracle, 4 pages) | Vendor: Innovative CSR Solutions India Pvt. Ltd., GSTIN `07AACCI8342L1ZA`. "Our Contact: Amal E" is Hindalco's person. Buyer GSTIN `32AAACH1201R1ZW` only at the foot. Dates `08-AUG-2026`. "Within 30 Days from the invoice date". Annexure: travel extra at actuals. | Rejected `not_to_us`. |

## Work, in order

### 1. Our GSTINs and partner companies (settings, migration 077)

- Setting `company_gstins`: a list of our GSTINs. `company_gstin` stays and is
  read as the first entry, so existing readers keep working.
- Setting `partner_companies`: a list of `{ name, gstin, aliases[] }`, seeded
  with Innovative CSR Solutions India Pvt. Ltd. / `07AACCI8342L1ZA`. Edited on
  the Settings page.
- `whoWeAre` (promptRules.js) names both GSTINs and the PAN, and the partners:
  "We also take orders through our partners …; an order addressed to one of
  them is an order to us. Say which party it is addressed to."
- One helper, `ourParty(party, settings)`, returns `{ kind: 'us' | 'partner',
  gstin, name }` or null. GSTINs are compared by PAN (characters 3 to 12) for
  us, and in full for a partner. `checkPo` and `checkInvoice` use it in place
  of today's single-GSTIN comparison.
- Migration `077_po_addressed_to.sql`:
  - `purchase_orders.addressed_gstin text`: the GSTIN the client addressed
    the PO to (ours, or a partner's).
  - `purchase_orders.partner_name text`: set when it was a partner.
  - `email_invoice_decisions` and `email_po_decisions` review reasons gain
    `wrong_gstin`.
- Registration copies both onto the PO. Partner POs show a "Through
  <partner>" badge on the PO and project pages.
- Invoice check `wrong_gstin`: an invoice whose seller GSTIN differs from the
  PO's `addressed_gstin` goes to review. Clients reject an invoice raised from
  the wrong registration. For a partner PO the invoice is the partner's, so
  the seller is the partner.
- Follow-up, separate change: `lib/accounting/providers.js` works out
  CGST+SGST or IGST from one state code. With two registrations it should use
  the issuing GSTIN's state.

### 2. Shared reading rules (promptRules.js)

- Dates: also `03.08.2026`, `08-AUG-2026`, `25-03-2026`, `22-May-26` (month
  name, two-digit year is 20YY).
- Amounts: an amount may be printed with three decimals (`500,000.000`) or
  glued to its label (`Indian Rupee24,63,840.00`); copy only the number.
- Taxes: new shared shape `tax_breakup: { igst, cgst, sgst }`, each as
  printed or null. Code adds them; a blank row is null, not 0.
- `total_in_words`: the amount-in-words line as printed. Code converts Indian
  words (crore, lakh, thousand, hundred, paise) to a number and requires it to
  equal the total. A line it cannot convert (Aragen's "… Thousand Paise") is
  ignored, never a failure.

### 3. PO prompt and checks (poDetect.js, pdfPurchaseOrder.js, autoPurchaseOrder.js)

Prompt:
- Whose reference is whose: "Your Ref" / "Your quotation" is ours; "Our
  Ref", "Our Contact", "Buyer", "Budget", "Reference: …" belong to the
  client. `our_quotation_ref` only when it is our numbering or the email
  cites it; anything else goes to a new field `client_reference`.
  "Our Contact" is the client's person (Hindalco).
- `addressed_to: { company_name, gstin }`: the vendor block, as printed.
- Lines: a line printed on two rows (a description row and a code row with
  the same quantity and amount) is one line. The lines must add up to the
  taxable value.
- Payment terms only from the order's own terms block, never the general T&C
  or goods boilerplate. "Extra at actuals" clauses go to `remarks`.
- `revision_marks`: any amendment, revision or suffix text as printed.

Checks:
- A PO number already registered for the same client, with a different
  total, line count or line values: review `amendment`, with the old and new
  values side by side. Today it is `linked`. Same number, same values: still
  `linked`.
- `total_in_words` and `tax_breakup` checks from §2.
- One PO, one project: every line becomes a `po_services` row (Dasami: five
  rows, LCA ₹2,16,000 at qty 2). The project's primary service is the largest
  line. This is today's model; the fixture pins it.

### 4. Invoice prompt and checks (invoiceDetect.js, autoInvoice.js)

Prompt:
- `po_reference` labels: "Buyer's Order No.", "PO No.", "Order Ref", "Work
  Order No.", "Your Ref". Never the "Reference No. & Date", "Other
  References", "Delivery Note" or "Dispatch Doc No." boxes unless they say PO.
- `po_date`: the date printed beside that number.
- `issuing_gstin`, `tax_breakup`, `total_in_words`.
- Example number `CVPL/2026-27/037`.

Checks:
- `wrong_gstin` (§1), `total_in_words` (§2).
- `po_date`, when printed, must equal the matched PO's date, or the review
  item says so.

### 5. When the PO's terms do not match the invoice (Alembic)

When the result is `amount_not_a_stage`, the stage hint carries a percentage
("50% Advance"), and the PO has one open 100% stage, the review item offers a
split: this invoice's share recorded, the rest left open. The quotation's
terms are used when the PO only says "Against delivery". Never applied
automatically; one click in invoice review accepts it.

### 6. Per-client document profiles (migration 078)

Table `company_document_profiles`:
- `company_id`, `doc_type` (po | invoice)
- `sender_domains[]`, `po_number_pattern`, `label_aliases jsonb`, `hint text`
  (at most 500 characters)
- `approved_by`, `approved_at`

How it is used:
- Picked before the model call by sender domain, a GSTIN in the PDF text,
  or the thread's company. No extra AI call.
- Added to the prompt as "Notes on documents from <client>".
- A PO number that does not fit the pattern goes to review.
- Reviewer corrections are stored. After repeated corrections for the same
  client, a hint is suggested and an admin approves it.

Seed profiles:

| Client | PO number | Notes |
|---|---|---|
| Alembic | `^37\d{8}$` | SAP; three-decimal amounts; goods T&C to ignore. |
| Aragen | `^90\d{8}$` | Two-row lines; nine pages of T&C. |
| Dasami | `^DL\d{2}SW` | Work orders; its own quotation numbers. |
| Hindalco / Aditya Birla | `^\d{11}$` | Oracle; addressed to our partner; buyer GSTIN at the foot. |

### 7. Tests and rollout

Fixtures under `server/test/fixtures/email-docs/` hold the extracted text, the
expected reading and a recorded model answer for each document:

| Fixture | Pins |
|---|---|
| Alembic PO | UP GSTIN; our quotation from "YOUR REF"; one on-delivery stage. |
| Invoice 037 | UP GSTIN; `po_reference` 3700101318; split suggestion against that PO. |
| Aragen PO | Delhi GSTIN; one line; credit days 45. |
| Dasami work order | Five services; CGST+SGST; 50/50 stages. Registered once and read again with a changed value: `amendment` review. |
| Hindalco PO | Partner PO registered with `partner_name`; Amal E as client contact; credit days 30. |

Offline tests run the checks on recorded answers (`node --test`). A script
runs the live model over the fixtures and reports accuracy per field.

Rollout:
1. Ship with the new prompts in review-only mode for two weeks.
2. Compare against entries made by hand.
3. Turn automatic registration back on, per client.
