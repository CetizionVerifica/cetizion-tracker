# Issue #198: the client portal shows the same figures, and the client answers

Issue #198 plans three phases for the client portal (#47), each its own pull
request (the issue's §7). This is **phase 1, "Show the same numbers"**: the client sees
each PO with its schedule and what is still to bill, and every invoice with
its taxable value, GST and total including GST, so they can tick our figures
against their own books. Staff can preview exactly what a client sees. There
is no schema migration; one SQL function is added to `views.sql`.

**Phase 2, "Let the client answer"**, is in §7: the client confirms an
invoice, raises a query or tells us they paid, and files go both ways.
Phase 3 (emails that bring clients in) follows as its own PR.

---

## 1. At a glance

| Plan | What it does now | Where you see it |
|---|---|---|
| G1 PO view | Each project lists its live POs: value with the GST in it, services, billed / received / outstanding / still to bill (all including GST; billed + still to bill = PO value), and the payment schedule stage by stage with each stage's trigger and state ("Not yet invoiced", "Due", "Part paid", "Overdue", "Paid") and the invoice number | Portal → **Projects & orders** (the Projects section, renamed in the portal only) |
| G2 GST | Every invoice shows **Taxable**, **GST** and **Total including GST**, then **Paid**, **TDS** and **Outstanding**; the PO shows "value ₹X including GST ₹Y (taxable ₹Z)". The statement PDF has the same columns and totals per currency | Portal → Invoices; *Download statement* |
| G3 invoice PDFs | Each invoice with a file has a **PDF** link, served from the Invoices section (it no longer needs Documents switched on) | Portal → Invoices; the PO schedule |
| G4 cancelled / replaced POs | A cancelled PO, or one replaced by a revision, is no longer shown as live; the revision says "Revised from PO …". Their invoices stay listed: they were raised, and are billed as usual | Portal → Projects & orders, Documents |
| G7 preview as client | An admin opens **Preview as client** on the company page and sees the portal's own sections, drawn from the same server functions. Staff also get where each GST split came from | Company → Preview as client |
| Doc fix | `docs/email-auto-entry-plan.md` said a PO's value is "taxable value, before GST"; it is the total including GST. Corrected | |

Also: the portal's invoice state comes from the money alone (see §4, Q3),
and a browser test walks through the portal and the preview.

## 2. How GST is worked out

Nothing new is stored. A PO's value, and so every invoice (a share of it),
is a total including GST: the register grosses a printed basic value up at
the quotation lines' own GST rates. `po_gst_split(po, total, stage)` in
`server/db/views.sql` works the split back out, in this order:

1. **The books.** An invoice matched to the accounts import (#48,
   `reconciliation_items` → `books_entries`) whose total agrees with ours
   (within ₹1): the books' own taxable value and GST. The books are the legal
   record.
2. **The quotation.** Otherwise the PO's effective rate from its quotation's
   lines, Σ(amount × GST rate) / Σ(amount); a quotation with an 18% line and
   a 5% line comes out at their weighted rate. A PO that names no quotation
   uses the won quotations of its project.
3. **The default.** No quotation lines: the `gst_rate_default` setting (18%),
   marked *estimated* for staff (the client does not see the mark).
4. **Exports.** A PO in another currency: no GST.

Taxable is the total ÷ (1 + rate), to the paisa; GST is what is left, so
taxable + GST is always exactly the total. One function serves the portal,
its statement and the staff preview, so the three cannot disagree.

## 3. How to check it

1. Company → **Client portal**: switch it on, allow a contact with an
   email, *Send link*. With `EMAIL_MODE=log` nothing is sent: the link is in
   the email log (Settings → Emails & jobs).
2. Company → **Preview as client** → *Show the client's view*: Invoices
   shows each invoice's six figures; Projects & orders shows each PO's
   schedule and what is still to bill. A section switched off is marked
   "(off)".
3. Open the link: the same figures, now with working PDF and PO-file links
   and the statement PDF.

## 4. Questions for Shyam

A reply by number on the pull request is enough.

1. **Books and tracker disagree.** The books' split is used only when the
   books' total matches ours within ₹1. When they differ (reconciliation
   says "amount differs"), the client sees our total split at the
   quotation's rate. Should the client instead see the books' figures, or
   nothing until finance settles the difference?
