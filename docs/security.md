# Security: what to do on the server, and what the app does

Checked on 16 Sep 2026 (issue #34): **Postgres is published on port 55432
of the server's public address.** Anyone on the internet can try to log in
to it. Close it first; everything else here can follow.

## 1. Close the database port (server, the lead)

1. Dokploy → the `cetizion-postgres` service → **Advanced → Ports**: remove the
   published port 55432 (external). Leave the internal network as it is; the
   app reaches the database as `cetizion-postgres:5432` inside Docker.
2. Redeploy the database service. The app keeps working; if it does not, its
   `DATABASE_URL` still points at the public address: change the host to the
   internal service name and redeploy the app.
3. From a machine outside the server, check it is shut:

   ```bash
   nc -vz <server-ip> 55432
   ```

   It must fail (time out or be refused).
4. List what else is open, from outside: `nmap -Pn <server-ip>`. Only 22
   (SSH), 80 and 443 (Traefik) should answer. Close anything else in Dokploy or
   the firewall (`ufw status`).

### Reaching the database when you need to (SSH tunnel)

```bash
ssh -N -L 55432:localhost:5432 <user>@<server-ip>
```

That needs Postgres published on the server's loopback only, or a tunnel to
the container: `docker ps` to find it, then
`ssh -N -L 55432:<container-ip>:5432 <user>@<server-ip>`. Then connect to
`localhost:55432` from your machine. Use the read-only user below for looking.

## 2. Rotate every secret (the lead), in this order

Restart the app after each step and check it still signs in.

| Order | Secret | Where | Effect of changing it |
| --- | --- | --- | --- |
| 1 | Database password | Postgres (`ALTER ROLE ... PASSWORD`), then `DATABASE_URL` in Dokploy | none, once the app has the new one |
| 2 | `SESSION_SECRET` | Dokploy env; `openssl rand -base64 48` | everyone is signed out |
| 3 | `AUTH_PASSWORD` | Dokploy env; at least 14 characters (the app refuses less in production) | the team signs in with the new one |
| 4 | Cloudinary API secret | Cloudinary console → regenerate, then Dokploy env | none |
| 5 | Keys added since | `OPENROUTER_API_KEY`, `MAIL_TOKEN_KEY`*, `ZOHO_*`, `METRICS_TOKEN`, `INCOMING_WEBHOOK_SECRET`, SMTP | see below |

\* Changing `MAIL_TOKEN_KEY` makes stored mailbox tokens unreadable: connect
the mailboxes again afterwards.

Then check the old values no longer work (old database password refused, an
old session cookie gets 401).

**Where secrets live:** a team password-manager entry for each, and Dokploy's
environment as the only place the app reads them from. Never in the
repository, an issue, a commit message or a chat. CI's secret scan (gitleaks)
runs on every push.

## 3. What the app does (already in the code)

- **Sign-in protection.** Every attempt is recorded (`auth_events`). After 10
  failures from one address within 15 minutes (both in Settings) that address
  is refused, even with the right password, until the window passes, and an
  alert goes out. The per-address rate limit on failures stays in front.
- **Password rule.** In production the app will not start with an
  `AUTH_PASSWORD` shorter than 14 characters or equal to the development one,
  or a `SESSION_SECRET` shorter than 32.
- **Cookies** are httpOnly, SameSite=Lax (the client portal's is Strict and
  path-limited) and Secure in production.
- **Headers** (helmet): content security policy, HSTS for a year when cookies
  are secure, no framing (`X-Frame-Options: DENY`), referrer limited to the
  origin for other sites.
- **Logs** never contain cookies, authorization headers, one-time tokens in
  links, or the database password; the start-up line shows only host and
  database name.
- **Tokens** (acceptance links, portal links, API tokens) are stored only as
  hashes; mailbox tokens are encrypted.
- **Personal mailboxes** ([per-user-mailboxes-plan.md](per-user-mailboxes-plan.md))
  belong to a user account, not a typed name. Only the owner reads a
  personal mailbox's mail, through every door (the mailbox list, threads on
  records, the record timeline, the review queues); a shared mailbox is the
  team's. The one exception is a thread filed on a record the viewer owns,
  which they see whichever mailbox it landed in. Only the owner can change,
  sync or disconnect their mailbox; an admin can reassign it (logged in the
  activity log). Deactivating a user disconnects their mailboxes. Of a
  personal mailbox, the readers see Inbox and Sent Items only until the
  owner opens the other folders. A shared mailbox whose team Inbox names
  members is those members' (and the assignee's, or anybody's while a
  conversation is unassigned), not the whole team's; members are matched
  whatever case their name was typed in. Deleted Items and Junk are synced
  for display and never read by the AI or routed to the queue.
- **Reading mail in the Inbox** ([inbox-outlook-plan.md](inbox-outlook-plan.md) §3.3).
  What the Inbox shows of a mailbox is what the mailbox stores, under its
  visibility setting. Two things pass through without being stored, and only
  for the **owner** of a personal mailbox that stores less than the whole
  message: the body, read live from Microsoft Graph for that one request,
  cleaned like a stored body and never written; and attachment downloads.
  Anybody may download from a mailbox that shares everything; an admin
  looking at somebody else's mailbox gets neither. Attachments are streamed
  from Graph, never kept on disk, with `X-Content-Type-Options: nosniff`, a
  25 MB cap, and `Content-Disposition: attachment` for everything but a PDF
  or an image, which may open in a new tab under a policy of its own
  (`default-src 'none'; sandbox`), so nothing in it runs in the app's
  origin. A message's own `cid:` images are served by a route that answers
  for that message's images only; the reading pane's frame policy allows
  that one path of ours and no other.
