# Batch 4 of 6: talking to clients

Issues: #31 one-click contact, #53 client acceptance, #43 certificates register, #29 Microsoft 365 mailboxes, #30 shared sales inbox. With this batch every item under #19 (the product flow) is done.

Merge after batch 3.

## What it does

- **One-click contact (#31).** Email, Call and WhatsApp buttons for each contact. Afterwards a short form logs what happened and the next step (which becomes a task), and updates "last contacted". The Action list gets a "No contact" tab for open deals and overdue invoices nobody has touched for a week. Contacts can be marked do not contact.
- **Client acceptance (#53).** A quotation can be sent as a private link. The client accepts with their name or asks for changes; we keep exactly what they accepted (a snapshot and a PDF fingerprint, and the PDF itself when Cloudinary is set up). Acceptance moves the deal to "awaiting PO" and notifies the owner. Links stop working when the quotation is revised or expires.
- **Certificates register (#43).** Every certificate, scorecard and report we issue, with number, dates, scope and file, on the client and the project. The expiry date schedules the renewal; the owner is reminded 120, 90 and 30 days before. Replacing one keeps the old one.
- **Microsoft 365 mailboxes (#29).** People connect their mailbox; client emails appear on the company and deal, new contacts are added, and replies go out in the same Outlook thread. Each person chooses whether the team sees full emails, subjects only, or who and when. Internal mail is never copied.
- **Shared sales inbox (#30).** Mail to sales@ becomes conversations with an owner and a reply deadline, ready-made answers, and one-click conversion to an enquiry.

## Deploying it

- **Migrations** 028 to 032, applied on start.
- **Environment, only to switch mail on (#29, #30):** `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REDIRECT_URI`, `MS_APP_ONLY`, `MAIL_WEBHOOK_URL`, and `MAIL_TOKEN_KEY` (32 random bytes, base64; it encrypts the stored mailbox tokens). The Entra app registration takes about 15 minutes; the steps are in `server/.env.example`. Without these, everything else works and mailboxes can be tried with the built-in test mailbox.
- **Public routes added:** `/accept/<token>` (client acceptance) and the Microsoft mail webhook. Both are token-checked.
- New job: `mail.sync` every 5 minutes (quiet when there is nothing to do); `deliverables.daily`.
- For stored acceptance PDFs and certificate files, the existing Cloudinary settings are used.

## How to check it

1. Company page: press Call on a contact, log the touch; "last contacted" updates and the next step becomes a task.
2. A quotation → Acceptance link → open it in a private window → accept; the quotation moves to awaiting PO and a notification appears.
3. Add a certificate with an expiry date on a project; the renewal is scheduled.
4. Mailboxes → Add test mailbox → Sync; the sample emails appear on their companies. Inbox shows the shared conversations.

## Checks run before this PR

Server tests (including mailbox rules), browser tests, migration check and web build passing at this batch; no conflicts with `main` or the team's open PRs #54 and #55.

## Review round 1

- zod 4 preparation: updates to deliverables, inboxes and canned responses save only the fields the request sent (`lib/sentFields.js`, with a test). From zod 4, `.partial()` fills in `.default()` values, so saving the whole parsed result would reset untouched fields.
- Carries the batch 2 review fixes (see `batch-2.md`).

## Review round 2 (#60)

**`TRUST_PROXY=1` is required when this deploys.** Behind Dokploy every
request arrives through Traefik, and with `TRUST_PROXY=0` the API sees the
proxy's address as the visitor's. Two things in this batch depend on it: the
public acceptance limiter (60 requests per 15 minutes) becomes one bucket
shared by every client, so one of them refreshing locks the rest out; and the
IP stored on an acceptance — which the client-facing page describes as their
network address — is Traefik's, which makes it worthless as evidence. The API
now logs a warning on the first forwarded request when the setting is wrong,
but it cannot fix it for itself.

Also fixed here:

- **The acceptance token is no longer written into the email log.** The client
  receives the real link; the stored copy of the body has the token replaced
  with `[redacted]`. Anyone who could list emails could otherwise take the
  link and accept the quotation as the client, under any name they typed.
- **A client-facing link is never built from request headers.** It comes from
  the `public_app_url` setting, or failing that `CORS_ORIGIN` — both server
  configuration. If neither is set the request is refused rather than sending
  a link built from an `Origin` the caller chose.
- **A newly connected mailbox starts at `metadata`**, not `share_everything`:
  who and when, until its owner decides otherwise.
- **The Graph webhook has its own rate limit** (300 a minute, far above real
  traffic) and now does one database lookup per delivery instead of one per
  notification in it.
- **Stored email HTML goes through a parser** (`sanitize-html`, a new
  dependency) instead of a list of regular expressions, which let
  `<img src=x/onerror=...>` and an entity-encoded `javascript:` href
  through. Neither was exploitable — `EmailThread.jsx` renders into an
  `<iframe sandbox="">` — but that one attribute was the whole defence.
- **A first-response deadline treats Sunday as Sunday in IST.** It read the
  day in UTC, so 20:00 UTC on a Saturday — Sunday morning here — stayed on
  a Sunday, and 19:30 UTC on a Sunday, which is Monday here, was pushed a
  day it did not need.

Still open from that review and deliberately not done: disconnecting a
mailbox does not revoke the refresh token at Microsoft. It needs a real
tenant to verify rather than a test, so it is worth its own issue.

## Rolling back

Revert the merge. Connected mailboxes can be disconnected first from the Mailboxes page.
