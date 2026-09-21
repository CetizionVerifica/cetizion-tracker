# Batch 2 of 6: selling

Issues: #23 quotations as documents, #24 enquiries as leads, #25 pipeline, #26 PO to project in one step, #46 discount approvals.

Merge after batch 1.

## What it does

- **Quotations as documents (#23).** Priced line by line from a service catalogue, with GST, validity date and terms; the total follows the lines. Revisions keep every earlier version. A PDF can be downloaded or emailed, and a quotation can be marked accepted. A quotation sent from the tracker that runs past its validity is marked lost (expired) after a grace period, by a daily job.
- **Enquiries as leads (#24).** Source, owner, estimated value, follow-up date and decision date, with statuses New, Contacted, Qualified, Converted, Parked, Dropped (with a reason). Converting creates the quotation with the estimate filled in. Overdue follow-ups are called out.
- **Pipeline (#25).** Open quotations sit in stages with probabilities (Draft, Sent, Negotiation, Verbal yes, On hold) on a drag-and-drop board. Losing a deal asks why. The page shows the weighted pipeline, a forecast by expected close month and the last 90 days' wins and losses.
- **PO to project (#26).** Registering a PO creates or joins the project, links the PO to the quotation, lists the services, builds the payment stages from a saved schedule (50/50, 30/70 ...) and adds the onboarding checklist with target dates, in one save. Schedules and checklists are edited under Admin.
- **Discount approvals (#46).** A quotation discounted beyond the threshold in Settings waits for approval before it can be sent; special terms can be sent for approval by hand. Approver and sales person are emailed.
- Smaller fixes: editable onboarding checklist, a sidebar that shrinks to icons on narrow screens, wrapping headers, and all-digit PO numbers no longer crash their page.

## Deploying it

- **Migrations** 018 to 022, applied on start. Existing quotations are placed in pipeline stages from their status.
- No new environment variables or packages.
- Admin → Settings: set the discount threshold and the approver's email.

## How to check it

1. Quotations: create one with two lines and GST; download the PDF; revise it and see the earlier version kept.
2. Pipeline: drag a card; mark one lost and give a reason.
3. Enquiries: convert one; the quotation opens with the estimate.
4. Register a PO on a won quotation with a 50/50 schedule; the project, stages and checklist appear.
5. Give a quotation a discount above the threshold; sending is blocked until approved.

## Checks run before this PR

Server tests, browser tests, migration check and web build passing at this batch; no conflicts with `main` or the team's open PRs #54 and #55.

## Review round 1 (fixes for the review on #58)

| # | Finding | What changed |
| --- | --- | --- |
| 1 | A discount raised after approval was never re-checked; a hand-requested exception switched the check off | The approved discount is stored (`approved_discount_percent`). Going over the threshold and above that level asks again, exceptions included. |
| 2 | The stage backfill stamped today as every quotation's stage change and close date | The backfill runs with the stage trigger off and takes its dates from the records: last change for the stage and for losses, the PO date for wins. |
| 3 | Old enquiry statuses worked on save but returned nothing in list filters | A resource can declare `filterAliases`; enquiries map In Progress, Declined and Won - Quotation Sent the same way on reads. |
| 4 | PO service lines came out 18% high | Lines (before GST) are scaled by the PO value against the quotation total on the same GST basis. |
| 5 | A card moved back by hand snapped forward on the next write | The trigger reacts only to a send or acceptance made in that write. |
| 6 | `/revise` read before it locked | It locks first, then reads. |
| 7 | A rejected quotation could not be sent after revising | A revision starts a new approval round and re-runs the discount check. |
| 8 | A revised quotation stayed under Sent | Clearing the send or acceptance moves the card back (Sent to Draft, Verbal yes to Negotiation). |
| 9 | The competitor could not be cleared and survived a reopen | A blank value clears it, and reopening clears it with the lost reason. |
| 10 | The split dialog dropped a template's names, triggers, credit days and milestones | It keeps them, and the stages endpoint accepts them (and On Milestone), as `/register` does. |
| 11 | The review PDF named the removed enquiry statuses | It names the current ones. |
| 12-14 | Cleanups | Unused `with_reason` removed; the Enquiries banner uses the rows already loaded; one pdfmake setup (`lib/pdf.js`); the quotation PDF uses the shared `money()` with two decimals. |

Also:
- `setting_num()` is defined next to the triggers that call it (schema.sql and migration 018), so a database built from schema.sql alone can insert quotations. main's reference-counter tests need this.
- zod 4 preparation: `register.js` uses `{ message }`.
- New tests: `server/test/pipelineRules.test.js` (discount approval, stage trigger, backfill, old-status filters).

Checked: 77 server tests, web build, migration check. A rehearsal merge with main and #71 (renumbered as the review asks) passed all tests; the real merge and renumbering follow once #71 is merged.

## Rolling back

Revert the merge. Migrations only add tables and columns.