- **What goes to the AI provider** (OpenRouter, only when
  `OPENROUTER_API_KEY` is set, routed with `data_collection: 'deny'` and
  zero data retention; a request that cannot be routed that way is not sent
  elsewhere, and rules decide instead):

  | Feature | What leaves the server |
  | --- | --- |
  | Bulk import | Sheet headers, stage wordings, and the remarks columns of the rows being imported |
  | Enquiries from email ([email-enquiries.md](email-enquiries.md)) | For a client email that passes the free rules: sender name, address and domain, subject, and the new part of the body (at most about 10,000 characters), and the text of any PDFs attached (at most 12,000 characters, no OCR). For a quotation we emailed that is not in the tracker: the text of its PDF (at most 40 pages), or the PDF itself when it is a scan. Nothing for internal mail, blocked senders, replies in known threads, or mail the rules discard. Nothing of the email is stored beyond the enquiry's own fields |
  | Purchase orders from email ([email-po-plan.md](email-po-plan.md)) | For an inbound email that passes the PO rules (order words plus a PDF, a PO number or a procurement-portal sender), including replies in known threads: the sender's name and address, the subject, the new part of the body (at most 10,000 characters), and the text of the **client's** PO PDF (at most 40 pages) followed by the email's other text PDFs (its annexures), at most 120,000 characters in all, or the PDF itself when it is a scan. A client's PO is their document, not ours. Nothing for mail the PO rules discard. No PDF text is stored; the PO's figures are kept only on the PO registered from it, and the PDF only as that PO's document |
  | Daily Sales Briefing ([mis-reports.md](mis-reports.md)) | Once a day, when the briefing is on: for yesterday's threads in the **shared** mailboxes set to share everything (at most 40 threads, 30,000 characters), the subject, the new part of each message, the sender's company, and the linked record's number and status; plus the five pending items the tracker chose (client, reference, days, amount). Never a personal mailbox. The Weekly MIS sends computed figures only, no email text |
  | Invoices we email ([email-po-plan.md](email-po-plan.md) §3.10) | For an email **we sent** with a PDF and invoice words, to at most five client addresses: the recipients, the subject, the new part of the body (at most 10,000 characters), and the text of the invoice PDF (at most 40 pages), or the PDF itself when it is a scan. Nothing for proformas (decided by the rules) or mail the rules discard. No PDF text is stored; while an invoice waits for its PO, the facts read from it (number, date, amounts, references) are kept on its decision row, and cleared once it is recorded or reviewed |

## 4. Least privilege in the database

The app's user owns its schema. For anyone who only needs to look (reports,
ad-hoc questions), create a read-only user:

```bash
psql "$DATABASE_URL" -v ro_password="'<a long password>'" -f server/scripts/sql/readonly-user.sql
```

It can read every table except the ones holding secrets — mailbox tokens,
API tokens, webhook secrets, portal links and sessions, and `users`, which
holds the password hashes and the team's addresses — and its queries time
out after a minute.

## 5. The `xlsx` package comes from the vendor, not npm — on purpose

`server/package.json` installs `xlsx` from SheetJS's own site:

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

**Do not "fix" this back to the npm registry.** SheetJS stopped publishing
there after 0.18.5, and that frozen copy carries two HIGH advisories fixed in
later releases: CVE-2023-30533 (prototype pollution, fixed in 0.19.3) and
CVE-2024-22363 (ReDoS, fixed in 0.20.2). Moving to npm would be a downgrade
into both. Check for yourself before touching it:

```bash
npm view xlsx version          # 0.18.5 — what npm has
grep xlsx server/package.json  # 0.20.3 — what we run
```

What this costs, and what covers it:

| Concern | Where it stands |
| --- | --- |
| A tampered tarball | `server/package-lock.json` pins it with a `sha512` integrity hash; a changed file fails `npm ci` |
| Not in `npm audit` or Dependabot | Neither can see this package at all, so **a new SheetJS release has to be noticed by a person** — check <https://sheetjs.com/> each quarter, at the access review below |
| The CDN being down | CI caches npm packages against the lockfile, so a normal run never fetches it. A cold cache during an outage fails the build; re-run it once the CDN is back |

If the outage risk is ever judged unacceptable, mirror the tarball to GitHub
Packages or an internal store and point the URL there. That keeps 0.20.3 and
drops the outside dependency.

To upgrade: change the version in the URL **and** in the version field, run
`npm install` in `server/`, confirm the `integrity` hash in the lockfile
changed, and commit the lockfile with it.

## 6. Access review (every quarter)

| System | Check |
| --- | --- |
| Dokploy | who has an account; 2FA on for each |
| GitHub organisation | members and outside collaborators; 2FA required; branch protection on `main` and `production` |
| Cloudinary, Zoho, Microsoft 365 app, Sentry | who can sign in; 2FA on |
| Server SSH | `~/.ssh/authorized_keys`: one key per person, remove leavers |
| Tracker | API tokens (Settings), webhook endpoints, portal access per client |
| SheetJS | a newer `xlsx` at <https://sheetjs.com/> — nothing automated watches this (section 5) |

Write the date and who did it at the bottom of this file.

## Review log

| Date | By | Notes |
| --- | --- | --- |
| | | |
