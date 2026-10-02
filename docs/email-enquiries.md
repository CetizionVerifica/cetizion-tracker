# Enquiries from email

The tracker reads the connected mailboxes and turns a client's request for
new work into an enquiry by itself. It also reads back through each
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
| `auto_enquiry_daily_ai_limit` | `1500` | AI calls per day. The backfill stops for the day when it is reached; live mail carries on with rules |
| `auto_quotation_min_confidence` | `0.8` | How sure the AI must be of a quotation read from a PDF |

## Jobs

- `mail.sync` (every 5 minutes) judges new mail after it is stored.
- `enquiries.backfill` (every 10 minutes) reads past mail for about four
  minutes per run: Inbox first, then Sent Items, oldest first. Progress is
  saved after every page, so a restart loses nothing. When a mailbox is
  done, one notification says how many enquiries it found.

## Switching it off

Set `auto_enquiries_enabled` to `false` with the switch in Settings →
Mailboxes. Disconnecting a mailbox stops its backfill. Its decisions stay,
for the record.

Staging never reads real mail: Microsoft sync is blocked there.
