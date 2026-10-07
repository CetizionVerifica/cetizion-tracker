# Issue #198, phase 1: the client portal shows the same figures

Issue #198 plans three phases for the client portal (#47), each its own pull
request (§7). This is **phase 1, "Show the same numbers"**: the client sees
each PO with its schedule and what is still to bill, and every invoice with
its taxable value, GST and total including GST, so they can tick our figures
against their own books. Staff can preview exactly what a client sees. There
is no schema migration; one SQL function is added to `views.sql`.

Phases 2 (the client answers: confirm, query, payment advice, two-way
documents) and 3 (emails that bring clients in) follow as their own PRs.

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
