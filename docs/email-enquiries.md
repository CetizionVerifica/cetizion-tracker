# Enquiries from email

The tracker reads the connected mailboxes and turns a client's request for
new work into an enquiry by itself. It also registers the purchase orders
clients email, and records the invoices we email (below). It also reads back through each
mailbox's past year of mail, once. The design is in
[email-enquiries-plan.md](email-enquiries-plan.md); this page covers how it
behaves and how to run it.

## What it does

- **A client asks for work.** A new conversation started by an outside
  sender is checked by free rules first. Replies, mail that names one of our
  records, newsletters, invoices and CVs are dropped at that stage. What is
  left is judged by the AI, or by stricter rules when no AI key is set. A new
  enquiry is created with status **New** and source **Inbound email or call**.
  It is dated by the email, owned by the mailbox's person if they are a
  salesperson, and has a one-line note. The body is never copied.
- **We send a quotation first.** Some requests come by phone or WhatsApp,
  so the first email is our quotation. That also makes an enquiry, with
  source **Other**:
  - **The quotation is in the tracker** (its number is in the email): the
    enquiry is **Converted** and linked to it.
  - **It is not in the tracker** (made in Word or Excel and sent as a PDF):
    the PDF is read and the quotation is created on the **Sent** stage, with
    its printed number, its lines (or, if they do not add up, its printed
    totals), and the PDF as its document. A later "Rev 1" revises it, and a
    resend changes nothing.
  - **The PDF cannot be trusted** (password-protected, unclear, no total,
    a total the PDF does not print): the enquiry is **Contacted** with no
    quotation, and its owner gets a task to add the quotation.
- **No duplicates.** These all give one enquiry:
  - the same email in two mailboxes;
  - a re-run;
  - the same sender or company again within 30 days while the enquiry is
    open;
  - a quotation answering an enquiry that is already there.
- **Personal mailboxes** normally drop mail from unknown senders. Once such
  an email turns out to be an enquiry, it is stored. The mailbox's
  visibility still applies, so a "who and when only" mailbox keeps no
  subject or body.

## What is kept

`email_enquiry_decisions` holds one row per judged email: who sent it,
when, the verdict, how sure, the method (AI or rules), and the record it
led to. It holds no subject and no text. For a quotation read from a PDF,
it also keeps the totals printed on it. A quotation with no lines falls back
on those totals instead of going blank (`quotation_totals()`, migration 066).

Emails the free rules discard are not logged.

## Where to see it

- **Settings → Mailboxes → Automatic enquiries** (admins): the switch, AI
  calls used today, and for each mailbox how far the read of past mail has
  got, what was created and linked, and any error. **Re-run** judges a
  mailbox's mail again.
- **Enquiries → Created from email** and **Quotations → Read from email**:
  filters to review what was made.
- An enquiry opened from its notification, and a quotation page, say which
  email they came from, with a link to the thread.
- A quotation read from a PDF shows a banner until someone checks its lines
  against the PDF and presses **Mark checked**. That act is recorded in the
  activity log.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `auto_enquiries_enabled` | `true` | Off stops live detection and the backfill at the next run. Nothing already created is removed |
| `auto_enquiry_min_confidence` | `0.7` | How sure the AI must be. Rules alone always need 0.85 |
| `auto_enquiry_backfill_days` | `365` | How far back each mailbox is read, once |
| `auto_enquiry_same_sender_days` | `30` | Window for linking a new email to an open enquiry from the same sender or company |
| `auto_enquiry_daily_ai_limit` | `5000` | AI calls per day, shared by every email reader. The backfill stops for the day when it is reached; live mail carries on with rules |
| `email_reader_concurrency` | `4` | How many emails each reader reads at once (1 to 8). One client's or one conversation's mail is still read in order, oldest first |
| `auto_quotation_min_confidence` | `0.8` | How sure the AI must be of a quotation read from a PDF |

## Jobs

- `mail.sync` (every 5 minutes) judges new mail after it is stored.
- `enquiries.backfill` (every 10 minutes) reads past mail for about four
  minutes per run: Inbox first, then Sent Items, oldest first. Progress is
  saved after every page, so a restart loses nothing. When a mailbox is
  done, one notification says how many enquiries it found.

## Purchase orders from email

The design is in [email-po-plan.md](email-po-plan.md). It needs the AI key:
without it, PO emails are left unread rather than misread.

- **Which emails.** Any email a client sends us, replies in a thread
  included, that uses order words (purchase order, work order, LOI,
  contract, "we are pleased to place") **and** has a PDF, a PO number or
  comes from a procurement portal (Ariba, Coupa, Jaggaer;
  `po_portal_senders`). Words alone ("we will send the PO next week") and
  remittance advices are not read. Such an email is never made an enquiry.
