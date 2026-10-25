# Server layer: the sales journey

Module layer under the feature spec
[`docs/specs/sales-journey/CLAUDE.md`](../../../../docs/specs/sales-journey/CLAUDE.md).
Read that first for the process, decisions and acceptance criteria. This file
says how the server side is built and fixes the API contract the web streams
build against (§5). Change §5 only together with
[`web/src/components/journey/CLAUDE.md`](../../../../web/src/components/journey/CLAUDE.md).

## 1. Where things live

| Concern | File |
| --- | --- |
| Facts per sale, one row each | `server/db/views.sql` → `v_sales_journey` (add it to the `DROP VIEW` list at the top; it depends on `v_quotations`, `v_purchase_orders`, `v_payment_stages`, so create it after them) |
| Thresholds | `server/db/migrations/099_sales_journey_settings.sql` (settings rows only), mirrored in `server/db/schema.sql` beside the other `INSERT INTO settings` blocks. Check the number is still free before the PR |
| Step, small steps, flag, next action, funnel: pure functions | `server/src/lib/journey/steps.js` |
| Reading rows (scoping, filters, INR conversion) | `server/src/lib/journey/queries.js` |
| Routes | `server/src/routes/journey.js` → `journeyRouter`, mounted at `/api/journey` in `app.js` after `requireAuth` and `hrGate`, beside `/api/pipeline` |
| Authorization | `server/src/lib/authz/policy.js`, pipeline section |

Files in `lib/journey/` are plain functions with no Express. `queries.js`
takes a `db` (anything with `.query`) so tests can pass a client. New files
may be `.ts` (`docs/typescript.md`), or `.js` like their neighbours.

A view-only change needs no migration: `db:upgrade` rebuilds `views.sql`
when it changes (`src/migrations.js`). The settings rows do need one.

## 2. Identity: what one sale is

`v_sales_journey` has one row per sale, anchored on the first of these that
exists:

1. **Quotation-anchored** (`journey_key = 'q-' || quotations.id`): every
   quotation.
   - Its enquiry: the earliest enquiry with `enquiries.quotation_no =
     q.quotation_no` (`ORDER BY enquiry_date NULLS LAST, id`).
   - Its POs: **live** POs linked to it (below).
2. **Enquiry-only** (`'e-' || enquiries.id`): an enquiry with
   `quotation_no IS NULL`.
3. **PO-only** (`'p-' || purchase_orders.id`): a live PO linked to no
   quotation.

**Live PO**: `NOT cancelled` and no other PO replaces it
(`replaced_by_po_number IS NULL` in `v_purchase_orders`). Cancelled and
replaced POs are ignored everywhere in the journey.

**A PO's quotation** (`po_link`): `po.quotation_no` when set; otherwise the
quotation on the PO's project, preferring `status = 'Won - PO Received'`,
then the highest `id`; otherwise none. Write it once as a CTE and use it for
both the quotation-anchored POs and the PO-only exclusion, so a PO is never
in two rows.

**Project lookup** (`/of?project=`): the quotation with that `project_id`,
won first, then highest id; else the PO-only journey of the project's
lowest-id live PO; else 404.

### Columns (facts only, nothing derived beyond aggregates)

