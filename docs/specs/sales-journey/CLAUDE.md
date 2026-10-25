# Spec: the sales journey, Enquiry → Quotation → PO

The feature-level layer. Read this before changing anything about the
journey rail, the Journey board on Pipeline, the step drawer or the Enquiry
page. Module rules live beside the code:

- Server: [`server/src/lib/journey/CLAUDE.md`](../../../server/src/lib/journey/CLAUDE.md)
- Web: [`web/src/components/journey/CLAUDE.md`](../../../web/src/components/journey/CLAUDE.md)
  (and [`web/CLAUDE.md`](../../../web/CLAUDE.md), which wins on anything visual)

Background: the UI/UX plan `plans/enquiry-to-po-journey-plan.md` and the
reviewed mockups ("Sales Journey" artifact) in the project files, built on the
redesign brief's process rail (§5.1). Where this file and the plan differ,
this file wins; §8 lists every difference.

---

## 1. The problem we are solving

A salesperson cannot see one sale from first enquiry to purchase order in
one place, or all sales at once by where they have got to:

1. The journey is split across four lists (Enquiries, Deals, Pipeline,
   Orders). Following one client's sale means hopping between them.
2. Each record page draws a different rail: the Deal page 9 steps, the Order
   page a different 5, the Project page its onboarding. None of the steps
   can be clicked.
3. An enquiry has no page, only a row and an edit dialog, so the first step
   has nowhere to drill into.
4. Pipeline shows quotations only; enquiries waiting for a quote and won
   deals waiting for a PO, where work most often stalls, are invisible.

## 2. The journey

One journey per sale, **three big steps, drawn the same way everywhere**.
Every big step links to its record. The small steps show only inside the
big step the sale is on.