- **Reading it.** The PO PDF is read (by OCR when it is a scan) with one AI
  call, then checked in code: addressed to us, not issued by us, a real PO
  number, every amount printed in the PDF, basic plus tax equal to the
  total, a currency the tracker uses, and confidence of at least 0.85.
- **Which quotation.** Our quotation number printed on the PO, then the
  thread (one naming the quotation, or holding our quotation email), then
  the client's open quotations by value. The PO's value must be within 2%
  of the quotation's, however it matched.
- **Registering it.** The quotation is won on the PO date, its enquiry is
  converted, the project is created (numbered by the PO's year), the PDF
  is attached, and the payment stages come from the PO's own terms ("50%
  advance, balance on report") or, when they are unclear, the template.
  A PO with no quotation on file creates the quotation and the enquiry
  from the PO, then registers.
- **Duplicates.** A PO number already registered in any spelling ("PO-123",
  "po 123") is linked, not registered again, and its PDF is attached if
  the PO had none. The same email in two mailboxes is read once.
- **What goes to review instead**, under **Purchase orders → To review**:
  no matching quotation, several possible ones, a value more than 2% off,
  an amendment or cancellation (never applied automatically), and any
  failed check. **Register against…** reads the email again and opens the
  Register PO dialog filled in, with the PDF attached and the PO's stages;
  **Not a PO** dismisses it. The quotation's owner is notified of each.
- **On the PO's page** a banner says it was registered from email until
  someone checks the value, terms and stages and presses **Mark checked**.
  The PO list filters **Source → Registered from email**.

## Invoices we email

- **Which emails.** An email we sent, with a PDF and invoice words, to at
  most five client addresses. Connect the mailbox invoices go out from
  (often `accounts@`), or its invoices are not read. A proforma invoice is
  never recorded and never uses up a number.
- **Reading it.** One AI call, then checks: a tax invoice, the seller is us
  (by GSTIN, else name), an invoice number, taxable value plus tax equals
  the total, and every amount printed in the PDF.
- **Which stage.** The PO by the number printed on the invoice, the project,
  the thread, or the client and amount; then the open stage whose amount
  is the invoice total (to the rupee, allowing rounding). Several equal
  stages: the one the invoice names ("advance", "balance"), else the
  lowest.
- **Recording it.** The number as printed, the date, and the PDF on the
  stage; a stage that already has a document keeps it. The stage moves to
  Due, and the PO's owner is told.
- **An invoice read before its PO** waits, and is recorded once the PO is
  registered. After `auto_invoice_wait_days` it goes to review.
- **What goes to review**, under **Payment schedule → Invoices to review**:
  an amount that is not a stage (re-split the stages first), a number
  already on another stage, a credit note, a revised invoice, a bill that
  is not ours, or no PO. **Record against…** reads the email again and
  opens the invoice dialog filled in.

## Past mail, and not chasing it

Each mailbox's past year is read once for POs (Inbox, after its enquiries)
and once for invoices (Sent Items, after the POs). Anything dated more than
`auto_po_history_after_days` (30) back is registered as **history**: no
notifications, no onboarding checklist, no webhooks. One summary per
mailbox says what was found.

A history PO still gets its payment stages, and they show as To Invoice
or Overdue until finance records what already happened.
**Payment schedule → Past mail → Past POs and invoices to settle** lists
them until a payment is recorded. An invoice read from past mail is never
chased: no client payment reminder, no owner follow-up, until a payment is
recorded or its PO is marked checked.

### Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `auto_po_enabled` | `true` | Off stops reading POs, live and past. Phase 1 carries on |
| `auto_po_min_confidence` | `0.85` | How sure the AI must be of a PO |
| `auto_po_value_tolerance_percent` | `2` | How far a PO's value may be from its quotation's |
| `auto_po_history_after_days` | `30` | Older POs and invoices are registered as history |
| `auto_po_create_quotation_when_missing` | `true` | A PO with no quotation on file creates one |
| `po_portal_senders` | Ariba, Coupa, Jaggaer | Portal senders whose PO notifications are read |
| `auto_invoice_enabled` | `true` | Off stops recording invoices |
| `auto_invoice_min_confidence` | `0.85` | How sure the AI must be of an invoice |
| `auto_invoice_wait_days` | `7` | How long an invoice waits for its PO before review |

The three switches are in Settings → Mailboxes, each with its own **Re-run**.
The daily AI limit (`auto_enquiry_daily_ai_limit`) is shared by all three.
Jobs: `pos.backfill` and `invoices.backfill`, every 10 minutes.

## Switching it off

Set `auto_enquiries_enabled` to `false` with the switch in Settings →
Mailboxes. Disconnecting a mailbox stops its backfill. Its decisions stay,
for the record.

Staging never reads real mail: Microsoft sync is blocked there.
