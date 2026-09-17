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

- **Migrations** 013 to 017, applied on start. Existing quotations are placed in pipeline stages from their status.
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

## Rolling back

Revert the merge. Migrations only add tables and columns.
