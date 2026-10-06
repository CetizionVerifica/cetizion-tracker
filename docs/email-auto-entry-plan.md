# Quotations, POs and invoices from email, entered automatically: plan

Status: plan, not built. Written against `main` at `eeb8d5d`.

The goal: every quotation we send, every PO a client sends, and every
invoice we send is read from the connected mailboxes, linked to the others
(client → quotation → PO → project → payment stage → invoice), and entered
with its PDF attached, with no typing and no wrong entries.

Most of the pipeline already exists (phase 1 and phase 2, see
[email-enquiries-plan.md](email-enquiries-plan.md) and
[email-po-plan.md](email-po-plan.md)). This plan is about what stops it
from being trustworthy on real documents, shown by the four sample PDFs
the product owner shared, and about the model that reads them.

The design rule stays the same: **the model reads, the code decides.**
Nothing is entered on the model's word alone; every field that changes a
record is checked in code, and anything that fails a check goes to the
review queue instead of the database.

---

## 1. What is already built

| Piece | Where | What it does today |
| --- | --- | --- |
| Mail sync | `lib/mailbox/sync.js`, `autoSync.js`, `microsoft.js` | Every connected mailbox, every folder except Junk/Deleted/Drafts, every 60 s, plus a 365-day backfill. A message moved between folders is read once (Internet Message-ID). |
| Reader queue | `lib/mailbox/readerQueue.js`, table `email_reader_queue` | Live mail is read in the order PO → invoice → enquiry, 8 attempts with backoff, then admins are told. |
| Quotations we send | `autoEnquiry.js`, `autoQuotation.js`, `pdfQuotation.js` | Our outbound quotation PDF becomes a `quotations` row with lines. The printed number is used as `quotation_no` unless it clashes. |
| POs clients send | `autoPurchaseOrder.js`, `poDetect.js`, `pdfPurchaseOrder.js` | Reads the PO, matches a quotation (number → thread → company + value), registers PO, `po_services`, payment stages and project in one transaction, attaches the PDF. Creates a won quotation when none exists. |
| Invoices we send | `autoInvoice.js`, `invoiceDetect.js` | Reads our invoice PDF in sent mail, finds the PO it cites, picks the payment stage by amount, records `invoice_no`/`invoice_date` and attaches the PDF. Waits when the PO is not in yet. |
| Review queues | `routes/poReview.js`, `routes/invoiceReview.js` | Everything that fails a check, with a reason and suggestions. |
| Model call | `lib/ai.js` `chatJSON` | OpenRouter, `temperature 0`, `response_format: json_object`, zero-retention routing (`provider: { data_collection: 'deny', zdr: true }`). Default model `deepseek/deepseek-v4.1-flash` (`OPENROUTER_MODEL`). |
| PDF reading | `readAttachment.js`, `pdfQuotation.js` `pdfText` | Text layer via `unpdf`. If the text is under 50 characters (`SCANNED_BELOW`) the file is sent with the `mistral-ocr` plugin instead. |

So the work is not a new pipeline. It is making the existing one read the
documents correctly and link them reliably.

---

## 2. The sample documents, field by field

### 2.1 What each document is

