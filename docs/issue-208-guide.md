# Issue #208, phase 1: service questionnaires as digital client forms

Issue #208 plans four phases (its §9), each its own pull request. This is
**phase 1, "Digital questionnaires"** (gaps G1, G2, G6):

- an admin builds a questionnaire per service;
- staff send the client a link from an enquiry;
- the client fills it in on any device, saving as they go;
- the answers come back to the enquiry, and its owner is told.

Phase 2 (a priced quotation from the answers) and phase 3 (designed
quotation templates) follow; the version table already has the `pricing`
column phase 2 will fill.

---

## 1. At a glance

| Plan | What it does now | Where you see it |
|---|---|---|
| Builder (§3.3) | One questionnaire per service, in steps, built without code: 13 kinds of question (text, long text, number, money, date, drop-down, buttons, several of a list, tick boxes, yes/no, table of repeating rows, file upload, guidance text). Each question has a required tick, help text, a stable **key**, an optional **show-if** rule on an earlier answer, and text questions can be **filled in from our records** (company name, GSTIN, address; contact name, email, phone). **Preview as the client** at any time | Settings › Templates › **Questionnaires** (admins) |
| Versions | A draft is saved half-built, with what it lacks listed; **Publish** checks everything. A published version is **frozen** (a database trigger refuses changes), so old answers always match their questions. Changing a form means a new version, copied from the last; publishing it retires the old one | The questionnaire's page in Templates |
| Sending (§3.2) | From an enquiry: choose the questionnaire (the one for the enquiry's service is picked), the address (blank = the enquiry's contact) and an optional note; **Email it** or **Make a link only** to copy | Enquiries › the new **Questionnaire** column |
| The client's page (§3.1) | `/q/<token>`, no sign-in, built like the acceptance page and read on a phone. A step at a time with a progress bar; required answers asked for before moving on; conditional questions appear and disappear; **Save and finish later**; a review page with Edit per step; their name and email; **Submit**. After that the form is read-only and says who will be in touch | The emailed or copied link |
| On the enquiry | Where it stands (not started / in progress, step n of m / submitted), the link (open until when, opened or not, emailed to whom, reminders), the answers grouped by step with the client's files, and where the client's company details differ from ours. **Fill in for the client** (on a call), **Copy a link**, **Remind**, **Revoke links**, **Reopen**, **Send another** | The Questionnaire column's dialog |
| Told on submit | The enquiry's owner gets a notification (a new "Service questionnaires" group in notification settings) and an email with a link to the answers | Bell, email |
| Reminders | Daily at 10:30: a client who has not submitted is reminded after the days in Settings (3), at most twice, never after the link expires; 0 switches it off | Settings › Assumptions › Service questionnaires |
| Link lifetime | 30 days by default | Settings › Assumptions › Service questionnaires |

## 2. Where it differs from the plan, and why

1. **No enquiry page.** The plan puts a Questionnaire card on "the enquiry
   page", but enquiries are a list with an edit drawer. The card is a dialog
   opened from a new **Questionnaire** column on the list (its badge says
   where it stands; "Send" when nothing was sent). A notification links to
   `/enquiries?q=<no>&questionnaire=<id>` and opens it. When the redesign
   gives enquiries a page, the card moves there unchanged.