| Big step | Record behind it | Small steps (in order) | The sale is here while |
| --- | --- | --- | --- |
| **Enquiry** | `enquiries` | New → Contacted → Qualified | it has no quotation and no PO |
| **Quotation** | `quotations`, Draft to Won (the app's "Deal") | Priced → Sent → Negotiating → Accepted → Won | it has a quotation and no live PO |
| **PO** | `purchase_orders` + payment stages | Registered → Split set → Billable → Invoiced → Paid | it has at least one live PO |

- A sale **exits** at the step it stopped at: *Lost* at Quotation, or
  *Unqualified* at Enquiry. A sale whose every live PO is fully paid is
  *Paid*: complete, and it leaves the board after `journey_paid_visible_days`.
- Every step, small step, date, flag and next action is **computed on read**
  from facts the database already holds. Nothing new is stored except five
  settings (§6 D4). Exact rules: server layer §3.

```text
Enquiry ──convert──▶ Quotation ──register PO──▶ PO ──all stages paid──▶ (complete)
   │                     │
   └─ Unqualified        └─ Lost
```

## 3. What ships (by part)

| # | Part | Where | Primary user value |
| --- | --- | --- | --- |
| S | Journey facts view + API | `server/db/views.sql` `v_sales_journey`, `server/src/lib/journey/`, `server/src/routes/journey.js` | One source for every screen below |
| R | Journey rail | `web/src/components/journey/JourneyRail.jsx`, extensions to `components/record.jsx`, used on the Quotation, PO and Project pages | Same three steps everywhere, each a link, small steps under the current one |
| E | Enquiry page | `web/src/pages/EnquiryDetail.jsx` at `/enquiries/:key` | The first step gets a page, rail and timeline |
| B | Journey board + step drawer | `web/src/components/journey/JourneyBoard.jsx`, `JourneyDrawer.jsx`, default view of `pages/Pipeline.jsx` | Every open sale by step, funnel strip, drill into any step without leaving |

## 4. Acceptance criteria

### S. Facts and API
- [ ] `v_sales_journey` returns exactly one row per sale under the identity
      rules of the server layer §2 (quotation-anchored, enquiry-only,
      PO-only), and ignores cancelled and replaced POs.
- [ ] `GET /api/journey` returns the three step summaries, the funnel for a
      period, and the cards, scoped to the caller (server §5).
- [ ] `GET /api/journey/of?enquiry|quotation|po|project=` returns one
      journey with its three steps, small steps and facts; 404 when the
      caller cannot reach it or no journey holds that record.
- [ ] Step, small step, days in step, flag and next action follow the truth
      table in server §3, pinned by pure unit tests.
- [ ] Thresholds come from Settings; changing one changes the flags with no
      deploy.
- [ ] A sales user sees only journeys holding a record they own; HR is
      refused; both routes are declared in `lib/authz/policy.js`.

### R. Rail
- [ ] Quotation, PO and Project pages show the three-step journey rail in
      place of their own rails; the page's sentence, primary button and
      small print are unchanged in meaning.
- [ ] Done steps show the record number and date and link to the record;
      hovering or focusing one previews it; the current step shows days in
      step with a tone and word when slow or stuck.
- [ ] The small steps of the current step sit under it.
- [ ] A step with no record ("Not recorded") is hollow and not a link.
- [ ] Loading shows a skeleton the rail's height; an error keeps the page's
      sentence and actions usable and says the journey could not load.
- [ ] Trip keeps its own rail (travel is a different process).

### E. Enquiry page
- [ ] `/enquiries/<encoded enquiry_no>` opens a record page with the rail at
      Enquiry, facts, questionnaire, the email it came from, and timeline.
- [ ] One primary action by state: Qualified → **Convert to quotation**;
      otherwise **Log a call**. Converting reuses the existing enquiry form
      and server rules; nothing is duplicated.
- [ ] The Enquiries list links each row to its page; the list's edit dialog
      still works.

### B. Board and drawer
- [ ] Pipeline opens on **Journey**; a switch shows today's **Quotation
      stages** board unchanged (`?view=stages`).
- [ ] Three columns with count, INR value and median days; cards show
      client, service, value, owner, days or flag, the small step, a
      three-segment progress mark and the next action.
- [ ] Funnel strip (Started → Quoted → Won → With PO, with conversion %) for
      a period, default last 90 days; each number filters the board to that
      cohort.
- [ ] Filters live in the URL: owner (sales person), service, stuck only,
      show closed, period, cohort.
- [ ] Clicking a card opens the step drawer: the journey down the side,
      each step clickable, arrow keys move, Esc closes and returns focus;
      one action for the current step and **Open full page**.
- [ ] No drag between big steps.
- [ ] Below `lg` the board becomes three tabs with counts.
- [ ] Empty, loading and error states on the board and the drawer.

### Everywhere
- [ ] `npm test --prefix server` (with `TEST_DATABASE_URL`), and in `web/`
      `npm test`, `npm run typecheck`, `npm run build` pass.
- [ ] `web/CLAUDE.md` §4 and `web/test/uiConsistency.test.js` describe and
      pin the new rail (§8 C1).
- [ ] Light and dark, 1440 and 390 wide.

## 5. Build plan: parallel streams

The contract between streams is the API shape in server §5 and the component
props in web §2. Each stream builds against the contract, not against the
other's code, so they run at the same time.

```text
S  server: view, steps, API, policy, tests ───────────────────────────────┐
R  web: record.jsx extension, lib/journey.js, JourneyRail, page wiring ─┐ │
                                                                         ├─┼─▶ integrate ─▶ review ─▶ PR
E  web: Enquiry page (after R) ──────────────────────────────────────────┤ │
B  web: Journey board + drawer (after R) ────────────────────────────────┘ │
```

| Stream | Owns these files (others do not touch them) | Depends on |
| --- | --- | --- |
| S | `server/**` (view, migration, `lib/journey/*`, `routes/journey.js`, `app.js` mount, `lib/authz/policy.js`, tests) | contract only |
| R | `web/src/components/record.jsx`, `web/src/lib/journey.js`, `web/src/components/journey/JourneyRail.jsx`, `QuotationDetail.jsx`, `PurchaseOrderDetail.jsx`, `ProjectDetail.jsx`, `web/test/uiConsistency.test.js`, `web/CLAUDE.md` §4 | contract only |
| E | `web/src/pages/EnquiryDetail.jsx`, `web/src/pages/Enquiries.jsx`, `web/src/App.jsx` (route only) | R |
| B | `web/src/components/journey/JourneyBoard.jsx`, `JourneyDrawer.jsx`, `web/src/pages/Pipeline.jsx`, `web/test/journey*.test.js`, `web/e2e` (one flow) | R |

One branch, one PR, one commit per stream so the history reads by part.

## 6. Decisions

| # | Decision | Source |
| --- | --- | --- |
| D1 | Three big steps: Enquiry, Quotation, PO. Quotation and Deal are one step, matching the app, where they are one record | Shyam, 25 Oct 2026 |
| D2 | Journey is the default view on Pipeline; a switch keeps the stage board for weighted forecasting | Recommended option, accepted 25 Oct |
| D3 | The journey stops at PO; Invoiced and Paid are small steps inside PO | Recommended, accepted 25 Oct |
| D4 | Slow after: Enquiry 7 days, Quotation 21 (an "Unsent" nudge after 5 days still in Draft), PO 30 days with nothing invoiced; stuck after twice that. Paid sales stay 30 days. All five in Settings (`settings` table) | Recommended, accepted 25 Oct |
| D5 | No drag on the Journey board; a card's button moves a sale on | Recommended, accepted 25 Oct |
| D6 | Steps are computed on read (`v_sales_journey` facts + `lib/journey/steps.js`); no column stores a step | CLAUDE.md rule 1 |
| D7 | A sales user reaches a journey when they own any record in it (its enquiry, its quotation, or a project it sits on: its own, or the project of one of its POs); opening a linked record they do not own gives the usual 404. An enquiry can be linked only to a quotation its saver can reach, so the link cannot be typed in to reach someone else's sale | This spec, matches `scopedSources` reach |
| D8 | Lost and Unqualified sales are hidden unless "Show closed"; Paid ones show for `journey_paid_visible_days` | Plan §3.2 |
| D9 | A funnel number filters the board to its cohort, closed sales included, so the figure opens the records behind it (`web/CLAUDE.md` §2.5) | This spec |
| D10 | Below `lg` the board is three tabs; the rail stacks vertically on a phone | Plan §3.5 |
| D11 | A sales user sees a linked record they do not own by its number only: no facts, no value, no link, no next action (server §6). This settles §9 question 1 | Integration review, 25 Oct; follows question 1's default |
| D12 | Days in step count from each record's own date (enquiry date, quotation date, PO date), not the day it was keyed in | Integration review, 25 Oct: imported records looked a day old |
| D13 | The funnel never widens: a sale with a PO counts as quoted even with no quotation on record | Integration review, 25 Oct |

## 7. Out of scope

- Doing a step's action on the card itself (convert, send, register): the
  card's button opens the record where that action already lives (§8 C4).
- Steps after PO beyond Paid (renewal, certificates).
- MCP tools, webhooks or reports for the journey.
- Storing or caching a step, a date in step or a flag.

## 8. Differences and conflicts

| # | Between | Conflict | Resolution in this spec |
| --- | --- | --- | --- |
| C1 | Plan ↔ code | `web/CLAUDE.md` §4 names the nine-step sales flow and `uiConsistency.test.js` pins the Deal's nine labels and `flowSteps(` on each record page | Both change in this PR: the Quotation, PO and Project pages render `<JourneyRail>`, which renders `<RecordFlow>`; the test pins the three journey labels and JourneyRail on those pages, and keeps `RecordFlow` + `flowSteps` on Trip |
| C2 | Plan ↔ code | Today's PO rail has a *Delivered* rung; the journey's PO small steps do not | Delivery stays in the PO page's sentence ("the 50% on delivery stage unlocks when…"); it is not a journey step |
| C3 | Plan ↔ D1 | The plan drew four steps and a "Lost at Deal" end-cap | Three steps; "Lost at Quotation" |
| C4 | Plan ↔ code | The plan has the card's button do the move ("Convert", "Send", "Register PO"), but each opens a dialog that lives on its record page | The card's button opens the record of the current step, where that one primary action is; inline actions are a later change |
| C5 | Plan ↔ data | The funnel's first figure was "Enquiries received", but sales can start at a quotation or a PO | First figure is "Started"; Quoted, Won and With PO follow |
| C6 | Plan ↔ code | The plan's owner filter is by person; Pipeline filters by the free-text `sales_person` | The board uses the same `sales_person` filter and `lookups.sales_people` |
| C7 | Plan ↔ code | Enquiry numbers contain slashes (`CTZ/ENQ/2026/004`) | Links always `encodeURIComponent` the number; journey keys use internal ids (`q-12`) |
| C8 | Plan ↔ code | A project can carry several quotations, and a PO may name none | Server §2: a PO with no quotation joins the won (else newest) quotation on its project; a project page shows that quotation's journey |
| C9 | Spec ↔ code (found while building) | Server §3.4 counted days from `created_at`; §3.5's slow label was a bare "24 days"; §3.7's Quoted could be smaller than Won; the web counted Stuck only itself | Fixed in code and spec: D12, "Slow 24 days" (word + tone, `web/CLAUDE.md` §1), D13, the server's `stuck_count` |
| C10 | Spec ↔ code (found while building) | D7 let a sales user reach a sale through one record but showed every record's facts | D11 |
| C11 | Spec ↔ code (found in review) | D11 judged the PO step by the sale's quotation owner or any project owner; a PO's own page asks the quotation the PO names or its own project. The Enquiry page's button opened a quotation the viewer could not. `started_on` was cast in UTC. POs in several currencies dropped out of the column's rupees. A Converted enquiry with no quotation got "Convert" on the card and "Log a call" on its page | Server §6 (`po_reachable`, every live PO), web §2 (`onJourney`), server §2 (`startedOn`), server §5 (`value_hidden`, column sums), server §3.6 (convert only when Qualified) |
| C12 | Spec ↔ code (found in the final review) | D7 named only the projects of a sale's POs, so a project's owner lost the rail on their own project until its first PO. A sales user could link their enquiry to a colleague's quotation and so reach that sale. The Enquiry step's Owner was the sale's salesperson (the quotation's). The Enquiry page offered Convert on a Converted enquiry with no quotation, and saving it created nothing | D7 now includes the sale's own project and refuses the typed link (`saveEnquiry`, as `linkProjectQuotation`); server §2 `enquiry_sales_person`; web layer, Enquiry page (no Convert once Converted) |

## 9. Open questions

None blocking. Defaults apply until Shyam says otherwise:

1. ~~Should a sales user see a linked record's number when they do not own
   it (D7)?~~ Settled by D11: the number only.
2. Should the journey reach Renewals later? Default: not in this spec.