| Document | Kind | Our GSTIN on it | Key facts |
| --- | --- | --- | --- |
| `Order_3700101318.PDF` | Alembic Pharmaceuticals PO (SAP, 3 pages, text PDF) | UP `09AAKCC0860B1ZY` | PO 3700101318 dated 20/05/2026. "YOUR REF: QTN-04/2026" (our quotation). One service, ₹5,00,000 + IGST 18% ₹90,000 = ₹5,90,000. Delivery 20/06/2026. Terms "Against delivery". Buyer `darshit.shah@alembic.co.in`. Our supplier code there 0011305984. Buyer GSTIN `24AAICA5591M1Z9`. |
| `Alembic_037.pdf` | Our tax invoice CVPL/2026-27/037 | UP `09AAKCC0860B1ZY` | Dated 22-May-26. "Buyer's Order No. 3700101318, Dated 20-May-26". "ECovadis Assessment: 50% Advance Payment As Per P.O." ₹2,50,000 + IGST ₹45,000 = ₹2,95,000. SAC 998311. |
| `PO_ecovadis_2026.pdf` | Aragen Life Sciences service PO (10 pages, 9 of terms) | Delhi `07AAKCC0860B1Z2` | PO 9010018889 dated 03.08.2026. One service printed on **two rows** (a description row and a material-code row, both ₹2,50,000), taxable value ₹2,50,000, IGST ₹45,000, total ₹2,95,000. "Payment Terms: Invoice Date, 45 days". Validity 01.08.2026 to 30.07.2027. Quotation Ref blank. Buyer "Parsharamulu". |
| `Aragen_Life_-Assurance_Invoice.pdf` | Our tax invoice CVPL/2026-27/074 | Delhi `07AAKCC0860B1Z2` | Dated 8-Aug-26. "Buyer's Order No. 9010017766, Dated 4-Apr-26". "Assurance of SR FY26: 100% payment as per P.O." ₹2,40,000 + IGST ₹43,200 = ₹2,83,200. |

Two things stand out:

- **The Aragen invoice is not for the Aragen PO above.** It cites PO
  9010017766 (April), a different job. The system must link it to that PO,
  or wait for it, and must never fall back to "same client, similar
  amount" when the invoice prints a PO number. (Today's code already
  refuses that fallback when a PO is cited; the plan keeps it that way and
  adds a test.)
- **Each client deals with one of our two GST registrations**, and our
  invoice to them comes from the same one: Alembic ↔ UP, Aragen ↔ Delhi.

### 2.2 Mapping to the tracker's entities

**PO → `companies`, `contacts`, `quotations`, `purchase_orders`,
`po_services`, `payment_stages`, `projects`**

| Tracker field | Alembic PO | Aragen PO | Rule |
| --- | --- | --- | --- |
| `companies.name` | Alembic Pharmaceuticals Limited | Aragen Life Sciences Limited | Buyer block, full legal name. |
| `companies.gstin` | 24AAICA5591M1Z9 | 36AABCG3208J1ZT | The buyer's GSTIN, never ours. Found by GSTIN first, then by name. |
| `companies.address` | 1000-Admin Building (APL), Alembic Road, Vadodara 390012 | Plot 28A, Road 15, IDA Nacharam, Hyderabad 500076 | Bill-to block. Only filled when empty. |
| `contacts` | Darshit Shah, `darshit.shah@alembic.co.in` | Parsharamulu (no email) | Buyer named on the PO, else the email sender. |
| `purchase_orders.po_number` | 3700101318 | 9010018889 | As printed. |
| `purchase_orders.po_date` | 2026-05-20 | 2026-08-03 | Day-first; `03.08.2026` is 3 August. |
| `purchase_orders.po_value` | 500000.00 basic, as printed | 250000.00 basic, as printed | **Stored as the total including GST**: a PO that prints only its basic value is grossed up at the quotation lines' own GST rates when it is registered (`lib/purchaseOrders.js`, `grossUp` in `lib/mailbox/autoPurchaseOrder.js`). The client portal works the taxable value and GST back out of it (`po_gst_split`, #198). *Corrected 6 Oct 2026: this row said "taxable value, before GST".* |
| `purchase_orders.currency` | INR | INR | Printed, or INR when both GSTINs are Indian. |
| `purchase_orders.payment_terms_days` | null (default) | 45 | "Invoice Date, 45 days". |
| `purchase_orders.quotation_no` | the quotation printed "QTN-04/2026" | none printed | See §3.4 on printed numbers. |
| `purchase_orders.addressed_gstin` *(new)* | 09AAKCC0860B1ZY | 07AAKCC0860B1Z2 | Which of our registrations, or a partner's, the PO is addressed to. |
| `purchase_orders.partner_name` *(new)* | null | null | Set when addressed to a partner (e.g. Innovative CSR Solutions). |
| `purchase_orders.client_vendor_code` *(new)* | 0011305984 | null | Our supplier code at that client; clients ask for it on invoices. |
| `po_services` | 1 row: EcoVadis consultancy, 500000 | **1 row**, 250000 (two printed rows are one line) | Lines must add up to the taxable value. |
| `projects` | one new project | one new project | **One PO, one project.** |
| `projects.planned_delivery_date` | 2026-06-20 | 2027-07-30 (validity end) | Delivery date, else validity end. |
| `payment_stages` | from the quotation's terms, else the service template (see §3.6) | one 100% stage, `credit_days` 45, unless the quotation says otherwise | The PO's own terms block only, never the general T&C. |
| `documents` | PO PDF attached to the PO | same | Uploaded before the transaction (already built). |