2. **Sending is `POST /api/questionnaire-responses`** with the enquiry
   number, rather than `POST /api/enquiries/:id/questionnaire`: enquiries are
   a generic resource, and one router keeps every questionnaire route
   together. The reach is the same (the enquiry's owner, or an admin).
3. **Uploaded files have a small table, `questionnaire_response_files`**,
   besides being named in the answers. Without it the nightly document
   purge would delete them as unattached, and staff access could not follow
   the enquiry's owner.
4. **A reminder, and "Copy a link", make a new link to the same answers.**
   Only the token's hash is stored, so the original link cannot be sent
   again. Every link of a response reaches the same answers until it expires
   or is revoked.
5. **Sending another questionnaire withdraws the one not yet submitted**
   (its links stop), so an enquiry has one open questionnaire at a time.
6. **Money is stored as a number**, in the currency the question names,
   rather than a number and a currency.

## 3. How to check it

1. Settings › Templates › Questionnaires › **New questionnaire**: pick a
   service, add a few questions over two steps (try a yes/no question and a
   text question shown only when it is "Yes", and a table of sites).
   **Preview as the client**, then **Publish version 1**.
2. Settings: *Address clients open links on* must be set (it is in
   production). With `EMAIL_MODE=log` nothing is sent; the email is in
   Settings › Emails & jobs.
3. Enquiries: on an enquiry, click **Send** in the Questionnaire column,
   then **Make a link only**, and open the link in a private window or on a
   phone. Fill it in, stop, open the link again, carry on, submit.
4. Back on the enquiry: the badge says **Submitted**; open it for the
   answers. **Reopen** lets the client change them.

## 4. Questions for Shyam

A reply by number on the pull request is enough.

1. **The Word questionnaires.** The plan asks for the current
   questionnaire for each service and one well-designed past quotation per
   service. I did not have them, so the builder ships empty and the tests
   use a made-up example. Please share them, and say which two services go
   first (default: ISO audits and Ecovadis). I can build those two from the
   Word files in the next PR, or an admin can build them in the builder.
2. **The Questionnaire column and dialog** on the enquiry list, until
   enquiries have a page of their own. Agreed?
3. **One open questionnaire per enquiry**: sending another withdraws the
   unsubmitted one. Agreed, or should an enquiry be able to have several at
   once (for example one per service it covers)?
4. **Reminders** go 3 days after the last email, at most twice, each with a
   new link (the earlier links keep working). Agreed?
5. **Company details the client changed** (legal name, GSTIN, address) are
   shown to staff with a link to the company, never written by themselves
   (the plan's rule that the GSTIN lives on the company). Should there be a
   one-click "Update the company" in a later phase?
6. **Filled in by staff**: when staff submit for the client, the submission
   carries their name and nobody is notified (they did it). Agreed?
7. **Who builds questionnaires**: admins only (the plan's default). Should a
   sales lead also be able to?
8. **Phase 2 (pricing)** needs the rate cards (man-day bands, travel,
   per-site charges). Who owns them, and can you share the ones for the
   first two services?

## 5. Files

| File | Change |
|---|---|
| `server/db/migrations/089_service_questionnaires.sql`, `schema.sql` | `questionnaires`, `questionnaire_versions` (one published per form; frozen by a trigger once published), `questionnaire_responses`, `questionnaire_links`, `questionnaire_response_files`; settings `questionnaire_link_days` (30), `questionnaire_reminder_days` (3) |
| `server/db/views.sql` | `v_questionnaire_responses` (the link's state, worked out); `v_enquiries` gains the latest questionnaire's status |
| `server/src/lib/questionnaireDefinition.js` | The definition's shape and rules; show-if; answers checked against their questions (the same function for the client, staff and submit); prefill and what differs |
| `server/src/lib/questionnaires.js` | Links (hash only), reach (the enquiry's owner), emails, submit and the owner's notice, files, the reminder run |
| `server/src/routes/questionnaires.js` | Admin › Templates routes; the responses sent from an enquiry |
| `server/src/routes/publicQuestionnaire.js` | The client's link: open, save, upload, submit |
| `server/src/lib/emailTemplates.js` | The invitation, its reminder, and the owner's "submitted" email |
| `server/src/auth/ownership.js`, `lib/documents.js` | A client's file belongs to the enquiry's owner; the purge keeps it |
| `server/src/lib/authz/policy.js`, `docs/issue-18-authorization.md` | The link-token mechanism and the 22 routes, declared |
| `server/src/jobs.js`, `README.md` | `questionnaires.remind`, daily at 10:30 |
| `server/src/lib/notificationPrefs.js` | "Service questionnaires submitted by clients" |
| `web/src/components/QuestionnaireForm.jsx` | The form, one step at a time: the client's page, staff filling in, and the preview |
| `web/src/pages/FillQuestionnaire.jsx`, `main.jsx` | The client's page at `/q/<token>` |
| `web/src/components/QuestionnaireCard.jsx`, `pages/Enquiries.jsx` | The Questionnaire column and dialog |
| `web/src/components/QuestionnaireBuilder.jsx`, `pages/Templates.jsx` | The builder |
| `web/src/pages/Settings.jsx` | Settings › Assumptions › Service questionnaires |
| `docs/security.md` | The new public surface |

## 6. Tests

| Test | Covers |
|---|---|
| `server/test/questionnaireDefinition.test.js` | A definition's rules (keys unique, show-if pointing back, options, columns, min/max, prefill, unknown fields and types refused); each show-if comparison and a hidden question hiding what depends on it; answers checked and never coerced, unknown and hidden ones dropped; required on submit, inside tables too; prefill and what the client changed |
| `server/test/questionnaires.test.js` | With real sign-ins: admins only build; a draft lists what it lacks and publishing waits; a published version is frozen (route and trigger); a new version copies and retires the old. Sending only from one's own enquiry; the token never stored or logged; prefill. The client saves, is refused bad answers, must answer what is required, submits once; the owner is told by notification and email; reopen. A token reaches one response only; guessed, revoked, expired and withdrawn links are the same dead end; a copied link works beside the first. Files of the allowed kinds only, into a file question only, and never another response's; staff reach a client's file through the enquiry they own. Staff fill in and submit. Reminders after the days set, at most twice, off at 0 |
| `web/e2e/flows.spec.js` | In a browser: a link made from the enquiry list, the form filled in on a phone (a required answer asked for, a conditional question appearing), submitted, and the answers back on the enquiry |

Screens were checked at desktop and phone width: nothing scrolls sideways.
No client data is used anywhere: the forms, companies and people in the
tests and screenshots are made up.
