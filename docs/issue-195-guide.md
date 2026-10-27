# Issue #195: what was fixed, and how to check it

The Daily Sales Briefing and the Weekly Sales MIS (Reports → Scheduled
reports) sent to, recorded and showed the same person more than once: within
To or Cc ("md@x.com, MD@x.com, md@x.com"), and across them (an address in
both). This branch makes every recipient appear once, everywhere the issue
lists, and fixes a second bug on the same page that the check turned up.

---

## 1. What changed

| Issue | What it does now | Where |
|---|---|---|
| Within a list | Each address once, compared without regard to case; the first spelling is kept | `uniqueAddresses` in `server/src/lib/mail.js` (moved from `followUps.js`, which re-exports it); `addressesIn` uses it |
| Across To and Cc | An address in To is dropped from Cc | `recipientLists(to, cc, bcc)` in `mail.js` |
| What goes out | Both senders send each address once: `sendMail` (SMTP) and `sendViaMailbox` (Microsoft Graph). The SMTP Bcc (`EMAIL_BCC`) is added only when it is not already a recipient | `mail.js` |
| Run history | `report_runs.recipients` and the email log hold each person once | `misSettings` in `server/src/lib/misReports.js` |
| Settings screen | The To and Cc fields and the "It goes to …" confirmation show the cleaned lists, and saving stores them cleaned | `web/src/lib/addresses.js`, `web/src/pages/ScheduledReports.jsx` |

**Also fixed, found while checking this in the browser.** On `main`, the
Scheduled reports page gave its recipients card and the debtors-list card the
same React key. React drew the recipients card twice, and the copy on screen
dropped every keystroke, so To and Cc could not be edited at all. Each card
has a key of its own now (`ScheduledReports.jsx`).

## 2. How to check it

1. Reports → Scheduled reports → Recipients and sender. Type
   `md@example.com, MD@example.com; sales@example.com, md@example.com` in To
   and `sales@example.com, finance@example.com` in Cc, and Save.
2. The fields read back `md@example.com, sales@example.com` and
   `finance@example.com`.
3. Send now on either report: the confirmation says "It goes to
   md@example.com, sales@example.com, copying finance@example.com". With
   `EMAIL_MODE=log` nothing is sent; the run history and Settings → Emails &
   jobs list each person once.

## 3. Questions for Shyam

A reply by number on the pull request is enough.

1. **Every email, not only the reports.** The issue suggested cleaning
   `addressesIn` too "so every sender path is covered", and that is what was
   done: follow-ups, reminders and every other email now send each address
   once and drop from Cc whoever is in To. Agreed?
2. **The Bcc.** When `EMAIL_BCC` is already in To or Cc, it is not added again
   as Bcc. Agreed?
3. **The duplicate card** on the same page is fixed in this PR rather than a
   separate one, since it stopped the recipients being edited at all. Fine?

## 4. Tests

| Test | Covers |
|---|---|
| `server/test/misSend.test.js` | The issue's own example end to end: what goes out, `report_runs.recipients`, the email log, the Bcc |
| `web/test/addresses.test.js` | The web helpers: one each, To before Cc, first spelling kept |