**Our invoice → `payment_stages`**

| Tracker field | Alembic 037 | Aragen 074 | Rule |
| --- | --- | --- | --- |
| PO it belongs to | 3700101318 | 9010017766 | "Buyer's Order No.", "PO No.", "Order Ref", "Work Order No.". Never "Reference No. & Date" or "Other References" unless labelled PO. |
| `payment_stages.invoice_no` | CVPL/2026-27/037 | CVPL/2026-27/074 | As printed. Unique across stages (already enforced). |
| `payment_stages.invoice_date` | 2026-05-22 | 2026-08-08 | `22-May-26` is 2026-05-22. |
| Stage picked | the 50% advance stage (₹2,95,000 gross) | the 100% stage of 9010017766 | Amount first, then the stage hint ("50% Advance", "100% payment"). |
| `payment_stages.document_id` | invoice PDF | invoice PDF | Kept if a document is already there (decided in phase 2). |
| Issuing GSTIN *(checked, not stored)* | 09…1ZY | 07…1Z2 | Must equal the PO's `addressed_gstin`, else review `wrong_gstin`. |

**Our quotation → `quotations`, `quotation_lines`** (already built). Add:
the number printed on the PDF is always kept (§3.4), so a client's
"YOUR REF: QTN-04/2026" finds it.

---

## 3. What has to change

Ordered by how much wrong or missing data each one causes today.

### 3.1 Our invoices are image PDFs, and the reader does not see them (bug)

Both sample invoices are a letterhead and a signature as text, with the
whole invoice table as **one embedded image** (1380×1380 px). Checked with
the app's own extractor (`unpdf`, same call as `pdfText`): each gives
**321 characters**, none of them the invoice number, the PO number or an
amount.

321 is above `SCANNED_BELOW = 50`, so the reader treats the file as a text
PDF and sends the model only the letterhead. The model cannot find an
invoice number, and the invoice ends in review (`no_invoice_no` or
`amounts_not_in_pdf`) or as `not_invoice`. If our invoices are all made
this way, **no emailed invoice is being recorded automatically today**.

Fix:

- Send every document to the model **as the PDF itself** (OpenRouter `file`
  part with the `native` engine), with the extracted text alongside when
  there is any. A vision model then reads the page images and the text
  layer together. This removes the "is it a scan?" guess entirely, and with
  it this whole class of bug.
- Keep `pdfText` for the code checks. For a PDF whose text does not contain
  the document's own number and total (image PDFs like these), the amount
  check against the text cannot run; §3.7 says what replaces it.
- Fixture test: both invoices must read invoice number, date, PO number,
  taxable value, tax and total exactly.

### 3.2 Both GSTINs, and partner companies

Settings hold one `company_gstin`. A PO addressed to the other registration
is refused as `not_to_us`, and an invoice from it as `not_from_us`.

- New setting `company_gstins` (list): `07AAKCC0860B1Z2` (Delhi) and
  `09AAKCC0860B1ZY` (UP). `company_gstin` stays, read as the first entry,
  so the quotation PDF and accounting keep working. Edited on the Settings
  page.
- New setting `partner_companies` (list of `{ name, gstin, aliases }`),
  seeded with Innovative CSR Solutions India Pvt. Ltd. A PO addressed to a
  partner is **not rejected**: it is registered like ours, with
  `partner_name` set and a "Through <partner>" badge.
