# Issue plan

Every issue in the repository as of 17 September 2026, who holds it, and the
order we take the rest in. Update this file with every claim and every pull
request. WORKFLOW.md has the rules; PROGRESS.md is the plain-language summary.

## Not ours

| Issue | Title | Why not ours |
| --- | --- | --- |
| #6, #8, #9, #11, #12, #13, #14 | Bugs from the September pull-request reviews | Closed. PR #54 (shivam-balyan) carries the follow-up fixes. |
| #7 | Revenue report: Due now counts stages not invoiced | Assigned to PavithraCJ |
| #10 | Sales review PDF: exchange-rate line ignores quotation section | Assigned to PavithraCJ |
| #41 | Exchange rates with effective dates | Assigned to PavithraCJ |
| #15 | Clean up duplication in the sales review PDF code | Assigned to shivam-balyan |
| #18 | Sales KPIs, user accounts, activity log | Assigned to shivam-balyan |
| #19 | Epic: product flow from enquiry to cash to renewal | Container for #20 to #31; not a work item |
| #32 | Epic: platform | Container for #33 to #38; not a work item |

## Waiting on a decision from the lead

| Issue | Title | Decision needed |
| --- | --- | --- |
| #17 | Migrate the web app to Next.js 16, shadcn/ui, Tailwind 4 | Whether to rewrite now. Every UI issue below is built in the current app until decided. |
| #51 | Mobile app for field staff | Scope and priority |
| #52 | Timesheets and utilisation | The issue itself says: decide first whether time is billed |

## Our batches

Status values: `todo`, `claimed`, `in progress`, `PR open`, `merged`.

### Batch 1: land what is built, then the foundations everything else needs

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #45 | Bulk import, export and data fixes | in progress | Importer built and tested on `feature/bulk-import`. Left to add from the issue: CSV template per import type, Excel export from lists, an audit entry per import. |
| #20 | Companies and contacts instead of typed client names | todo | Needed by #23, #24, #27, #29, #31. Includes de-duplicating the 68 client spellings, which the importer's name matching can help with. |
| #21 | Background jobs and email sending | todo | Needed by #22, #27, #28. Worker process, email log, sending kill switch. Needs an SMTP mailbox from the lead. |
| #36 | End-to-end tests (Playwright) for the critical flows | todo | Protects every later change. Quotation to PO to payment, and the import. |
| #37 | Dependency, container, code and secret scanning in CI | todo | CI configuration only. |

### Batch 2: selling

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #23 | Quotations as real documents: catalogue, line items, GST, validity, revisions, PDF | todo | Needs #20. Largest item in the batch. |
| #24 | Enquiries as leads: qualification, sources, follow-ups | todo | Needs #20. The importer gains an Enquiries step here. |
| #25 | Quotation pipeline: stages with probability, kanban, lost reasons, forecast | todo | Needs #23, #24. |
| #26 | PO received to project in one step, payment-schedule and onboarding templates | todo | Needs #23, #25. The importer's default splits become these templates. |
| #46 | Discount and exception approvals on quotations | todo | Builds on #23. |

### Batch 3: getting paid

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #22 | Tasks, notes, files and a timeline on every record | todo | Needs #18 (shivam-balyan) merged for owners and the activity log. |
| #27 | Collections: due dates, automatic reminders, chasing log, payments | todo | Needs #21, #26, #7. Invoices become their own table; the importer's invoice and receipt steps follow. |
| #28 | Renewals for recurring services | todo | Needs #23, #21, #25. |
| #40 | Cash-flow forecast from payment schedules and pipeline | todo | Needs #25, #27. |
| #44 | Notification centre and a daily digest | todo | Needs #21, #22. |

### Batch 4: client communication

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #29 | Connected mailboxes: Microsoft 365 sync onto records | todo | Needs #20, #21, #22 and a Microsoft 365 app registration from the lead. |
| #30 | Shared sales inbox | todo | Needs #29, #24. |
| #31 | One-click email, call and WhatsApp with every touch logged | todo | Phase 1 needs no providers. |
| #53 | Client acceptance of quotations, e-signature later | todo | Needs #23. |
| #43 | Certificates and deliverables registry | todo | Pairs with #28. |

### Batch 5: extended

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #39 | Project profitability: delivery cost against PO value | todo | Uses trips, vendor invoices and claims already tracked. |
| #42 | Audit and site-visit scheduling with auditor availability | todo | |
| #47 | Client portal | todo | Needs #20, #27, #43. Separate login surface; security review first. |
| #48 | Accounting integration (Tally or Zoho Books) and GST/TDS reports | todo | Needs an account from the lead. |
| #49 | Outgoing webhooks and n8n automation | todo | |

### Batch 6: platform and tooling, with the lead

| Issue | Title | Status | Notes |
| --- | --- | --- | --- |
| #50 | MCP server so Claude can answer questions from live tracker data | todo | Read-only, admin-scoped. |
| #38 | Error tracking, uptime checks and metrics | todo | We add the code side; the lead sets up the services. |
| #35 | A staging environment with its own database | todo | Lead: Dokploy. We: configuration and seed. |
| #33 | Database backups, off-site, with a restore drill | todo | Lead: server access. We: the scripts and the drill runbook. |
| #34 | Close the public database port, rotate secrets, harden the app | todo | Lead: server. We: password policy, rate limits, headers. |

The lead's own order puts #33, #34 and #35 first. They are last here only
because they need server access we do not have; the moment the lead gives it,
they jump to the front.

## Log

- 2026-09-17: plan written. Bulk import merged with today's `main` and green on
  all four checks. #45 claimed on this branch.