2. **Where staff see "GST estimated".** Built: only in *Preview as client*
   (each split's source). Should the PO page or Collections flag POs whose
   GST is estimated, so finance can link the quotation or import the books?
3. **The client's invoice state** comes from the money alone: Paid when
   received (paid + TDS) covers the total, Overdue past its due date, Part
   paid, else Due. The staff stage status also weighs the stage's trigger
   ("Not Due" until the PO date or delivery is recorded), which made an
   invoiced, fully paid stage read "Due". Agreed?
4. **Invoices of cancelled or revised POs** stay in the client's invoice
   list (they were raised, and `v_purchase_orders` says they are "still
   billed as usual"); only the PO views hide those POs. Agreed?
5. **"Projects" vs "Projects & orders".** The portal says "Projects &
   orders"; the section switches on the company page still say "Projects",
   because #197 is editing that file. One line to change once #197 merges.
6. **PR #197.** §7 lists "PR #197 merged" in phase 1. This branch does not
   depend on it and merges cleanly beside it; it is shivam-balyan's PR to
   merge.
7. **Phases 2 and 3** follow as their own PRs and are under way: phase 2
   (the client answers, two-way files) with the one migration, 087, now that
   #199's 084–086 are on `main`; then phase 3 (the emails). Anything you
   would like done differently there, say so here.

## 5. Files

| File | Change |
|---|---|
| `server/db/views.sql` | `po_gst_split` |
| `server/src/lib/portal.js` | POs per project with their schedule and roll-up; invoices with taxable / GST / paid / TDS and the PDF flag; live POs only; the statement's columns and totals; `SECTION_DATA` for the preview |
| `server/src/routes/portal.js` | `GET /api/portal/files/invoice/:id`, `GET /api/portal/files/po/:no`, `GET /api/portal-admin/companies/:id/preview/:section` |
| `server/src/lib/authz/policy.js` | The three routes, declared |
| `web/src/pages/Portal.jsx` | Projects & orders, invoices as rows that wrap with their six figures, totals, a PO filter; sections exported for the preview |
| `web/src/components/PortalPreview.jsx` | Preview as client, on the company page (admins) |
| `web/src/styles/globals.css` | The portal's PO, figures and schedule rows |

## 6. Tests

| Test | Covers |
|---|---|
| `server/test/portal.test.js` | A project's live POs (cancelled and replaced hidden, the revision says so), GST at mixed quotation rates, the default rate marked estimated when there is no quotation, the paisa left on GST, billed + still to bill = PO value, no internal stage fields; invoices with the books' split when matched and the quotation's otherwise, paid and TDS, taxable + GST = total; invoice PDFs from Invoices and PO files from Projects without Documents, another company's not found; the preview equals the client's view plus the GST source, and is not reachable with a portal session |
| `web/e2e/flows.spec.js` | The portal in a browser: the staff preview, then the client's link, Projects & orders and Invoices with their GST |

Screens were also checked at desktop and phone width: nothing scrolls
sideways.

---

## 7. Phase 2: the client answers

Plan §4, G5 and G10. The client's word is recorded as a **claim** and never
written over our figures. Finance confirms it with the tools they already
use. One migration, `087_portal_client_actions.sql`.

### 7.1 At a glance

| Plan | What it does now | Where you see it |
|---|---|---|
| Confirm | The client confirms an invoice is correct. It is a record, with nothing to act on | Portal → Invoices → *Confirm*. Staff: a badge on the PO's stage, "Client confirmed 7 Oct" |
| Query | On an invoice (*Raise a query*) or on a PO (*Raise a query about this PO*). It opens a thread in the shared inbox, as a portal message does, and notifies the owner of the PO's project | Collections → **From the client portal** → *Client queries*: *Reply*, *Resolved*, *Reject*. The PO's stage shows "Client query open" |
| Payment advice | *Tell us you've paid*: which invoices, the amount, TDS deducted, the date, a UTR or cheque number, and an optional remittance PDF or image. It writes no payment. The client sees the invoice as **Payment reported** instead of Overdue until finance acts; our figures do not change | Collections → *Payment advice*: **Match** opens the usual *Record a payment*, filled in from the advice. Saving writes the receipt and links the advice. *Reject* needs a reason |
| Where each stands | The client's **Your requests** list shows each one as being checked, payment recorded, resolved or answered, with our reply | Portal → Invoices, below the invoices |
| Share with client (G10) | Staff tick **Share with client** on a file in a record's activity (company, project, PO or invoice). Every file is off until ticked, so nothing attached before is shown | Any record's Activity → a file → *Share with client* / *Stop sharing* |
| Client uploads (G10) | The client uploads a file onto one of their projects or live POs, with a label ("Signed PO", "PO amendment", "audit evidence"). PDF, image, Word or Excel only. They can delete it until staff have seen it. Staff see it in the record's activity with a **From client** badge, and the owner is notified | Portal → Documents → *From you*. Staff: the record's Activity |

### 7.2 How a payment advice is matched

1. The client reports ₹2,30,000 paid on 7 Oct, with TDS ₹6,000 and a UTR,
   on one invoice. Their invoice now reads **Payment reported**.
2. Finance opens Collections → *Payment advice* → **Match**. *Record a
   payment* opens with the amount, TDS, date and reference from the advice,
   and says what the client reported. Finance checks the bank and saves.
3. The receipt is written with `payments.portal_action_id`, and the advice
   becomes **matched** in the same transaction. The client sees "Payment
   recorded". The invoice reads Paid or Part paid, from the money received.

An advice that covers several invoices shows one *Match* button per
invoice, each filled in with that invoice's outstanding. The advice is
matched once every invoice it covers has its receipt.

### 7.3 How to check it

1. Switch the portal on for a company and open a contact's link (§3).
2. In Invoices, *Raise a query* on one invoice and *Tell us you've paid*
   on another. Both appear under **Your requests**, and the second invoice
   reads *Payment reported*.
3. As staff, open Collections → **From the client portal**. *Match* the
   advice and save. Mark the query *Resolved*, or *Reject* it with a note.
   The client's list shows each result, with the note.
4. On a project, tick *Share with client* on a file: it appears in the
   portal's Documents → *From Cetizion*. Upload a file from the portal: it
   appears in the project's Activity, marked *From client*.

### 7.4 Questions for Shyam

A reply by number on the pull request is enough.

1. **Who is told.** A query or an upload notifies the owner of the PO's
   project, or everyone when it has no owner. A payment report notifies
   everyone, because there is no finance role to send it to. Nobody is told
   twice. Should payment reports go to particular people instead, say the
   admins?
2. **A confirmation is settled as it is made.** It never appears in the
   Collections worklist, only as a badge on the PO's stage. Agreed?
3. **Queries are resolved by hand.** Staff reply in the inbox thread, then
   click *Resolved* in Collections. Should a reply in the thread resolve the
   query by itself?
4. **"Seen by staff"** stops the client deleting an upload. It happens when
   anyone opens the activity of the record the upload is on. Agreed, or
   should it take an explicit "seen" click?
5. **Where a client can upload.** Onto their projects and live POs only, as
   the plan says, not onto the company as a whole or onto an invoice. Staff
   can share files on all four. Is that enough?
6. **Answers follow the section switches.** Confirm, query and payment
   advice need the *Invoices* section on, since that is where they live;
   uploads need *Documents*. A company with Invoices off cannot answer at
   all. Agreed?
7. **Rate limit.** A client can send 30 answers or uploads an hour from one
   address, on top of the existing message limit. Is that enough?
8. **Rejecting needs a reason**, which the client reads; resolving takes an
   optional note. Agreed?
9. **Badges on the stage** are on the PO page only. Should Collections'
   invoice rows or the Payment stages list show them too?

### 7.5 Files

| File | Change |
|---|---|
| `server/db/migrations/087_portal_client_actions.sql`, `schema.sql` | Two new tables, `portal_client_actions` and `portal_client_action_stages`. New columns: `payments.portal_action_id`, and `attachments.shared_with_client`, `uploaded_by_contact_id` and `seen_by_staff_at` |
| `server/src/lib/portal.js` | The "Payment reported" state; each invoice's latest answer; shared files and uploads in Documents; the client's answers; ownership checks for answers, uploads and their files; who is told |
| `server/src/routes/portal.js` | `GET` and `POST /api/portal/actions`, `POST /api/portal/documents`, `DELETE /api/portal/documents/:id` |
| `server/src/routes/portalActions.js` | The staff worklist: `GET /api/portal-admin/actions` and `POST /api/portal-admin/actions/:id/resolve`, scoped like the PO |
| `server/src/routes/workflow.js` | *Record a payment* takes `portal_action_id` and matches the advice in the same transaction |
| `server/src/routes/timeline.js`, `documents.js` | A file's shared and from-client flags. Opening a record marks the client's uploads seen. A client's file always downloads |
| `server/src/auth/ownership.js`, `lib/documents.js`, `lib/resources.js` | A remittance file belongs to its advice; `shared_with_client` on attachments |
| `server/src/lib/authz/policy.js`, `docs/issue-18-authorization.md` | The six routes, declared |
| `server/src/lib/notificationPrefs.js` | "Client portal" notifications, which a user can turn off |
| `web/src/pages/Portal.jsx` | The confirm, query and payment forms; Your requests; From Cetizion and From you, with the upload form |
| `web/src/components/PortalAnswers.jsx`, `pages/Collections.jsx` | **From the client portal** on Collections |
| `web/src/components/actions.jsx` | *Record a payment*, filled in from an advice |
| `web/src/components/Timeline.jsx` | The *From client* and *Shared with client* badges; *Share with client* |
| `web/src/pages/PurchaseOrderDetail.jsx` | The client's latest word on each stage |
| `docs/security.md` | What a client can now write |

### 7.6 Tests

| Test | Covers |
|---|---|
| `server/test/portal.test.js` | The answers: confirm, query and payment advice, and what each needs. A payment advice writes no payment, and the invoice reads Payment reported. Isolation: company B cannot answer on A's invoice or PO (one among several is enough to refuse), cannot get a file stored before ownership is checked, and cannot read A's answers; with Invoices off, answers are blocked. Matching: only on an invoice the advice is about, after which it is matched; an advice over two invoices is matched only when both have their receipt. Resolve and reject: a reject needs a reason, and each settles once. Files: shared files appear only when ticked and only the company's own; uploads go only onto their own projects and live POs, and only the allowed types; a client deletes only their own upload, until it is seen; another company's remittance file is not found. Who is notified |
| `web/e2e/flows.spec.js` | In a browser: the client reports a payment, staff match it in Collections, and the client sees it recorded |

Screens were checked at desktop and phone width: nothing scrolls sideways.