- One helper `ourParty(party, settings)` → `{ kind: 'us' | 'partner', gstin }`
  or null. Ours are compared by PAN (`AAKCC0860B`, characters 3–12), so
  either registration counts as us. `checkPo` and `checkInvoice` use it.
- `whoWeAre()` names both GSTINs, the PAN and the partners in every prompt.
- Invoice check `wrong_gstin`: issuing GSTIN differs from the PO's
  `addressed_gstin` → review. Clients reject an invoice from the wrong
  registration, so this is worth catching before it is recorded.

### 3.3 One PO, one project, and lines that are printed twice

- One PO always makes exactly one project; every PO line is a `po_services`
  row on it, the largest line is the project's primary service. This is
  today's behaviour; a test pins it.
- The Aragen PO prints one service as two rows with the same amount. Rule
  in the prompt ("a description row and a code row with the same quantity
  and amount are one line") **and** in code: when the lines sum to a
  multiple of the taxable value, merge rows with equal amounts and
  re-check; if it still does not add up, review `lines_not_used`.

### 3.4 The quotation number the client quotes back

The tracker's own series is `CTZ/QT/2026/001`; the Alembic PO quotes
`QTN-04/2026`. A quotation entered by hand, or one whose printed number
clashed, keeps the printed number only in `remarks`, so matching by number
fails and falls through to company + value.

- New column `quotations.printed_no` (indexed, upper-cased): the number on
  the PDF we sent, always kept. Filled from the outbound reader, editable
  on the quotation page, back-filled from the `remarks` text that already
  says "Printed number: …".
- `matchQuotation` step 1 matches `quotation_no` **or** `printed_no`.
- "YOUR REF" / "Your quotation" is ours; "OUR REF", "Our Contact", "Buyer",
  the client's own quotation numbers are theirs and go to a new
  `client_reference` field, never to `our_quotation_ref`.

### 3.5 One structured answer shape

`chatJSON` asks for `json_object` and parses free JSON. Every model listed
in §4 supports strict JSON Schema output.

- Each reader passes its schema (`response_format: { type: 'json_schema',
  json_schema: { strict: true, schema } }`). Missing keys, strings in
  number fields and invented keys become impossible rather than checked
  for.
- Shared shape for money: `{ taxable, igst, cgst, sgst, cess, total,
  total_in_words }`, each as printed or null.

### 3.6 Payment stages when the PO and the invoice disagree

Alembic's PO says "Against delivery", which today makes one 100% stage on
delivery. Our invoice then bills 50% advance, finds no ₹2,95,000 stage, and
goes to review `amount_not_a_stage`.

- When the PO's terms are only a trigger ("against delivery", "invoice
  date, 45 days") and the matched quotation has a percentage split, the
  stages come from the **quotation's** terms; the PO's credit days still
  apply.
- When an invoice prints a percentage ("50% Advance") and the PO has one
  open 100% stage, the review item offers a one-click split: this invoice's
  share recorded, the rest left open. Not automatic, because it changes
  the stages.

### 3.7 Checks that stop a wrong entry

Existing checks stay (confidence 0.85, amounts in the PDF text, totals add
up, currency, dates not after the email, PO number not used by another
client, 2% value tolerance against the quotation, amendments to review).
Added:

- **Arithmetic:** taxable + taxes = total, and taxable × rate = tax, to the
  rupee. Catches a misread digit on image PDFs, where the text check cannot
  run.
- **Amount in words:** Indian words (crore, lakh, thousand, hundred) parsed
  and compared with the total. A line that does not parse is ignored, not
  a failure (Aragen's "… Thousand Paise").
- **Second reading for image PDFs:** when a document has no usable text
  layer, a second model (§4) reads it independently; document number, date,
  PO number and total must agree, or review `readers_disagree`. Cost is not
  the constraint, so this is the cheapest way to make an image read as safe
  as a text read.
- **GSTIN format and checksum** (the 15th character is a check digit) on
  every GSTIN read.
- **Invoice ↔ PO date:** when the invoice prints the PO date, it must equal
  the registered PO's date, or the review item says so.
- **Amendments:** a PO number already registered with a different total or
  lines → review `amendment` with old and new side by side (today it is
  silently `linked`).

### 3.8 Fewer, better model calls

Today every inbound email goes to the PO reader, and anything not a PO then
to the enquiry reader: often two calls per email, each on the full prompt.

- **One triage call per email** (cheap, fast model, §4): classify as
  enquiry, quotation we sent, client PO, our invoice, PO amendment or
  cancellation, payment advice, or other, using subject, body and
  attachment names and first-page text. Then **one** extraction call with
  the right reader, on the strong model.
- Newsletters, notifications and colleague chatter stop at triage, so the
  strong model only sees business documents.
- Each extraction is stored (`email_*_decisions.reading`) so a retry or a
  reviewer's re-check reuses it without a new call (invoices already do
  this; POs get the same).

### 3.9 Linking order and waiting

The order already exists and stays: quotation (sent) → PO (received) →
invoice (sent). An invoice whose PO is not in the tracker **waits**
(`auto_invoice_wait_days`), then goes to review. The Aragen invoice is the
fixture: with PO 9010017766 absent it waits; it must never attach to PO
9010018889.

### 3.10 Seeing that it works

- A **Mail auto-entry** panel on the existing email admin page: per day,
  emails read, entered automatically, sent to review (by reason), waiting,
  failed calls, model spend.
- Every auto-entered record shows "Entered from email" with a link to the
  email and the PDF, and a one-click **Undo** that removes what that email
  created (PO, stages, project, quotation) when nothing has been recorded
  against it since.
- Admins get a daily digest of review items older than two days.

---

## 4. The model

The OpenRouter model list was checked on 2026-10-05
(`GET https://openrouter.ai/api/v1/models` and the per-model `/endpoints`).
Models that take PDF files and images, with strict JSON output, at the top
of the range:

| Model | Input $/M tokens | Output $/M | Context | PDF/image in | Notes |
| --- | --- | --- | --- | --- | --- |
| `anthropic/claude-fable-5.1` | 10 | 50 | 1M | yes | Anthropic's most capable model. Endpoints: Anthropic, Vertex, Bedrock, Azure. |
| `openai/gpt-6-astra-pro` | 10 | 50 | 1.05M | yes | OpenAI's top tier. |
| `anthropic/claude-opus-5.5` | 4 | 20 | 1M | yes | |
| `openai/gpt-6.1-sol` | 2 | 10 | 1.05M | yes | Zero-retention endpoints on Azure. |
| `anthropic/claude-sonnet-5.5` | 2 | 10 | 1M | yes | Zero-retention endpoints on Vertex and Bedrock. |
| `google/gemini-3.8-flash` | 0.75 | 3.75 | 1M | yes | |
| `deepseek/deepseek-v4.1-flash` (today) | | | 1M | **text only** | Cannot see an image PDF without the OCR plugin. |

**Pick for document extraction: `anthropic/claude-fable-5.1`.**

- It is the most capable model on the list, and the request said cost is
  not the constraint.
- It reads the PDF natively, page images and text together, which is the
  fix for §3.1; the current text-only model cannot.
- 1M-token context: a 40-page PO with annexures fits whole, so the terms
  and the schedule of rates are read with the order.
- Strict JSON Schema output (§3.5).
- `lib/ai.js` already handles it: Fable cannot switch reasoning off, and
  the call sets `reasoning: { effort: 'low' }` for it.

**Triage and second reader: `anthropic/claude-sonnet-5.5`.** Fast, reads
PDFs, and has confirmed zero-retention endpoints. As the second reader for
image PDFs (§3.7), a model from another family would disagree more
usefully; `openai/gpt-6.1-sol` (zero-retention on Azure) is the alternative
if Sonnet's agreement rate in the evaluation turns out too close to Fable's
own mistakes.

**One thing to confirm before switching.** The tracker sends every call
with `zdr: true` and `data_collection: 'deny'`, so a model with no
zero-retention endpoint fails to route rather than leaking client data.
From this environment the zero-retention list (`/api/v1/endpoints/zdr`)
came back truncated, and it did not show Fable 5.1 or Opus 5.5 in the part
that loaded. The first build step therefore runs one test call per model
with the production key and `zdr: true`. If Fable does not route, the
order is Opus 5.5, then GPT-6.1 Sol, then Sonnet 5.5, all with the same
privacy settings. The privacy setting is not relaxed to make a model fit.

**Cost, as an estimate:** a one-page invoice as a PDF is roughly 3–5k
input tokens and 1k output, about $0.10 on Fable; a 10-page PO with terms
about $0.35–0.50. Triage on Sonnet is under $0.01 per email. The existing
5,000-call daily ceiling (`auto_enquiry_daily_ai_limit`) stays as a safety stop and
is split into a triage limit and an extraction limit.

Configuration: `OPENROUTER_MODEL` stays for the extraction model; add
`OPENROUTER_TRIAGE_MODEL` and `OPENROUTER_CHECK_MODEL`. `DOCUMENT_MAX_TOKENS`
can rise from 8,192 now that the model accepts 128k output.

---

## 5. Evaluation before anything goes live

1. **Golden set** under `server/test/fixtures/email-docs/`: the four
   sample PDFs, their expected reading (every field in §2.2), and the
   recorded model answer. Add more as reviewers correct entries: every
   review item a person fixes becomes a candidate fixture.
2. **Offline tests** (`node --test`) run the checks and matching on the
   recorded answers: no network, deterministic.
3. **Live script** `npm run eval:email-docs` runs a chosen model over the
   golden set and prints field-level accuracy. A model switch needs 100% on
   PO number, invoice number, dates, totals and GSTINs before it ships.
4. **Shadow run:** two weeks with the new reader writing to the decision
   tables only, compared with what people enter by hand. Then automatic
   entry is turned on.

---

## 6. Build order (one PR each)

| # | Change | Why first |
| --- | --- | --- |
| 1 | ZDR test call per candidate model; golden set and eval script with the four samples | Decides the model and gives every later PR a test that fails first. |
| 2 | Native PDF reading (§3.1) and strict JSON Schema (§3.5) in `readAttachment.js` / `lib/ai.js`; switch the extraction model | Unblocks every emailed invoice. |
| 3 | Both GSTINs and partner companies (§3.2), migration with `addressed_gstin`, `partner_name`, `client_vendor_code` | Unblocks every PO and invoice on the second registration. |
| 4 | `quotations.printed_no` and the reference rules (§3.4) | POs find their quotation by number. |
| 5 | Lines, stages and the split suggestion (§3.3, §3.6) | Alembic- and Aragen-shaped documents register cleanly. |
| 6 | New checks (§3.7) including the second reader for image PDFs | The safety net before turning automatic entry on. |
| 7 | Triage call (§3.8) | Fewer calls, the strong model only on documents. |
| 8 | Auto-entry panel, "Entered from email" link, Undo, digest (§3.10) | People can see and trust it. |
| 9 | Shadow run, then automatic entry on | |

Migrations take the next free number at build time. An unmerged branch
(PR #188) also proposes migrations 077 and 078, so check before numbering.

---

## 7. Out of scope

- Supplier bills sent **to** us and POs **we** issue.
- Payments and remittance advice from email (a later phase; triage will
  already label them).
- Excel or Word attachments; procurement portals that need a login.
- Cancelling a PO from an email: it goes to review.

## 8. Decisions this plan takes (change any before building)

| Question | Default taken |
| --- | --- |
| Extraction model | `anthropic/claude-fable-5.1`, if it routes with zero retention (§4). |
| Image PDFs | Always read natively, and by a second model; disagreement goes to review. |
| Our GSTINs | Both held in settings; either counts as us. |
| Partner companies | Not rejected; registered with the partner named. |
| One PO | One project; every line a service on it. |
| Stages when the PO only says "against delivery" | The quotation's split, with the PO's credit days. |
| Invoice from the other registration than the PO's | Review `wrong_gstin`, not recorded. |
| Automatic entry | Off for two weeks of shadow running, then on. |
