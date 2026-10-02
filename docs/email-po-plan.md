# Purchase orders and invoices from email, automatically: implementation plan (phase 2)

Phase 1 ([email-enquiries-plan.md](email-enquiries-plan.md), built in #163)
turns client email into **enquiries**, and turns the quotation PDFs we send
into **quotations**. Phase 2 closes the loop.

When a client sends a **purchase order**, it is registered in the tracker.
The client may send a PO, work order, LOI or signed contract, as a PDF or
in the body. Registering it means:

- the PO itself, with its services and payment stages;
- the project;
- the original PDF, attached;
- the quotation marked won.

When **we** send a client an **invoice** by email for a PO or a project, it
is **recorded against the right payment stage** (invoice number and date),
and the invoice PDF is **uploaded** to that stage (§3.10).

This covers past mail too: the last 365 days of every connected mailbox.

This file is written for the person (or Claude Code session) who builds it.
Read [PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md) and
[email-enquiries.md](email-enquiries.md) first. The plan follows the two
design rules: nothing derived is stored, and each fact is typed in one
place. It was written against commit `fd93cc1`.

---

## 0. Carried over from phase 1, and assumed unchanged

These phase 1 decisions also hold here:

- Every active connected mailbox is read.
- Emails are judged by rules first, then AI (OpenRouter, zero-retention
  routing).
- Past mail goes back 365 days.
- It is fully automatic, on by default, with one admin switch to turn it
  off.
- A metadata-only mailbox still stores no email text.

The new decisions are in §9; each has a default the build can start from.

---

## 1. What already exists, and why it is not this

| Existing piece | File | What it does | Why it is not this feature |
| --- | --- | --- | --- |
| PO registration | `server/src/routes/register.js` `POST /api/quotations/:key/register` | In one transaction: project (new or joined), quotation → `Won - PO Received`, PO, `po_services` split from the quotation lines with GST gross-up, payment stages from a terms template, `po_registered` notification, onboarding checklist. | A person must open the quotation and fill the dialog. Nothing reads the client's PO. It does not refuse a quotation that already has a PO; only the UI hides the button. It compares PO numbers as exact text, so "PO-123" and "po 123" both get in. |
| Phase 1 detector | `server/src/lib/mailbox/enquiryDetect.js`, `autoEnquiry.js` | Judges inbound mail as a new enquiry, and outbound mail as a quotation we sent. | It has **no purchase-order kind**. A "PO attached" email is judged `reply_or_followup` or `other`, logged `not_enquiry`, and never looked at again (`UNIQUE(account_id, provider_id)`). It skips replies and later messages in a thread, which is exactly where most POs arrive. **Inbound attachments are never opened.** |
| PDF reading | `server/src/lib/mailbox/pdfQuotation.js`, `autoQuotation.js` | `unpdf` text extraction, OCR fallback (`mistral-ocr` plugin), checks in code (`parseAmount`, `amountInText`, `near`), document upload before the transaction. | Built for **our** quotation layout. A client's PO is a different document, with buyer and vendor reversed. |
| PO number in mail | `rules.js` `referencesIn().pos` | Matches only `PO-123`-style numbers in a subject. | Real PO numbers are `4500012345`, `PO/2026/12`, `WO-HR-0091`. These are missed. |
| Import rules | `server/src/import/parse.js`, `import/ai.js`, `import/rules.js` | `splitReference` (PO number + "dtd" date), `parseMoney`/`readCurrency` (lakh/crore), `advanceShare` (advance %, ignoring GST and TDS), the advance/delivery split, PO-number normalisation (`norm`). | Written for the bulk importer. They are the right rules, but not wired to email. |
| Payment terms | `payment_terms_templates`, `services.payment_terms_template_id` | 50/50 (default), 100% on delivery, 30/70, 20/80. | The PO's own terms text is never read. |

**Summary:** registration, PDF reading and the email pipeline all exist.
Phase 2 needs four things:

- **(a)** recognise a PO email, wherever it sits in a thread;
- **(b)** read the client's PO document;
- **(c)** match it to the right quotation, or to nothing;
- **(d)** call registration safely, including for POs that are months old.

---

## 2. Scope

### In scope

1. **PO detection** on inbound mail, including replies in existing
   threads.
2. **Reading the PO:** open the inbound PDF attachment (only for PO
   candidates), extract the PO fields, and check them in code.
3. **Matching** the PO to a quotation, using the quotation number, the
   thread, the company and the value.
4. **Registering** through one shared `registerPurchaseOrder()` function,
   extracted from `register.js` and used by the route and by automation.
5. **Payment stages from the PO's own terms**, when they can be read.
6. **Duplicates and revisions:** the same PO in two mailboxes, a re-send, a
   PO already registered by hand, or an amended PO.
7. **Historical POs** from the 365-day backfill, registered without
   flooding Collections, notifications, onboarding or webhooks (§3.8).
8. **A review queue** for PO emails that could not be registered safely,
   with one-click registration against a suggested quotation.
9. **Invoices we email to clients** (§3.10). Read the invoice PDF in our
   sent mail, match it to the PO and payment stage, record the invoice
   number and date, and upload the PDF to the stage. This includes past
   invoices from the 365-day backfill.
10. Admin switch, status, filters, banners, tests and docs.

### Out of scope (say so in the PR)

- POs **we** issue to vendors. Outbound mail is not read for POs.
- Cancelling a PO from a cancellation email. A review item is raised
  instead (§3.6).
- **Payments** and remittance advice from email. That is a later phase.
  Invoices **are** in scope (§3.10).
- Proforma invoices, credit notes and cancelled or revised invoices are
  never recorded automatically (§3.10.5).
- Procurement portals that need a login (Ariba, Coupa, Jaggaer). Only the
  email notification they send is read (§3.1).
- Reading Excel or Word PO attachments. PDFs and the email body only.

---

## 3. How it works

### 3.1 Which emails are PO candidates (pure rules)

This is a new function, `poPrefilter(message, facts)`, in a new pure module
`server/src/lib/mailbox/poDetect.js`. It runs on **every inbound
message**, not just the first one in a conversation. A message is a
candidate when:

| Rule | Why |
| --- | --- |
| Inbound, from an external address | POs come from clients. |
| **PO words** in the subject, the new body text or an attachment name: purchase order, PO, P.O., work order, WO, service order, LOI, letter of intent, letter of award, contract, order confirmation, "we are pleased to place", "please find attached our order" | How clients say it. |
| **and** at least one of: a PDF attachment; a PO-number-like token near the words; or a known procurement-portal sender (below) | Words alone ("we will send the PO next week") are not a PO. |
| Not bulk mail, and not a payment or remittance advice (`remittance`, `payment advice`, `UTR`, `credited`) | Those mention PO numbers too. |
| Not already decided for PO (`email_po_decisions`, §4) | Idempotent. |

- **Procurement portals:** PO notifications from senders such as
  `*@ansmtp.ariba.com`, `*@coupahost.com` and `*@jaggaer.com` are
  automated, and `isBlocked()` would drop some of them. Add a
  `po_portal_senders` setting (comma-separated patterns, seeded with
  these). The PO pipeline treats these senders as candidates even when
  the general sync would skip them as robots.
- **Wider PO-number matching:** add a `poNumbersIn(text)` function, used
  for matching and duplicates only, not for the phase 1 "names a record"
  rule. It recognises tokens after "PO No", "Order No", "WO No", "P.O.
  Number", "Contract No" and similar labels, using the same idea as
  `splitReference`.

The phase 1 detector is changed in one place:

- add `purchase_order` to `KINDS`;
- in `prefilter`, when `poPrefilter` says candidate, return `{candidate:
  null, reason: 'purchase order'}`.

That way a PO email is never logged as a `not_enquiry`, and no enquiry is
made from it.

### 3.2 Reading the PO

Use the same steps as `autoQuotation.prepare`, but with a PO prompt and PO
checks:

1. **Attachment:** `provider.attachments(providerId)` (phase 1). Keep PDFs
   of at most 15 MB. Rank them: a file name with PO, order, WO, LOI or
   contract first; then first-page text with "Purchase Order"; then the
   largest. Terms-and-conditions annexures come last.
2. **Text:** `pdfText` (unpdf), at most 10 pages. With fewer than 50
   characters, use OCR, as in phase 1. If there is no PDF, use the email
   body (portal notifications and "please treat this mail as our PO").
3. **One AI call** (`chatJSON`) that returns:

```jsonc
{
  "is_purchase_order": true, "document_type": "purchase_order | work_order | loi | contract | amendment | cancellation | other",
  "confidence": 0.0-1.0,
  "po_number": "4500012345", "po_date": "2026-09-22",
  "amendment_no": 0,                       // "Amendment 1", "Rev 2"
  "buyer":  { "company_name": "…", "gstin": "…", "state": "…", "contact_name": "…", "contact_email": "…" },
  "vendor": { "company_name": "…", "gstin": "…" },   // must be us
  "our_quotation_ref": "CTZ/QT/2026/045",  // "Ref: your offer no. …", or null
  "currency": "INR",
  "lines": [ { "description": "…", "qty": 1, "rate": 250000, "amount": 250000, "service": "EcoVadis" } ],
  "basic_value": 250000, "tax_value": 45000, "total_value": 295000,
  "gst_extra": false,                      // "GST extra as applicable"
  "payment_terms_text": "50% advance against PI, balance on submission of report",
  "credit_days": 30,
  "delivery_date": "2026-11-30",
  "project_manager": { "name": "…", "email": "…" }
}
```

4. **Checks in code** (pure, in `poDetect.js` / `pdfPurchaseOrder.js`). The
   model proposes and code decides:

| Check | Rule (failure → review queue, §3.7) |
| --- | --- |
| **It is addressed to us** | `vendor.company_name` matches our company (`company_name` setting) or our GSTIN (`company_gstin`), or the PDF text contains either. A PO to someone else, or a PO we issued, is rejected. |
| **The buyer is not us** | `isUs(buyer)` is false. |
| **There is a PO number** | It is present, at least 3 characters, and not "Awaited", "Verbal" or "TBD" (reuse `splitReference`'s refusal list). Store it as printed. Compare it **normalised**: lowercase, alphanumerics only, as `import/rules.js` `norm` does. |
| **Dates** | `po_date` is on or before the email date and no more than 365 days earlier; otherwise the email date is used and flagged. |
| **Amounts are real** | Every amount used must appear in the PDF text (`amountInText`). Indian grouping is parsed by `parseAmount`/`parseMoney`. |
| **Lines add up** | `sum(lines) ≈ basic_value`, and `basic + tax ≈ total`, each within ₹1 or 0.5% (`near`). |
| **Currency** | One of the tracker's currency codes. `register.js` does not check this today; the shared function will (§3.5). |
| **Confidence** | At least `auto_po_min_confidence` (default **0.85**, higher than for enquiries: a wrong PO moves money). |

### 3.3 Matching the PO to a quotation

These run in order, and the first that gives **exactly one** quotation
wins:

| # | Signal | Rule |
| --- | --- | --- |
| 1 | **Quotation number on the PO** | `our_quotation_ref`, or any `referencesIn().quotations` hit in the PDF text or email, exists in `quotations`. This includes printed numbers kept by phase 1 for PDF quotations. |
| 2 | **The thread** | The email's thread is linked to a quotation (`email_threads.entity = 'quotation'`), or the conversation holds our outbound quotation email (phase 1 decision with `quotation_no`). |
| 3 | **Company, then value** | The buyer resolves to a company: by GSTIN (`companies.gstin`), else the sender's contact or domain (`matchParticipants`), else `name_key`. That company's quotations that are **not** won or lost and have no PO are the candidates. One candidate whose value matches the PO (either total incl. GST, or subtotal against basic value) within `auto_po_value_tolerance_percent` (default 2%) wins. If there is exactly one candidate in total, it wins **only** when its value also matches. |

The PO must also be **consistent** with the quotation it matched:

- The quotation's company must be the buyer's company. A GSTIN mismatch,
  where both are known, means review.
- A quotation already `Won - PO Received` **with a PO** is not matched
  again; see duplicates in §3.6.
- **Value must agree (decided).** The PO's value must be within
  `auto_po_value_tolerance_percent` (**2%**) of the quotation it matched.
  This applies however the match was made, including by quotation number
  or thread. Compare like with like:
  - the PO total incl. GST against the quotation `total`;
  - the PO basic value against the quotation `subtotal`;
  - if the PO says "GST extra", its basic value against the quotation
    `subtotal`.

  A larger difference **never registers automatically**. It goes to
  review with `value_mismatch`, showing both values and the difference.
  Partial POs, scope changes and negotiated discounts arrive this way, and
  a person decides. The reviewer can still register at the PO's value
  with **Register against…**.
- **No match.** The buyer is a known company with open quotations, but
  none fits: send it to **review**, with those quotations suggested.
- **No quotation at all.** Nothing on file fits. **Decided:** create the
  quotation and an enquiry from the PO, then register (§9, decision 1).
  There is no quotation to compare against, so the 2% value rule does not
  apply here. This keeps reports complete for work quoted outside the
  tracker or before it existed.
  - The quotation is `Won - PO Received`, with lines from the PO (or
    totals only, as phase 1 does).
  - Its `quotation_date` is the PO date.
  - The enquiry is `Converted`, with source **Existing client** if the
    company has an earlier PO, else **Other**.
  - Both are marked as read from email.

### 3.4 Payment stages from the PO's terms

1. Run `payment_terms_text` through the importer's `advanceShare()`, which
   already ignores GST and TDS percentages and returns "unclear" when
   there are several.
2. Map the result with the importer's split rule:
   - **x% advance** gives two stages: x% `On PO Registration` and
     (100−x)% `On Delivery`;
   - **"100% after completion"**, **"on submission of report"** or **"on
     delivery"** give one stage: 100% `On Delivery`;
   - **two or three explicit milestones** that sum to 100% give one stage
     each: `On PO Registration`, `On Milestone` (named after the
     milestone) and `On Delivery`.
3. `credit_days` from the PO ("within 30 days of invoice") becomes
   `payment_terms_days`, defaulting to 30.
4. If the terms are unclear, use the template that registration would pick
   today: the service's template, else the default. Flag the PO: "Payment
   stages are the default; the PO says: *terms*". The PO's terms text
   itself is kept in the PO's `remarks`, since it is a fact the client
   typed.

Stages must total exactly 100%. This is checked in code before insert, as
`register.js:192` does.

### 3.5 Registering

**Extract** the body of `POST /api/quotations/:key/register` into
`server/src/lib/purchaseOrders.js` `registerPurchaseOrder(db, input, {
actor, mode })`. This mirrors what phase 1 did with
`createEnquiryFromEmail`. The route keeps its behaviour and response, and
gains three guards that automation needs and the UI only implied:

- **Refuse a quotation that already has a PO.** Raising another PO on the
  same won work goes through the existing CRUD route on the project.
- **Normalised duplicate check on the PO number.** "PO-123" and "po 123"
  are the same.
- **Validate the currency** against the enum.

What automation passes in:

| Input | Value |
| --- | --- |
| `po_number`, `po_date`, `currency` | From the PO, after the checks. |
| `po_value` | **Total including GST**. This is the tracker's convention: revenue = PO value incl. GST (reports plan). If the PO states only a basic value and "GST extra", gross it up with the quotation lines' GST rates (default 18%). The PO's remarks say "Value grossed up for GST; the PO states basic *x*". |
| `payment_terms_days`, stages | From §3.4. Pass explicit stages, a new input alongside `payment_terms_template_id`. |
| `document_id` | The PO PDF, uploaded with `uploadDocument({ owner: 'purchase-orders' })` before the transaction, then locked and claimed inside it. Unattached uploads are purged after a day, so an aborted registration leaves no orphan. |
| Project | The quotation's project if it has one (from `/convert`), else a new project numbered by the **PO date's year**. Today's route uses the current year, which is wrong for a backfilled PO; fix it in the shared function for both callers. `project_manager`/`_email` come from the PO if it names one. `planned_delivery_date` comes from the PO's delivery date. |
| Quotation | Set `Won - PO Received` with `closed_at` = **PO date**. The stage-sync trigger only fills `closed_at` when it is null, so set it explicitly, or a 2025 PO is won "today". |
| Enquiry | An enquiry linked to the quotation that is not yet `Converted` is moved to `Converted`, with `converted_at` = PO date. Registration does not do this today, and the reports' "converted to PO" count depends on it. |
| `po_services` | As today: split from the quotation lines, scaled to the PO value. If the PO has its own lines that add up, use those instead, mapped to `services` by name. |
| Thread | The email thread is linked to the PO (`entity = 'purchase_order'`), unless it is linked by number to another record (phase 1's `keepRecordLink` rule). |

The owner and `sales_person` stay the quotation's. The registration is
attributed to "Automatic (email)" in the activity log, which is how phase
1's automatic records are attributed.

#### 3.5.1 The order inside the transaction

The project is created automatically, as part of registration; nobody sets
it up by hand first. Payment stages hang off the PO, and the PO hangs off a
project, so the project has to exist before the stages. Registration
writes, in one transaction:

1. **The project.** The quotation's project if it has one, else a new one
   numbered by the PO date's year. The client, primary service and
   salesperson come from the quotation; the project manager and planned
   delivery date come from the PO.
2. **The quotation, won**, and linked to that project, with `closed_at` =
   PO date.
3. **The enquiry, converted**, with `converted_at` = PO date.
4. **The PO**, on the project, with its PDF.
5. **The service lines** (`po_services`).
6. **The payment stages**, from the PO's own payment terms (§3.4), else the
   template. A stage triggered `On Milestone` creates that milestone on the
   project if it is missing.

If any step fails, the whole registration rolls back: there is never a
project without its PO, or a PO without its stages.

A PO sent to review (§3.7) creates nothing yet. When a person clicks
**Register against…**, the same function runs, so the project and stages
are still created automatically then.

### 3.6 Duplicates, re-sends, amendments, cancellations

| Case | Rule |
| --- | --- |
| Same email in two mailboxes | `lower(internet_message_id)` across `email_po_decisions`, as in phase 1. The second copy is logged `linked`, with no AI call. |
| PO number already registered (by hand, by import, or earlier by email) | Matched by **normalised** number for the same company. Log `linked`. If that PO has no document, attach this PDF. Nothing else changes. |
| Same PO re-sent with no amendment | As above. |
| **Amendment** (`document_type = amendment`, or the same number with a higher `amendment_no`) | Do **not** change the PO automatically: an amended value or terms affect invoicing that may already have happened. Raise a **review item**: "PO *x* amended: value *a* → *b*". The reviewer uses the existing revision path, a new PO with `replaces_po_number`. |
| **Cancellation** | Review item only. Never cancel automatically. |
| Two POs in one email, or one PO covering two quotations | Review item. |
| Advisory lock | `pg_advisory_xact_lock(hashtext('auto-po:' || normalised po_number || company_id))`, plus phase 1's message lock, then re-check under the lock. |

### 3.7 The review queue

Anything the rules will not register goes to **one queue**, not silence.
Reasons for review:

- no match;
- several matches;
- a check failed;
- an amendment or cancellation;
- confidence below the bar;
- the vendor is not us.

The queue:

- **Data:** `email_po_decisions` rows with `outcome = 'review'` and a
  `review_reason` code. No PDF text is stored. The PDF is uploaded **only
  if** a person registers it.
- **Screen:** a "POs to review" tab on the **Purchase orders** page, for
  admins and the quotation owner. Each row shows:
  - client, PO number and value as read (shown, not stored);
  - the reason;
  - the suggested quotation(s);
  - **Open email**;
  - **Register against…**, which opens the existing `RegisterPoDialog`
    pre-filled from a fresh read of the PDF;
  - **Not a PO**.
- **What the actions record:** the decision becomes `registered_by_hand`
  or `dismissed`, with who and when.
- **Notifications:** one per review item to the quotation owner (or
  admins). During backfill, one summary instead.

### 3.8 Historical POs (backfill) without flooding the system

A PO from eight months ago is very likely **delivered and invoiced
already**, outside the tracker. Registering it like a new PO would set off
notifications, onboarding and webhooks that only make sense for a new
order:

- the PM and salesperson get `po_registered` notifications, and an
  onboarding checklist is created;
- the `po.received` webhook fires to n8n.

**Payment stages are still created for history POs (decided, §9 decision
2)**, exactly as for live ones: from the PO's terms, else the template.
The consequence, which finance should expect:

- an old PO's `On PO Registration` stage shows as **To Invoice**, and then
  **Overdue** once its credit days pass, in Collections, Insights and the
  finance digest;
- that lasts until finance records the invoice and payment that already
  happened.

To make that clean-up quick:

- the backfill summary links to a **"Stages from past POs"** view: payment
  stages of POs registered in history mode that have no invoice yet;
- finance can work through that list with the existing invoice and
  payment actions;
- the payment follow-up and escalation job (`followups.daily`) does
  **not** chase these stages until a person has touched them, so owners
  and management are not emailed about months-old invoices. A stage
  counts as touched when an invoice number or payment has been recorded,
  or when it has been marked "checked" from the PO banner.

So `registerPurchaseOrder` takes `mode: 'live' | 'history'`. A PO counts as
**history** when its PO date is more than `auto_po_history_after_days`
(default **30**) before the day it is read.

| Effect | `live` | `history` |
| --- | --- | --- |
| Project, PO, document, services, quotation won, enquiry converted | yes | yes |
| Payment stages | from the PO's terms (else template) | **the same**: from the PO's terms (else template). They appear in the "Stages from past POs" view, and follow-up emails skip them until a person touches them. |
| `po_registered` notification, onboarding checklist | yes | no |
| `po.received` / `quotation.won` webhooks | yes | **no**: the webhook trigger skips rows when `current_setting('app.suppress_webhooks', true) = 'on'`, which the history path sets with `SET LOCAL` |
| Backfill summary | — | one per mailbox: "Read 365 days of sales@…: 37 POs registered, 6 to review" |

The reports and KPIs count POs by `po_date`, so history POs land in the
right months automatically.

### 3.9 Live sync and backfill wiring

- **Live:** `syncAccount` already hands candidates over. Add a second
  consumer, `processPoCandidates(account, candidates)`, next to phase 1's.
  Phase 1's candidates exclude later messages in a thread, so `ingest()`
  also returns **every stored or dropped inbound message with an
  attachment or PO words** (a cheap string test). The PO prefilter does the
  rest. Run PO before enquiry for the same batch, so a PO email can never
  also start an enquiry.
- **Backfill:**
  - a new job, `pos.backfill`, every 10 minutes;
  - its own cursor table (§4), **Inbox only**, oldest first, 365 days;
  - the same 4-minute budget and the same **shared** daily AI ceiling
    (`auto_enquiry_daily_ai_limit`);
  - it starts by itself for every active mailbox, including those whose
    phase 1 backfill has finished;
  - because phase 1 already judged these emails for enquiries, the PO pass
    is separate and does not re-judge them.
- **Order across phases:** the PO pass for a mailbox reads only as far as
  that mailbox's phase 1 backfill has got, so enquiries and quotations
  exist before POs look for them (`enquiriesReadUpTo`):
  - **Phase 1 still on the Inbox:** the PO pass waits. The quotations we
    sent are read from Sent Items, after the whole Inbox. A PO read before
    then could find no quotation and make one (§3.3).
  - **Phase 1 in Sent Items:** the PO pass reads up to the date phase 1 has
    reached there. A page that runs past it is fetched again on a later
    run.
  - **Phase 1 read through once:** no limit.
    `connected_accounts.past_enquiries_read_at` records this (migration
    069). **Re-run** clears only the progress row, not this, so a re-read
    of enquiries never holds POs back: what the first read made is still
    there.

### 3.10 Invoices we email to clients

In the tracker, an invoice is **a payment stage with an invoice number, an
invoice date and a document** (`payment_stages.invoice_no`,
`invoice_date`, `document_id`), recorded through
`POST /api/payment-stages/:id/invoice` (`server/src/routes/workflow.js`).
The stage's amount is not stored; it is `stage_percent × po_value`. That
route already accepts an invoice number raised outside the tracker. It
claims a `CVPL/{fy}/{n}` number only when none is given.

Many invoices are raised in Tally or Zoho, or as a Word document, and
emailed to the client from Outlook. The tracker never hears of them, so
the stage stays **To Invoice**. Phase 2 reads those emails.

#### 3.10.1 Which emails are invoice candidates (pure rules)

A new `invoicePrefilter(message, facts)` in a new module
`server/src/lib/mailbox/invoiceDetect.js`:

| Rule | Why |
| --- | --- |
| **Outbound** (Sent Items), to at least one external, non-blocked address | We send invoices. An invoice we **receive** is a vendor bill, which belongs to payables and is out of scope. |
| A **PDF attachment**, **and** invoice words in the subject, body or file name: invoice, tax invoice, bill, "please find attached our invoice", GST invoice | The usual covering email. |
| **Not** proforma (`proforma`, `PI No`), credit note, debit note or quotation words only | A proforma invoice is not a tax invoice. It is a request for an advance and must not use up the GST series. |
| No more than 5 external recipients | Not a mass mailing. |
| Not already decided for invoices (`email_invoice_decisions`, §4) | Idempotent. |

An invoice emailed from the tracker itself goes out through `sendMail`,
not a connected mailbox, and already has its `invoice_no`. If an Outlook
copy turns up, it matches by number and is logged `linked` (§3.10.4).

**Which mailboxes:** every connected mailbox, as before. Invoices often go
out from a finance mailbox (for example `accounts@`). The admin docs must
say that **that mailbox needs to be connected** for its invoices to be
read.

#### 3.10.2 Reading the invoice

The same pipeline as the PO (§3.2):

- rank the attachments ("invoice" or "tax invoice" in the file name or on
  the first page comes first);
- extract the text with `unpdf`, using OCR if the PDF is scanned;
- make one AI call returning:

```jsonc
{
  "document_type": "tax_invoice | proforma | credit_note | debit_note | other",
  "confidence": 0.0-1.0,
  "invoice_no": "CVPL/26-27/0042", "invoice_date": "2026-09-30",
  "seller": { "company_name": "…", "gstin": "…" },        // must be us
  "buyer":  { "company_name": "…", "gstin": "…" },
  "po_reference": "4500012345",                          // "PO No.", "Your order ref"
  "project_reference": "PRJ-2026-014",                   // if printed
  "quotation_reference": "CTZ/QT/2026/045",
  "currency": "INR",
  "taxable_value": 125000, "tax_value": 22500, "total_value": 147500,
  "stage_hint": "50% advance",                           // "Advance", "Final", "Milestone 2"
  "due_date": "2026-10-30"
}
```

**Checks in code.** Failing any of these sends the invoice to review
(§3.10.5):

- `document_type = tax_invoice`;
- **the seller is us**, by `company_gstin` or `company_name`, and the
  buyer is not us;
- an invoice number is present;
- the invoice date is on or before the email date;
- every amount appears in the PDF text (`amountInText`);
- taxable value plus tax equals the total, within ₹1 or 0.5%;
- the currency is valid;
- confidence is at least **0.85** (`auto_invoice_min_confidence`, the same
  bar as POs).

#### 3.10.3 Matching the invoice to a PO, a project and a stage

**Which PO.** These run in order, and the first that gives exactly one PO
wins:

1. The invoice's `po_reference`, compared **normalised** with
   `purchase_orders.po_number` for the buyer's company.
2. `project_reference` names a project. If the project has one live PO
   (not cancelled, not replaced), that is the PO. If it has several, rule
   4 picks among them.
3. The **thread** is linked to a PO or project (`email_threads.entity`), or
   the conversation holds the PO email (`email_po_decisions.po_number`).
4. **Company and amount:** the buyer resolves to a company (GSTIN, then
   contact or domain, then name). Its live POs are the candidates, and the
   one with an **open stage** whose amount matches (rule below) wins.

**Which stage on that PO:**

- **Open stages only:** no `invoice_no` yet, and not on hold.
- **Amount match:** the stage amount (`stage_percent × po_value`, incl.
  GST) must equal the invoice **total**, within ₹1 or 0.5%. This allows
  for rounding only. An invoice for a different amount is a different
  split, and is never forced onto a stage.
- **Several stages match** (for example 50/50): prefer the stage whose
  name or trigger fits `stage_hint` ("advance" → `On PO Registration`,
  "final" or "balance" → `On Delivery`, a milestone name → that
  milestone). Otherwise take the **lowest stage number** still open,
  because invoices go out in order.
- **No stage matches:** send it to **review** with
  `amount_not_a_stage`, showing the stages and their amounts. Examples are
  an invoice for 40% on a 50/50 PO, or a combined invoice for two stages.
  The reviewer can re-split the stages with the existing
  `POST /api/purchase-orders/:poNumber/stages`, then record the invoice.
- **The PO has no stages:** review (`po_without_stages`).
- **The PO is not in the tracker yet:** for example, the invoice is read
  before its PO email in the same batch. Leave the email undecided. It is
  tried again on the next run and after the PO backfill finishes. After
  `auto_invoice_wait_days` (default 7) it goes to review
  (`po_not_found`).

#### 3.10.4 Recording the invoice and uploading the PDF

Extract the body of `POST /api/payment-stages/:id/invoice` into
`server/src/lib/invoices.js` `recordInvoice(db, { stageId, invoiceNo,
invoiceDate, documentId, actor, mode })`. The route and automation both
call it, and the route's behaviour is unchanged.

| Field | Value |
| --- | --- |
| `invoice_no` | **As printed.** It is a fact, and the GST series is kept in the books. It is checked against the unique index `payment_stages_invoice_no_key`, comparing normalised (case, spaces and dashes ignored). If the number is already on **this** stage, log `linked`. If it is on **another** stage, send it to review (`invoice_no_in_use`). |
| Series counter | If the printed number is in the tracker's own `CVPL/{fy}/{n}` pattern, **move that financial year's counter past it** in the same transaction. Phase 1 did the same for quotation numbers (`moveCounterPast`), so the tracker never issues that number again. |
| `invoice_date` | From the invoice. |
| `document_id` | The invoice PDF. It is uploaded with `uploadDocument({ owner: 'payment-stages' })` **before** the transaction, then claimed with `claimAttachment`. If the stage **already has a document** (an invoice PDF generated or uploaded in the tracker), it is **kept**. The email's PDF is not attached and the decision notes it: an existing document is never replaced automatically. |
| Thread | Linked to the PO, unless it is already linked to a record by number. |

Because `invoice_date` is set, the stage moves from To Invoice to
**Due**, or to **Overdue** once its credit days pass, by the existing view
logic. Nothing derived is stored.

**Live mode** (invoice dated within `auto_po_history_after_days`, 30):

- the `invoice.issued` webhook fires as usual;
- the stage enters the normal collections cycle, including the client
  payment reminders (`reminders.payment`);
- the PO's owner gets one notification: "Invoice *no* recorded from email
  on PO *x*".

**History mode** (older invoices, from the backfill):

- no notification;
- no `invoice.issued` webhook (`app.suppress_webhooks`, §3.8);
- **no client payment reminders.** `runPaymentReminders`
  (`server/src/lib/reminders.js`) emails the **client** when a stage is
  overdue. An invoice from eight months ago has very likely been paid
  already, outside the tracker, and asking the client again would be
  wrong. Such stages are skipped until a person has touched them: a
  payment is recorded, or the PO banner is marked checked. The same rule
  applies to `followups.daily`. "From history" is derived from
  `email_invoice_decisions.mode`; nothing is stored on the stage.
- The "Stages from past POs" view (§3.8) becomes **"Past POs and invoices
  to settle"**:
  - stages from history POs or history invoices with no payment recorded;
  - finance records the payments that already happened;
  - if Zoho or Tally is connected, the existing books reconciliation
    (`lib/accounting/books.js`, `applyBookPayments`) can fill them in.

This also fixes the side effect of decision 2 (stages for historical POs).
Their invoices are now read from the same year of sent mail, so most
history stages get their invoice number, date and PDF automatically, and
only the payment is left for finance.

#### 3.10.5 What is never recorded automatically

| Case | What happens |
| --- | --- |
| Proforma invoice | Logged `not_invoice` (`proforma`). Nothing is recorded. |
| Credit note, debit note | Review (`credit_note`). |
| Revised or cancelled invoice ("Revised", "Cancelled", same number re-sent with different amounts) | Review (`revised`). An invoice already recorded is never changed automatically. |
| One invoice covering several stages or POs | Review (`amount_not_a_stage`). |
| Seller is not us (a forwarded vendor bill) | Review (`not_from_us`). |
| Number already on another stage | Review (`invoice_no_in_use`). |

These go to the same review screen as POs (§3.7), on an **"Invoices to
review"** tab, from the Payment stages page. **Record against…** opens the
existing invoice dialog pre-filled (number, date, PDF) with the suggested
stage. **Not an invoice** dismisses it.

#### 3.10.6 Wiring

- **Live:** add `processInvoiceCandidates(account, candidates)` in
  `syncAccount`. Sent Items candidates already include every outbound
  message (phase 1). It runs after the PO consumer.
- **Backfill:**
  - a new job, `invoices.backfill`, every 10 minutes;
  - **Sent Items only**, oldest first, 365 days, with its own cursor table;
  - the same 4-minute budget and the same shared daily AI ceiling;
  - for a mailbox, it reads only as far as the **PO backfills** have got
    (`posReadUpTo`). Every active mailbox's PO pass counts, because a PO
    may arrive in `sales@` and its invoice go out from `accounts@`:
    - each PO pass has got either all the way, or to the date it has
      reached;
    - the invoice pass reads up to the earliest of those dates;
    - while any mailbox's PO pass has not started, the invoice pass waits;
    - 24 hours after this mailbox's own PO pass has read through, the other
      mailboxes no longer hold it back.
  - "Read through" includes `connected_accounts.past_pos_read_at`, which a
    **Re-run** of POs does not clear (migration 069).
  - Undecided invoices are retried until `auto_invoice_wait_days`.

---

## 4. Data

Migration `067_email_purchase_orders.sql`, mirrored in `schema.sql`:

```sql
-- What was decided about one inbound email that might have been a PO.
-- Separate from email_enquiry_decisions: a PO email may already have an
-- enquiry decision, and the outcomes differ. No PDF text is stored.
CREATE TABLE IF NOT EXISTS email_po_decisions (
  id                  serial PRIMARY KEY,
  account_id          int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id         text NOT NULL,
  internet_message_id text,
  conversation_id     text,
  thread_id           int REFERENCES email_threads(id) ON DELETE SET NULL,
  from_email          text,
  received_at         timestamptz,
  outcome             text NOT NULL CHECK (outcome IN
                        ('registered','linked','review','not_po','registered_by_hand','dismissed')),
  document_type       text,
  review_reason       text CHECK (review_reason IN
                        ('no_match','several_matches','not_to_us','low_confidence','no_po_number',
                         'value_mismatch','company_mismatch','amendment','cancellation','multiple_pos','unreadable')),
  mode                text CHECK (mode IN ('live','history')),
  confidence          numeric(4,3),
  method              text NOT NULL CHECK (method IN ('ai','rules')),
  ai_calls            smallint NOT NULL DEFAULT 0,
  po_number           text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  quotation_no        text REFERENCES quotations(quotation_no) ON UPDATE CASCADE ON DELETE SET NULL,
  suggested_quotations text[],           -- for the review screen
  created_quotation   boolean NOT NULL DEFAULT false,   -- §3.3 "no quotation at all"
  stages_source       text CHECK (stages_source IN ('po_terms','template','none')),
  decided_by          text,              -- set when a person registers or dismisses
  decided_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);
-- + indexes on lower(internet_message_id), po_number, quotation_no, (outcome) WHERE outcome = 'review'

CREATE TABLE IF NOT EXISTS mailbox_po_backfills (   -- same shape as mailbox_enquiry_backfills, inbox only
  account_id int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since timestamptz NOT NULL, next_link text, reached timestamptz,
  scanned int NOT NULL DEFAULT 0, registered int NOT NULL DEFAULT 0, review int NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- What was decided about one outbound email that might have been our invoice.
CREATE TABLE IF NOT EXISTS email_invoice_decisions (
  id                  serial PRIMARY KEY,
  account_id          int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id         text NOT NULL,
  internet_message_id text,
  conversation_id     text,
  thread_id           int REFERENCES email_threads(id) ON DELETE SET NULL,
  to_emails           text[],
  sent_at             timestamptz,
  outcome             text NOT NULL CHECK (outcome IN
                        ('recorded','linked','review','not_invoice','recorded_by_hand','dismissed')),
  document_type       text,
  review_reason       text CHECK (review_reason IN
                        ('po_not_found','several_pos','amount_not_a_stage','po_without_stages','invoice_no_in_use',
                         'not_from_us','low_confidence','credit_note','revised','unreadable')),
  mode                text CHECK (mode IN ('live','history')),
  confidence          numeric(4,3),
  method              text NOT NULL CHECK (method IN ('ai','rules')),
  ai_calls            smallint NOT NULL DEFAULT 0,
  stage_id            int REFERENCES payment_stages(id) ON DELETE SET NULL,
  po_number           text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  invoice_no          text,              -- as printed; the stage holds the recorded one
  document_kept_existing boolean NOT NULL DEFAULT false,
  decided_by          text,
  decided_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);
-- + indexes on lower(internet_message_id), stage_id, (outcome) WHERE outcome = 'review'

CREATE TABLE IF NOT EXISTS mailbox_invoice_backfills (   -- same shape, Sent Items only
  account_id int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since timestamptz NOT NULL, next_link text, reached timestamptz,
  scanned int NOT NULL DEFAULT 0, recorded int NOT NULL DEFAULT 0, review int NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, notes) VALUES
  ('auto_invoice_enabled', 'true', '…'),
  ('auto_invoice_min_confidence', '0.85', '…'),
  ('auto_invoice_wait_days', '7', '…'),
  ('auto_po_enabled', 'true', '…'),
  ('auto_po_min_confidence', '0.85', '…'),
  ('auto_po_value_tolerance_percent', '2', '…'),
  ('auto_po_history_after_days', '30', '…'),
  ('auto_po_create_quotation_when_missing', 'true', '…'),
  ('po_portal_senders', '*@ansmtp.ariba.com,*@coupahost.com,*@jaggaer.com', '…')
ON CONFLICT (key) DO NOTHING;
```

Also in 067:

- `webhook_record_events()` returns early when
  `current_setting('app.suppress_webhooks', true) = 'on'` (§3.8).
- A unique index on the normalised PO number. It can only be added once
  existing duplicates are checked, so first run
  `SELECT lower(regexp_replace(po_number,'[^a-z0-9]','','gi')), count(*) … HAVING count(*) > 1`
  on production data. If any are found, use the app-level check only and
  list them for clean-up.

Derived, not stored:

- "Registered from email" is an EXISTS on `email_po_decisions` with
  outcome `registered`.
- "Read from email" on a quotation created from a PO reuses phase 1's flag
  path.

`scrub.sql` nulls `from_email` in the new table for staging copies.

---

## 5. Files

| File | Change |
| --- | --- |
| `server/src/lib/mailbox/poDetect.js` | **New, pure.** `poPrefilter`, `poNumbersIn`, `isPortalSender`, `buildPoPrompt`, `parsePoVerdict`. |
| `server/src/lib/mailbox/pdfPurchaseOrder.js` | **New, pure** where possible. `rankPoPdfs`, `checkPo` (the §3.2 checks), `stagesFromTerms` (wrapping `advanceShare` and the split rule), `grossUp`. |
| `server/src/lib/mailbox/autoPurchaseOrder.js` | **New.** `processPoCandidates`, `decidePo`, `matchQuotation`, `backfillPoAccount`, `runPoBackfills`, review-item notifications. Same `deps.chat` test seam as phase 1. |
| `server/src/lib/purchaseOrders.js` | `registerPurchaseOrder(db, input, { actor, mode })`, extracted from `register.js` with the three guards, explicit stages, PO-date year, `closed_at`, enquiry conversion. |
| `server/src/routes/register.js` | Calls the shared function. The response is unchanged. |
| `server/src/lib/mailbox/enquiryDetect.js` | `purchase_order` kind; the prefilter defers PO emails to phase 2. |
| `server/src/lib/mailbox/sync.js` | `ingest()` also returns later inbound messages with attachments or PO words. `syncAccount` calls `processPoCandidates` before `processCandidates`. |
| `server/src/import/parse.js`, `import/ai.js`, `import/rules.js` | Export `splitReference`, `parseMoney`, `advanceShare`, the split rule and `norm` for reuse. No behaviour change. |
| `server/src/jobs.js` | `pos.backfill` and `invoices.backfill` (`*/10 * * * *`). |
| `server/src/lib/mailbox/invoiceDetect.js` | **New, pure.** `invoicePrefilter`, `buildInvoicePrompt`, `parseInvoiceVerdict`, `checkInvoice`, `pickStage` (amount match, stage hint, lowest open stage), `normaliseInvoiceNo`. |
| `server/src/lib/mailbox/autoInvoice.js` | **New.** `processInvoiceCandidates`, `decideInvoice`, `matchPo`, `backfillInvoiceAccount`, `runInvoiceBackfills`. Same `deps.chat` test seam. |
| `server/src/lib/invoices.js` | **New.** `recordInvoice(db, …, { mode })`, extracted from `POST /api/payment-stages/:id/invoice`, plus the CVPL counter move-past and the keep-existing-document rule. The route calls it, with unchanged behaviour. |
| `server/src/lib/reminders.js` | `runPaymentReminders` skips stages whose invoice was recorded in history mode, until a payment is recorded or the PO is marked checked (§3.10.4). |
| `web/src/pages/PaymentStages.jsx` | An "Invoices to review" tab; a "Recorded from email" filter; the "Past POs and invoices to settle" view. The invoice dialog accepts a prefill. |
| `server/src/lib/followUps.js` | Invoice follow-ups skip the stages of history-mode POs until a person has touched them: an invoice number or payment is recorded, or the PO is marked checked. Derived from `email_po_decisions.mode`, not stored on the stage (§3.8). |
| `server/src/lib/resources.js`, `web/src/pages/PaymentStages.jsx` | A `from_past_po=1` filter: the "Stages from past POs" view (§3.8). |
| `server/src/routes/purchaseOrders*.js` / `workflow.js` | `GET /api/purchase-orders/review` (scoped: admins see all, sales see their quotations' items), `POST /api/purchase-orders/review/:id/register` (re-reads the PDF and returns the dialog's prefill), `POST /api/purchase-orders/review/:id/dismiss`. |
| `server/src/routes/mailboxes.js` | The auto-enquiries status gains PO counts and PO backfill progress. Re-run gets a "POs" option. |
| `server/src/lib/authz/policy.js` | Every new route. |
| `web/src/pages/PurchaseOrders.jsx` | A "To review" tab, and a "Registered from email" filter. |
| `web/src/components/RegisterPoDialog.jsx` | Accepts a prefill: number, date, value, currency, terms, stages, document. |
| `web/src/pages/PurchaseOrderDetail.jsx` | Banner: "Registered automatically from the client's PO emailed on *date*. Check value, terms and stages." **Mark checked** writes an activity entry, as on quotations. `EmailOrigin` line. |
| `web/src/pages/Mailboxes.jsx` | The Automatic enquiries card becomes "Automatic enquiries and POs", with a second switch and counts. |
| `docs/email-enquiries.md` | A "Purchase orders" section. Add a `docs/security.md` row: **inbound** PO PDFs' text now goes to the AI provider. |

---

## 6. Operations and safety

- **Switch:** `auto_po_enabled = false` stops PO detection and the PO
  backfill. `auto_invoice_enabled = false` stops invoice recording. Phase
  1 is unaffected by either.
- **Invoices and clients:** recording an invoice never emails the client.
  Client payment reminders only apply to invoices recorded live; past
  invoices are not chased until a person has touched them.
- **What leaves the server:** for PO candidates only, the email's new text
  and the PO PDF's text (at most 10 pages), or the file itself for OCR. A
  client's PO is **their** document, so record this in `security.md`.
  Nothing is sent for non-candidates.
- **Money safety:**
  - nothing is registered below 0.85 confidence;
  - nothing is registered unless the PO is addressed to us and every amount
    appears in the PDF;
  - amendments and cancellations are never applied automatically;
  - history POs' stages are not chased by follow-up emails until a person
    has checked them;
  - a PO value more than 2% off its quotation always goes to review.
- **AI cost:** about one call per PO candidate, plus OCR for scanned POs.
  It shares the phase 1 daily ceiling.
- **Failure:** an AI or Graph error leaves the email undecided, so the next
  run retries it. A failed check sends it to review, never to silence.

---

## 7. Build order (one PR each, each shippable)

1. **Groundwork:**
   - extract `registerPurchaseOrder()` with its guards, explicit stages,
     PO-date year, `closed_at` and enquiry conversion;
   - export the importer's parsing rules;
   - migration 067, including webhook suppression.
   The register route behaves as before, except for the three guards,
   which get their own tests.
2. **Detector and reader (pure):** `poDetect.js`, `pdfPurchaseOrder.js`,
   and the phase 1 prefilter change. Tests need no network.
3. **Live automation:** candidates from sync, matching, registration,
   duplicates, the review queue API, notifications.
4. **Backfill:** the `pos.backfill` job, history mode, summary
   notifications.
5. **Invoices:**
   - `recordInvoice()` extracted from the invoice route;
   - `invoiceDetect.js` (pure) and `autoInvoice.js`;
   - the `invoices.backfill` job, and history mode, including the
     client-reminder exclusion;
   - the invoice review API.
6. **Screens:**
   - the review tabs, the prefilled `RegisterPoDialog` and invoice dialog;
   - the PO banner and filter;
   - the Mailboxes card;
   - docs.

---

## 8. Tests

- **Pure** (`server/test/poDetectRules.test.js`, `pdfPurchaseOrder.test.js`):
  - **PO words with a PDF** make a candidate; words alone, a remittance
    advice and a newsletter do not; a portal sender with no PDF does.
  - **`poNumbersIn`** handles "PO No: 4500012345", "P.O. Number –
    PO/2026/12" and "WO No. HR-0091", and refuses "Awaited".
  - **`checkPo`** rejects:
    - a vendor that is not us;
    - a buyer that is us;
    - amounts not found in the text;
    - lines that do not add up;
    - a future PO date.
  - **`stagesFromTerms`** for:
    - "50% advance, balance on report" → 50/50;
    - "100% after completion" → 100 On Delivery;
    - "30% advance, 40% on draft, 30% on final" → three stages;
    - "advance 18% GST extra" → unclear, so the template is used.
  - **`grossUp`** with "GST extra".
- **Database-backed** (`server/test/emailPurchaseOrders.test.js`, test
  provider, fake `deps.chat`, PDFs built with pdfmake):
  1. A client reply in the quotation thread, with a PO PDF naming our QT
     number, registers a PO. It creates the project (PO-date year) and the
     stages from the PO's terms, attaches the document, marks the
     quotation won with `closed_at` = PO date, converts the enquiry and
     logs `registered`.
  2. A new thread with no QT reference, from a known company with one open
     quotation of matching value, registers against it.
  3. The same company with two open quotations of similar value goes to
     **review** (`several_matches`), with both suggested.
  4. No quotation on file creates the quotation (won) and enquiry
     (converted) from the PO, then registers.
  5. A PO number already registered by hand in another format ("PO-123"
     vs "po 123") is logged `linked`. The PDF is attached if missing, and
     nothing new is created.
  6. The same email in two mailboxes gives one registration.
  7. An amendment gives a review item, and the PO is unchanged.
  8. A cancellation gives a review item.
  9. A PO addressed to another vendor goes to review (`not_to_us`).
  10. A PO email is never logged as a phase 1 `not_enquiry`, and never
      makes an enquiry.
  11. **Backfill:** an eight-month-old PO is registered in history mode.
      - It gets its **payment stages** (from its terms), and they appear in
        the "Stages from past POs" view.
      - `followups.daily` does not chase them.
      - There is no `po_registered` notification, no onboarding tasks and
        no webhook rows.
      - One summary is sent per mailbox.
  11a. **Value mismatch:** a PO naming our QT number, but 5% below the
      quotation total, goes to review (`value_mismatch`) with both values,
      and nothing is registered. At 1.5% off, it registers.
  11b. **No quotation at all:** registers with no value check (scenario
      4). A known company with an open quotation 10% off goes to review,
      not to "create a quotation".
  12. The PO backfill waits for that mailbox's phase 1 backfill to finish.
  13. **Review actions:** "Register against" returns a prefill, and a
      manual registration marks the decision `registered_by_hand`.
      "Dismiss" marks it `dismissed`.
  14. **Register-route guards:** a quotation that already has a PO is
      refused (409); a duplicate normalised PO number is refused; a bad
      currency gets 422.
  15. `auto_po_enabled = false`: nothing is registered, and phase 1 runs
      as before.
  16. **Invoice, PO number printed:** an outbound email with a tax-invoice
      PDF citing PO `4500012345` for 50% of the PO value:
      - is recorded on stage 1 (`On PO Registration`), with the printed
        `invoice_no` and the invoice date;
      - has its PDF uploaded to the stage;
      - moves the stage to Due;
      - fires `invoice.issued` (live);
      - is logged `recorded`.
  17. **Second invoice on a 50/50 PO** with "balance" in it goes to stage 2.
  18. **Invoice amount not a stage** (40% on a 50/50 PO) goes to review
      (`amount_not_a_stage`), and nothing is recorded.
  19. **Proforma invoice:** logged `not_invoice`, nothing recorded, and no
      invoice number used.
  20. **Printed `CVPL/26-27/0042`:** recorded, and the 26-27 counter moves
      past 42, so the next tracker invoice is 0043 or higher.
  21. **Stage already has a document:** the invoice number and date are
      recorded, the existing document is kept, and
      `document_kept_existing` is set.
  22. **Invoice number already on another stage:** review
      (`invoice_no_in_use`).
  23. **Invoice before its PO:** left undecided, recorded once the PO is
      registered, and sent to review (`po_not_found`) after 7 days.
  24. **History invoice (eight months old):** recorded, with no
      notification and no webhook. `runPaymentReminders` does **not**
      email the client about it, and it appears in "Past POs and invoices
      to settle". After a payment is recorded, it leaves that list.
  25. **Vendor bill forwarded by us:** review (`not_from_us`).
  26. **Invoice backfill order:** it waits for the PO backfill, and the
      history PO from scenario 11 gets its invoice recorded on its stage.
  27. `auto_invoice_enabled = false`: no invoices are recorded, and POs
      run as before.
  28. **The invoice route** still claims a CVPL number when none is given,
      and behaves as before.
- **Authz:** the review routes are scoped. A sales user sees only items
  for their own quotations.
- **E2E:** open "To review", use **Register against**, and land on the
  new PO with its banner.

---

## 9. Decisions

### Decided by the product owner

1. **A PO with no quotation in the tracker:** create the quotation (won)
   and the enquiry (converted) from the PO, then register, so reports
   count it (§3.3).
2. **Payment stages for historical POs:** create them anyway, from the
   PO's terms or the template. Follow-up emails do not chase them until a
   person has touched them, and finance gets a "Stages from past POs" view
   to record the invoices and payments that already happened (§3.8).
3. **PO value different from the quotation:** a difference over 2% goes
   to **review**; it is never registered automatically (§3.3).
4. **Amended POs:** always review, never applied automatically (§3.6).
5. **Confidence bar:** **0.85** (`auto_po_min_confidence`).
6. **Invoices we email to clients** are recorded on the right payment
   stage, and their PDF is uploaded to it, for a PO or a project (§3.10).

7. **Proforma invoices:** never recorded. They are not tax invoices, and
   are logged `not_invoice` (§3.10.5).
8. **Invoice amount that is not a stage:** goes to **review**, and the
   reviewer re-splits the stages, then records the invoice (§3.10.3).
9. **Client payment reminders for past invoices:** **off** until someone
   has looked at the stage, either by recording a payment or by marking
   the PO checked (§3.10.4).
10. **An existing invoice document on the stage:** **kept**. The emailed
    PDF never replaces it (§3.10.4).