| Group | Columns |
| --- | --- |
| Identity | `journey_key`, `anchor` (`'quotation'`, `'enquiry'`, `'po'`) |
| Who | `client_name`, `company_id`, `sales_person` (quotation's, else enquiry's, else project's), `service` (`service_quoted`, else enquiry `service`, else project `primary_service`), `enquiry_owner_id`, `quotation_owner_id`, `project_owner_ids int[]` (owners of the projects of its live POs) |
| Enquiry | `enquiry_id`, `enquiry_no`, `enquiry_date`, `enquiry_created_at`, `enquiry_status`, `enquiry_first_responded_at`, `enquiry_last_contacted_at`, `enquiry_estimated_value`, `enquiry_currency`, `enquiry_source`, `enquiry_unqualified_reason` (name) |
| Quotation | `quotation_id`, `quotation_no`, `quotation_date`, `quotation_created_at`, `quotation_status`, `quotation_value` (`total` when it has lines, else `quotation_value`), `quotation_currency`, `line_count`, `price_needed_count`, `sent_at`, `accepted_at`, `closed_at`, `stage`, `stage_type`, `approval_status`, `expired`, `lost_reason`, `expected_close_date`, `project_id` (the quotation's, else the project of its first live PO) |
| POs (live, aggregated) | `po_count`, `po_numbers text[]` (by `po_date`, then id), `first_po_id`, `first_po_number`, `first_po_date` (min `po_date`), `first_po_created_at`, `po_value_total`, `po_currency` (the one currency, else null), `pos_without_stages` (count with `stage_count = 0`), `stage_count`, `invoiced_total`, `received_total`, `stages_to_invoice`, `overdue_stages`, `overdue_amount` (Σ `due_now_amount` of Overdue stages), `billable_stages` (stages whose `stage_status` is not `Not Due` and that are not on hold), `next_stage_due` (earliest `invoice_due_date` of a stage not Paid), `fully_paid` (every live PO `payment_status = 'Fully Paid'`), `last_paid_on` (max `payment_received_date`), `delivered` (every live PO has `actual_delivery_date`) |
| Start | `started_on date` = the first of these that is set, in this order (`COALESCE`, not the earliest): `enquiry_date`, `enquiry_created_at`, `quotation_date`, `quotation_created_at`, `first_po_date`, `first_po_created_at` |

Read from the views that already compute things (`v_quotations`,
`v_purchase_orders`, `v_payment_stages`); do not re-derive their figures.

## 3. Rules (pure, `steps.js`)

`journeyState(row, settings, today)` returns everything the API adds to a
row. `today` is a `YYYY-MM-DD` string, passed in (tests pin it; routes use
`lib/businessDate.ts` if it gives the business date, else the server date).

### 3.1 Step and exit, in this order

| Condition | `step` | `exit` |
| --- | --- | --- |
| `po_count > 0` and `fully_paid` | `po` | `'paid'` |
| `po_count > 0` | `po` | null |
| quotation and (`stage_type = 'lost'` or `quotation_status = 'Lost'`) | `quotation` | `'lost'` |
| quotation | `quotation` | null |
| `enquiry_status = 'Unqualified'` | `enquiry` | `'unqualified'` |
| otherwise | `enquiry` | null |

A PO beats a lost quotation: money ordered is the fact that matters.

### 3.2 Big steps

Three entries, keys `enquiry`, `quotation`, `po`, labels `Enquiry`,
`Quotation`, `PO`. State: `done` before `step`, `current` at `step`
(`exit` set: `exit` instead of `current`; a paid journey's PO is `done`),
`future` after; a step before `step` with no record is `skipped` (hollow,
"Not recorded"), never `done`.

### 3.3 Small steps

Each small step has a `reached` test. The journey is **at** the furthest
reached one: that one is `current`, reached ones before it `done`, unreached
ones before it `skipped`, the rest `future`. `small_step` is the label of the
one it is at (or the fallback when none is reached).

| Step | Small steps and `reached` | Nothing reached |
| --- | --- | --- |
| Enquiry | **New**: always. **Contacted**: `first_responded_at` or `last_contacted_at` or status in Contacted, Qualified, Nurture, Converted. **Qualified**: status in Qualified, Converted | n/a |
| Quotation | **Priced**: `line_count > 0` or `quotation_value > 0`. **Sent**: `sent_at` or status not Draft. **Negotiating**: status Under Negotiation, or Accepted/Won reached. **Accepted**: `accepted_at`, or Won reached. **Won**: status `Won - PO Received` or `stage_type = 'won'` | `'Draft'` |
| PO | **Registered**: always. **Split set**: `pos_without_stages = 0`. **Billable**: `billable_stages > 0` or `invoiced_total > 0`. **Invoiced**: `invoiced_total > 0`. **Paid**: `fully_paid` | n/a |

Each small step carries its date when one is known (Sent → `sent_at`,
Accepted → `accepted_at`, Registered → `first_po_date`).

### 3.4 Days in step

`step_since`: each record's own date first, the day it was keyed in only
when that is blank. Enquiry → `enquiry_date`, else `enquiry_created_at`;
Quotation → `quotation_date`, else `quotation_created_at`; PO →
`first_po_date`, else `first_po_created_at`. (Counting from `created_at` made
every bulk-imported record look a day old.) `days_in_step = today −
step_since` in whole days, never negative; a timestamp is read as the
business day it fell on (`businessDate.ts`).

### 3.5 Flag: at most one, first match wins

| # | When | `kind` | `label` | `tone` |
| --- | --- | --- | --- | --- |
| 1 | step `po`, `overdue_stages > 0` | `overdue` | `"<money> overdue"` (`overdue_amount`, `po_currency`); POs in several currencies: `"N stages overdue"` | `late` |
| 2 | step `quotation`, `approval_status = 'pending'` | `approval` | `"Discount needs approval"` | `waiting` |
| 3 | step `quotation`, `price_needed_count > 0`, not won | `price` | `"N lines need a price"` (1: "1 line needs a price") | `waiting` |
| 4 | step `quotation`, Sent not reached, `days > journey_unsent_days` | `unsent` | `"Unsent <d> days"` | `waiting` |
| 5 | over the step's limit × 2 | `stuck` | `"Stuck <d> days"` | `late` |
| 6 | over the step's limit | `slow` | `"Slow <d> days"` | `waiting` |
| 7 | step `enquiry`, status Nurture | `nurture` | `"Nurturing"` | `info` |

"Over" is strictly greater (7 days on a 7-day limit is fine). The PO limit
applies only while `invoiced_total = 0` (30 days to the first invoice).
Exited journeys carry no flag. Money is formatted as the web formats it
(`₹3,00,000`); put the formatter in `steps.js` or reuse an existing server
one, never a hand-built string per call site.

### 3.6 Next action

One `{ verb, label }` for the current step; `null` for an exited journey.

| Step and state | `verb` | `label` |
| --- | --- | --- |
| Enquiry, Contacted not reached (§3.3: status New and no contact date) | `contact` | `Contact them` |
| Enquiry, Qualified reached | `convert` | `Convert to quotation` |
| Enquiry, otherwise | `follow_up` | `Log a call` |
| Quotation, approval pending | `approve` | `Review the discount` |
| Quotation, `price_needed_count > 0` | `price` | `Price the lines` |
| Quotation, Sent not reached | `send` | `Send to the client` |
| Quotation, Accepted or Won reached | `register_po` | `Register the PO` |
| Quotation, otherwise | `follow_up` | `Follow up` |
| PO, Split set not reached | `set_split` | `Set the payment split` |
| PO, `overdue_stages > 0` | `chase` | `Chase payment` |
| PO, `stages_to_invoice > 0` | `raise_invoice` | `Raise the invoice` |
| PO, otherwise | `open` | `Open the order` |

The web always opens the record of the current step for it (spec C4).

### 3.7 Funnel

`funnel(rows, from, to)`: the cohort is rows with `started_on` in
`[from, to]`, exited ones included. `started` = cohort size; `quoted` = with
a quotation or `po_count > 0`; `won` = quotation Won reached or `po_count >
0`; `with_po` = `po_count > 0`. Each figure holds the next, so the funnel
never widens: a sale ordered with no quotation on record still got past
quoting. Rates are not stored or returned; the web divides. The funnel is
counted after the owner and service filters and the caller's scope, and
before the board's switches (stuck, closed, cohort).

### 3.8 Board visibility

By default a card is shown when `exit` is null, or `exit = 'paid'` and
`last_paid_on` is within `journey_paid_visible_days` of today. `closed=1`
shows everything. `cohort=<name>` shows the cohort's members, exited
included, and ignores the default rule.

## 4. Settings

`099_sales_journey_settings.sql`, `INSERT … ON CONFLICT (key) DO NOTHING`,
each with a `notes` sentence written for Settings › Assumptions:

| Key | Default | Note |
| --- | --- | --- |
| `journey_stuck_enquiry_days` | `7` | Days an enquiry can wait before the Journey board calls it slow; stuck after twice this. |
| `journey_stuck_quotation_days` | `21` | Days a quotation can stay open before the Journey board calls it slow; stuck after twice this. |
| `journey_unsent_days` | `5` | Days a quotation can stay unsent before the Journey board nudges. |
| `journey_stuck_po_days` | `30` | Days a PO can go with nothing invoiced before the Journey board calls it slow; stuck after twice this. |
| `journey_paid_visible_days` | `30` | Days a fully paid sale stays on the Journey board. |

Read them in `queries.js` with fallbacks to these defaults, as numbers; a
blank or bad value falls back (the `setting_num` rule in `views.sql`).

## 5. API contract (the web builds against this)

Both routes: `GET`, signed in, scoped (§6). Money is a number in its own
currency plus a `currency` code; `value_inr` is converted at the record's
own date with `RATES` / `rateOn` from `lib/salesReport.js`, the way
`lib/pipeline.js` converts, and is `null` without a rate.

### `GET /api/journey`

Query: `sales_person`, `service` (exact), `stuck=1` (flag `stuck` or `slow`
or `overdue` or `unsent`), `closed=1`, `from`, `to` (`YYYY-MM-DD`, funnel
period; default the 90 days to today), `cohort` (`started` | `quoted` |
`won` | `with_po`). Anything malformed, or a parameter given twice → 422
with `fields`.

```jsonc
{ "data": {
  "period": { "from": "2026-07-27", "to": "2026-10-25" },
  "funnel": { "started": 42, "quoted": 31, "won": 12, "with_po": 9 },
  "steps": [
    { "key": "enquiry", "label": "Enquiry", "count": 14, "value_inr": 6200000, "without_rate": 0, "median_days": 4 },
    { "key": "quotation", "label": "Quotation", "count": 16, "value_inr": 12000000, "without_rate": 1, "median_days": 11 },
    { "key": "po", "label": "PO", "count": 11, "value_inr": 14000000, "without_rate": 0, "median_days": 26 }
  ],
  "stuck_count": 6,                      // cards on the board that "Stuck only" keeps, counted before that switch
  "cards": [ Card ],
  "settings": { "enquiry_days": 7, "quotation_days": 21, "unsent_days": 5, "po_days": 30, "paid_visible_days": 30 }
} }
```

`steps[].count`, `value_inr` and `median_days` are over the cards returned
(after filters), so scoping and filtering change no arithmetic.

`Card`:

```jsonc
{
  "key": "q-118",
  "step": "quotation",                    // 'enquiry' | 'quotation' | 'po'
  "exit": null,                           // null | 'lost' | 'unqualified' | 'paid'
  "small_step": "Accepted",
  "progress": ["done", "current", "future"], // the three big steps' states (§3.2)
  "days_in_step": 24,
  "step_since": "2026-10-01",
  "flag": { "kind": "slow", "label": "Slow 24 days", "tone": "waiting" },   // or null
  "next": { "verb": "register_po", "label": "Register the PO" },       // or null
  "client_name": "Midal Cables", "company_id": 7,
  "service": "ISO 9001 certification", "sales_person": "Shyam Sharma",
  "value": 590000, "currency": "INR", "value_inr": 590000,            // the current step's value
  "records": { "enquiry_no": "CTZ/ENQ/2026/004", "quotation_no": "Q-118", "po_number": null, "project_id": null },
  "started_on": "2026-09-18"
}
```

The current step's value: Enquiry → `enquiry_estimated_value`; Quotation →
`quotation_value`; PO → `po_value_total` (`po_currency`; null when mixed).
`records.po_number` is the first live PO's.

Order: by step (enquiry, quotation, po), then flag tone (late, waiting,
info, none), then `days_in_step` descending, then `key`.

### `GET /api/journey/of`

Exactly one of `enquiry`, `quotation`, `po`, `project` (the record's own
number, or its id when no record has that number, as `lib/crud.js` reads a
key). 422 if none or several; 404 (`"Journey not found"`, the same for a
miss and a refusal) when no journey holds the record or the caller cannot
reach it. A cancelled or replaced PO is in no journey, so its page asks by
its quotation or project instead.

```jsonc
{ "data": {
  ...Card,
  "steps": [
    {
      "key": "enquiry", "label": "Enquiry",
      "state": "done",                    // 'done' | 'current' | 'future' | 'skipped' | 'exit'
      "record": { "kind": "enquiry", "no": "CTZ/ENQ/2026/004", "date": "2026-09-18" },  // or null
      "since": "2026-09-18",              // when the sale entered this step, null if never
      "reachable": true,                  // the caller may open this record (§6); false with no record
      "small": [ { "label": "New", "state": "done", "date": null }, ... ],
      "facts": [ { "label": "Source", "value": "Email", "kind": "text" },
                 { "label": "Estimate", "value": 450000, "kind": "money", "currency": "INR" },
                 { "label": "Received", "value": "2026-09-18", "kind": "date" } ]
    },
    { "key": "quotation", ... },
    { "key": "po", ..., "record": { "kind": "po", "no": "PO 4500183", "date": "2026-08-20", "count": 2 } }
  ]
} }
```

`small` is filled for every step that has a record (so the drawer can show
any step), using §3.3 for that step. `facts`, up to six per step:

- Enquiry: Received, Source, Owner (`sales_person`), Estimate, Status,
  Unqualified because (when set).
- Quotation: Quotation no., Date, Value, Sent, Client said (Accepted on /
  No answer yet), Expected close; Lost because (when lost).
- PO: PO no. (and "+N more" when several), Registered, Value, Invoiced,
  Received, Next stage due (the earliest `invoice_due_date` of a stage not
  Paid), Overdue (when any).

Six at most: where a step has a seventh, one replaces another rather than
being added (Lost because replaces Expected close; Overdue replaces Next
stage due). POs in several currencies show their sums as the text "In
several currencies", never a made-up total. Values are raw (numbers, ISO
dates); the web formats them.

## 6. Scoping and authorization

- Admin (unrestricted scope): every journey.
- Sales: rows where `enquiry_owner_id = me OR quotation_owner_id = me OR
  me = ANY(project_owner_ids)` (spec D7).
- What a sales user sees of a record they do not own (spec D11,
  `reachableSteps`, `cardFor`, `detailFor` in `steps.js`): the enquiry is
  theirs by `enquiry_owner_id`, the quotation by `quotation_owner_id`, the
  PO by either `quotation_owner_id` or a project owner, as each record's own
  page reaches it. A step whose record is not theirs keeps its number,
  state and small steps, with `reachable: false` and no `facts`. When that
  step is the current one, the card's `value`, `currency` and `value_inr`
  are null, `next` is null, and an overdue flag reads `"N stages overdue"`
  instead of the amount. Build the predicate the way
  `auth/ownership.js` builds its others (`scopeOf(req)`, parameters pushed,
  never interpolated), as a function in `queries.js` with its own unit test
  of the SQL text.
- HR: refused by `hrGate` (not an HR path); pin it with a test.
- Filters are parameters, never interpolated.
- Declare both routes in `policy.js`:
  `{ method: 'GET', path: '/api/journey', access: signedIn, restrictions: ['record-owner'], note: '…' }` and the same for `/api/journey/of`.

## 7. Tests (`server/test/`, `node --test`)

| Test | Pins |
| --- | --- |
| `journeySteps.test.js` (no database) | Every row of §3.1–3.8: each exit, PO-beats-lost, each small step and its fallback, skipped vs done, days never negative, every flag with its boundary (limit and limit + 1, 2×limit and 2×limit + 1), PO limit only before the first invoice, flag order, every next action, funnel cohort edges, visibility rule |
| `journey.test.js` (`TEST_DATABASE_URL`, its own database as `questionnaires.test.js` does) | Identity: quotation with enquiry; enquiry-only; PO-only; PO with no `quotation_no` joining its project's won quotation; cancelled and replaced POs ignored; two POs aggregated. API: board shape, filters, cohort, `closed`, `/of` by each kind including an encoded enquiry number with slashes, 404 and 422. Scope: a sales user sees a journey through each of the three ownership routes and not another's; HR 403; a changed setting changes a flag. Made-up clients only |
| `authzPolicy.test.js`, `authorization.test.js` | Pass with the routes declared |

Run with `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test`
in `server/`; `npm run typecheck` too.
