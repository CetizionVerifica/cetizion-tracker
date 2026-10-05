# PR #191: what was built, and how to use it

PR #191 holds the plan `docs/email-auto-entry-plan.md` (written 5 October
2026). It covers entering quotations, POs and invoices from email
automatically and reliably, using the four sample documents (Alembic PO and
invoice 037, Aragen PO and invoice 074). This branch builds the parts of it
that #188 (PR #192) did not already build. It sits **on top of PR #192**,
so #192 merges first.

The code cites the plan by section ("§3.1"). Read the plan side by side
with this guide.

---

## 1. At a glance

| Plan | What it does now | Where you see it | Built in |
|---|---|---|---|
| §3.1 image PDFs | The reader is sent the PDF itself (page images and text together), with its text layer alongside. Our invoices, which are one image inside a letterhead, are read for the first time. | Invoices recorded from email | this branch |
| §3.2 both GSTINs, partners | Either registration is "us"; a PO to a partner is ours, through it; `wrong_gstin` | Settings → Company profile | #192 |
| §3.3 one PO, one project; two-row lines | One line printed on two rows counts as one | — | #192 |
| §3.4 printed quotation number | `quotations.printed_no`: a PO quoting the number on our PDF ("YOUR REF: QTN-04/2026") finds the quotation | Quotation form → *Printed number* | this branch (the `client_reference` split is in #192) |
| §3.5 strict answers | The PO and invoice readers get a strict JSON Schema back | — | this branch |
| §3.6 stages | A PO that names only a trigger ("Against delivery") takes the quotation's split, with the PO's credit days | PO remarks; `stages_source = quotation_terms` | this branch (the one-click split is in #192) |
| §3.7 checks | GSTIN check character (`bad_gstin`); taxable × rate = tax; an image PDF read again by a second model, which must agree (`readers_disagree`) | PO and invoice review queues | this branch (amount in words, PO date and amendments are in #192) |
| §3.8 triage | One quick call sorts each email first; the thorough read happens only for business documents | Settings → Mailboxes → *Mail auto-entry*, Triage switch | this branch |
| §3.9 waiting | An invoice whose PO is not in yet waits; never attached to another PO | — | existing; Aragen 074 added as a fixture |
| §3.10 seeing it work | The *Mail auto-entry* panel, Undo for admins, a daily digest of old review items | Settings → Mailboxes; the "from email" line on POs and stages | this branch |
| §4 model | Fable 5.1 reads, with fallbacks that keep zero retention; Sonnet 5.5 checks and triages | `.env`; the panel names them | this branch |
| §5 evaluation | The golden set and `npm run eval:email-docs`, which fails unless every key field is right; `npm run ai:check-models` for routing | — | this branch (the fixtures and the shadow run are in #192) |
| §2.2 vendor code, validity | `purchase_orders.client_vendor_code`; delivery by the validity end when no date is printed | PO form → *Our vendor code*; project's planned delivery | this branch |

Migration **083_email_auto_entry** holds every schema change here.

---

## 2. How an email is read now

1. **Sync** stores the email, as before.
2. **Triage** (§3.8): Sonnet 5.5 reads the subject, the new text and the
   attachments' *names* (never the attachments) and labels the email as
   enquiry, quotation sent, client PO, PO change, our invoice, payment advice
   or other. The label is stored once per email (`email_triage`), so the
   PO, invoice and enquiry readers and the same email in another mailbox
   share one call.
   - The PO reader skips anything triage is at least 80% sure is not a PO
     or a PO change. That email is logged `not_po` and goes on to the
     enquiry reader, as before.
   - The invoice reader skips anything triage is sure is not our invoice.
   - The enquiry reader skips only newsletters and other noise ("other")
     and payment advice. Those are logged as kind "other", never "billing",
     because "billing" would mark a client's domain as a vendor's.
   - Triage never makes a reader read something it would otherwise skip.
     If triage is unsure, switched off, has no AI, hits the daily ceiling
     or fails, every reader reads as before.
3. **Reading** (§3.1): a model that reads PDFs (`anthropic/`, `openai/`,
   `google/`) gets the PDF file through OpenRouter's native engine, with the
   text layer appended and a note that anything printed as an image is
   missing from it. A text-only model gets the text, and a scan goes
   through OCR, as before. The answer has to match a strict JSON Schema
   (§3.5).
4. **Is it an image?** If the document's own number (PO number, invoice
   number) is not in its text layer, the text layer is just a letterhead.
   The amounts then cannot be checked against it, so a **second model**
   (Sonnet 5.5) reads the same PDF independently. If the two readings
   differ on the number, the date, the PO number or the total, the item
   goes to review as `readers_disagree`. The note says which fields
   differed, never their values.
5. **Checks** (§3.7), on top of #192's:
   - every GSTIN must have a valid check character (`bad_gstin`), which
     catches a misread digit;
   - when one GST rate is printed, taxable × rate must equal the tax to
     the rupee (`totals_do_not_add_up`).
6. **Matching and registering**:
   - a PO's "YOUR REF" also matches a quotation's printed number (§3.4);
   - a PO that names only a trigger ("Against delivery", "Invoice date,
     45 days") takes the quotation's percentage split (§3.6);
   - the PO's vendor code is kept;
   - planned delivery is the printed date, else the end of the order's
     validity.
7. **Review-only** (from #192, migration 082) still holds everything for a
   person until it is switched off. That is the plan's two-week shadow run
   (§5.4).

---

## 3. How to use it

### Settings → Mailboxes → Mail auto-entry (admins)
- Per day, over two weeks:
  - emails decided;
  - records entered (enquiries, quotations, POs, invoices);
  - items sent to review;
  - emails triage set aside;
  - AI calls and spend in US$ (OpenRouter's own cost figure, recorded per
    call in `ai_usage_daily`).
- **Now:** items in review (and how many are older than two days), invoices
  waiting for their PO, reads to try again, and reads given up on.
- **Why items went to review**, by reason, over the period.
- Which models read, check and triage, and whether the reader is sent the
  PDF itself.
- **Triage: switch off/on** (`email_triage_enabled`).

### Undo (admins)
- **On a PO** registered automatically: the line *"Registered automatically
  from the client's PO emailed on … · open the email · undo"*.
  - Undo removes the PO, its stages, services, onboarding steps,
    milestones and project.
  - The quotation goes back to exactly how it was: status, stage, PO
    received, project, and closed date. So do its enquiries.
  - If the email made the quotation (no quotation was on file), that
    quotation and its enquiry are removed too, unless something else now
    points at them; then they are kept and the reply says why.
- **On a stage** whose invoice was recorded automatically, the same line now
  shows under the stage. Undo takes the invoice number, date and the
  emailed PDF off the stage (a PDF that was there before stays).
- Undo is **refused** once anything has been recorded against the record,
  and the line says why. That means:
  - an invoice, a payment or a reminder on a stage;
  - another PO on the project;
  - a started onboarding step;
  - any other row pointing at the PO, its project or its stages. This is
    read from the database's foreign keys, so a table added later blocks
    Undo rather than losing its rows.
- The email's decision becomes `undone`, so the reader never enters it
  again.
- Webhooks that already fired, and notifications already read, are not
  called back.
- Every Undo is in the activity log.

### Review queues
Two new reasons:
- **"A GSTIN on it was misread"** (`bad_gstin`)
- **"An image PDF; two readings differ"** (`readers_disagree`), with a note
  naming the fields

### Daily digest
- Weekdays at 09:45, each admin gets one notification when PO or invoice
  review items have waited more than two days. It links to the PO review
  tab, else the invoice review tab.
- It is an in-app notification. Whether it also arrives by email follows
  each admin's own notification settings.

### Forms
- Quotation → **Printed number**: the number on the PDF we sent, when the
  tracker numbered the quotation otherwise.
  - The email reader fills it whenever the printed number clashed with
    another.
  - Migration 083 back-fills it from the remarks the reader already wrote
    ("Printed number: …").
- Purchase order → **Our vendor code**.

### Scripts (server/)
- `npm run ai:check-models`: one tiny call per model (reader, fallbacks,
  checker, triage), with the same zero-retention routing as every real
  call. **No client data goes out.** Run it with the production key,
  because routing depends on the account.
- `npm run eval:email-docs` (the same script as `npm run readers:accuracy`):
  - reads the golden set with the live model and scores every field;
  - **exits 1 unless every key field is right on every document**. Key
    fields: PO number, invoice number, dates, PO reference, values, and our
    GSTIN on the document;
  - `-- --model <id>` scores one model alone;
  - a fixture with a `"pdf": "file.pdf"` beside it is sent as the PDF
    itself, as the reader does. Put the real sample PDFs there.
- The fixtures live in `server/test/fixtures/email-docs/`. A new one,
  `invoice-cvpl-2026-27-074.json`, is the Aragen invoice: an image PDF
  citing PO 9010017766.

### Environment (see `server/.env.example`)
| Variable | Default | What it is |
|---|---|---|
| `OPENROUTER_MODEL` | `anthropic/claude-fable-5.1` | reads documents (and everything else) |
| `OPENROUTER_FALLBACK_MODELS` | `anthropic/claude-opus-5.5,openai/gpt-6.1-sol,anthropic/claude-sonnet-5.5` | tried in order when the reader does not route with zero retention |
| `OPENROUTER_CHECK_MODEL` | `anthropic/claude-sonnet-5.5` | second reading of an image PDF |
| `OPENROUTER_TRIAGE_MODEL` | `anthropic/claude-sonnet-5.5` | triage |
| `OPENROUTER_READS_PDF` | guessed from the model id | `1`/`0` overrides |

---

## 4. Before it reads real mail (deploy checklist)

1. **Merge #192 first.** This branch is built on it.
2. Run `npm run ai:check-models` with the production key.
   - If Fable 5.1 does not route with zero retention, set
     `OPENROUTER_MODEL` to the first model that does.
   - The fallbacks cover this automatically, but naming the model avoids
     a failed first try on every call.
3. **Check production's `OPENROUTER_MODEL`.** If it is set to
   `deepseek/deepseek-v4.1-flash` (as the old `.env.example` had it), the
   PDF fix does nothing until it is changed or removed: a text-only model
   still gets only the letterhead.
4. Put the four real sample PDFs next to their fixtures, add `"pdf"` to
   each JSON, replace the reconstructed `text` with the real text layer, and
   run `npm run eval:email-docs` until it passes.
5. Leave **review-only** on (#192's migration 082) for the two-week shadow
   run. Then turn clients back on one by one, then switch it off.
6. Migration 083 is additive: two new columns, three new tables, one new
   setting, and wider reason and outcome lists. `scripts/ci/check-migrations.sh`
   passes against `main`.

---

## 5. Choices made, and open questions

1. **Fallbacks are automatic.** Every call sends OpenRouter the `models`
   list in the plan's order (Fable 5.1, Opus 5.5, GPT-6.1 Sol, Sonnet 5.5),
   always with zero retention. The plan pictured a person choosing one
   model after the routing check. With the list, a reader keeps working if
   a provider drops zero retention, and the panel and `ai_usage_daily` show
   which model actually answered. Is automatic fallback OK, or should only
   one model be allowed?
2. **The second reader is Sonnet 5.5**, from the same family as Fable. The
   plan names GPT-6.1 Sol as the alternative if the two agree on each
   other's mistakes. It is one setting (`OPENROUTER_CHECK_MODEL`).
3. **How an image PDF is detected**: the document's own number is missing
   from its text layer. A PDF with no number at all is checked against its
   text as before (and fails `no_invoice_no` for an invoice).
4. **Triage sees the attachments' names, not their first page.** The plan
   lists first-page text, but that means downloading every attachment of
   every email before triage. The PO and invoice readers still read the
   whole PDF. Should first-page text be added?
5. **Triage only lets a reader skip, at 80% sure or more.** The enquiry
   reader skips only "other" and "payment advice": an RFQ the PO reader
   turned down still gets read for an enquiry.
6. **One daily AI ceiling, not two.** Triage calls count against the same
   `auto_enquiry_daily_ai_limit`. The plan's split into a triage limit and
   an extraction limit is not built.
7. **Not built:**
   - storing the PO reading for retries and for re-checks from review
     (§3.8, last bullet);
   - a higher `DOCUMENT_MAX_TOKENS` (§4 "can rise"). It stays 8,192 so a
     text-only fallback still accepts it.
8. **Stages from the quotation** are used only when the PO's terms hold no
   percentage at all. A PO with its own split always keeps it.
9. **The vendor code is stored and editable.** Showing it on invoices is
   for when the tracker prints invoices.
10. **Undo is for admins only**, because it deletes records. Should a
    salesperson be able to undo their own client's PO?
11. **The tests' made-up GSTINs now have valid check characters**, and so
    do the demo data's.

---

## 6. Tests

- Server, new:
  - `test/emailAutoEntry.test.js`: the GSTIN check character, the rate
    check, the quotation's stages, two readings compared, the strict
    schemas, the request chatJSON sends (fallbacks, a named model, the
    schema), and the triage rules.
  - `emailInvoices` 25f: an image invoice is read as a PDF, read again,
    recorded; two differing readings go to review; a text PDF is read once.
  - `emailInvoices` 25g: invoice Undo, the panel, the digest, the day's
    spend.
  - `emailPurchaseOrders` 2b: an Alembic-shaped PO is matched by printed
    number, gets the quotation's split, and keeps the vendor code and the
    validity end.
  - `emailPurchaseOrders` 2c: PO Undo, with the quotation restored, a
    created quotation removed, and Undo refused once an invoice is on it.
  - `emailPurchaseOrders` 9f: triage skips, unsure reads, one call per
    email, and the off switch.
- The fixture test now has six samples, including the image-only Aragen
  invoice.
- `scripts/ci/check-migrations.sh origin/main` passes.
