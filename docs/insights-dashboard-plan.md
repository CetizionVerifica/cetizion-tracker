# Insights dashboard: implementation plan

One screen, **Insights**, that answers five questions with charts. Each chart
clicks through to the filtered list of records behind it:

1. **Quotations past their follow-up date.** Which open quotations have a
   follow-up date that has already passed?
2. **Unpaid client invoices.** What do clients owe us, and how late is it?
3. **Enquiries at risk.** Which enquiries need handling before it is too late?
4. **POs in the pipeline.** Which deals are about to become purchase orders,
   and which POs have not been fully billed yet?
5. **Expected revenue by period.** How much money do we expect each month or
   quarter?

This file is written for the person (or Claude Code session) who builds it.
Read [PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md) first; the plan follows its
two design rules: nothing derived is stored, and each fact is typed in one
place. It was written against commit `5db1ccb`.

---

## 1. What already exists, and why it is not this

Most of the data and the chart kit are already built. The work is mostly to
**assemble** them, add one new metric (enquiries at risk) and close a few gaps.

| Question | Already answers part of it | Gap |
| --- | --- | --- |
| 1. Quotations past follow-up | `lib/followUps.js` derives a follow-up date. It uses the earliest open task (`NEXT_TASK`, `nextTask()`), otherwise an idle rule from `quotationStart()`. `scheduleState()` and `dueInfo()` decide whether that date is missed. `/follow-ups` lists the cycles the daily job opened. | The list only holds cycles the job created, and only when `followup_enabled='true'`, which is off by default. No endpoint lists **every** open quotation that is overdue for follow-up. `loadRecords()` is unscoped. There is no chart. |
| 2. Unpaid invoices | `v_payment_stages` gives `invoice_due_date`, `days_overdue` and `due_now_amount`. `/collections` returns ageing buckets. The Reports page has an ageing chart. | `/collections` is INR-only and unscoped by design. There is no scoped, FX-converted ageing, and no top-debtors chart. |
| 3. Enquiries at risk | `enquiries.next_follow_up_at` and the enquiry idle rule in `followUps.js`. Notification sweep in `notify.js`. | No "at risk" metric at all. `expected_decision_date` and `first_responded_at` are unused, and there is no response-time measure. |
| 4. POs in the pipeline | `/pipeline` returns stage counts and weighted value, scoped and FX-converted, including the "Verbal yes / awaiting PO" stage at 90%. `v_purchase_orders.payment_status` and `balance_to_bill`. | PO status appears only as a table in `RevenueReport`. Nothing shows "awaiting PO" next to "PO received, still to bill". |
| 5. Expected revenue | `lib/cashflow.js` gives months of received, invoiced, scheduled and weighted pipeline. `revenueReport()` is scoped and FX-converted. `pipeline.forecast` groups by expected close month. `lib/quarters.js` handles Indian FY quarters. | Cash flow is INR-only and unscoped. No forecast is both scoped and FX-converted, and none groups by quarter. |

**Summary:** the tracker can already compute almost every number. What is
missing is (a) one scoped, currency-correct summary endpoint for all five,
(b) an "enquiries at risk" rule, and (c) a single page that shows them as
charts with drill-down.

---

## 2. Scope

### In scope

1. A new page **Insights** at `/insights`, lazy-loaded like `/reports`. It has
   five sections, one per question, each with headline tiles, one or two
   charts and a short "act on these" list.
2. A global filter bar: **owner** (admins only), **period granularity**
   (month / quarter / FY), **horizon** (3 / 6 / 12 months) and **currency
   mode** (INR converted at the record-date rate, unconverted amounts noted
   in a footnote, never guessed). The filters live in the URL so a link
   carries them.
3. A new endpoint `GET /api/insights` (one round trip), plus focused
   per-section endpoints only where one is too heavy (see §4).
4. A new pure rule, **enquiry risk**, in `server/src/lib/enquiryRisk.js`.
5. Drill-down filters that the list pages do not yet accept (see §5.3).
6. Tests: pure rules, database-backed endpoint, authz, web unit and e2e.

### Out of scope (say so in the PR)

- Changing how follow-up cycles, escalation or reminders work.
- New stored columns. Every value is derived on read (design rule 1).
- Targets and quotas beyond what `salesTargets.js` already provides.
- PDF/CSV export of the dashboard. Reports and SalesReport already export.
  This can be a follow-up.
- Live push updates. The page refetches on focus and offers a refresh button.

---

## 3. The page: what the user sees

### 3.1 Layout

```
┌ PageHeader: Insights ─────────────── [Owner ▾] [Month|Quarter|FY] [3|6|12] ⟳ ┐
│ ── "Needs action now" strip: 5 Stat tiles, one per question, each a link ── │
│  Overdue follow-ups 14 │ Overdue invoices ₹38.2L │ Enquiries at risk 6 │      │
│  Awaiting PO ₹1.1Cr (9) │ Expected next 90 days ₹2.4Cr                        │
├───────────────────────────────────────┬─────────────────────────────────────┤
│ 1. Quotations past follow-up          │ 2. Unpaid invoices                  │
│   bar: days overdue bucket × count    │   stacked bar: ageing bucket (INR)  │
│   by owner (admin)                    │   top 10 clients (horizontal bar)   │
│   list: 5 most overdue → open record  │   list: 5 oldest → Collections      │
├───────────────────────────────────────┼─────────────────────────────────────┤
│ 3. Enquiries at risk                  │ 4. POs in the pipeline              │
│   bar by reason (no reply, follow-up  │   funnel: Sent → Negotiation →      │
│   missed, decision near, idle)        │   Awaiting PO → PO received → Billed│
│   list: worst first, with reason chip │   bar: PO payment_status            │
├───────────────────────────────────────┴─────────────────────────────────────┤
│ 5. Expected revenue by period (full width)                                  │
│   stacked bar per period: received ▮ invoiced ▮ scheduled ▮ weighted pipeline│
│   + line: target (if set)   toggle: cash basis / order basis               │
└─────────────────────────────────────────────────────────────────────────────┘
```

The grid uses `@container` with `@3xl:grid-cols-2`, as in `Reports.jsx`.
Below 640px every `ChartCard` already falls back to its table.

### 3.2 How it guides the user

The user asked for a screen that *guides*, not just reports. So:

- **Each section opens with its question in plain words** as the card title,
  for example "Which quotations are past their follow-up date?". A one-line
  answer follows: "14 quotations, oldest 23 days. Start with Acme (₹12L)."
- **"Needs action now" strip.** Each tile has a tone: danger when
  the number is above zero and overdue, warning when it is close. Each tile
  is a link (`Stat` `to=`) to the filtered list.
- **Every bar, slice and row is clickable**, with the same pattern as
  Reports: `ChartCard` `rows[].href` leads to the list page with filters in
  the URL.
- **Top-5 action lists** under each chart carry the *next action* on the
  row, reusing `actions.jsx`: Log a touch, Chase, Open quotation.
- **Empty states say what good looks like**, for example "No quotations past
  follow-up. Nice." They use `Empty` from `ui.jsx`.
- **Explain the rule** with an ⓘ tooltip on each card. Example: "A follow-up
  is overdue when its date has passed and nothing was logged since. With no
  date set, after 5 working days of silence (Settings → Follow-ups)."
  The tooltip reads the live setting values.
- **⌘K entries**: "Insights", "Overdue follow-ups", "Enquiries at risk",
  "Expected revenue". Add them to `JUMPS` in `lib/commands.js`.
- **Today link**: one line on Today ("See all insights →"). Do not duplicate
  the charts there.

### 3.3 Charts per question

| # | Chart | Recharts form | Drill-down target |
| --- | --- | --- | --- |
| 1 | Overdue follow-ups by days overdue (1–3, 4–7, 8–14, 15+) | `BarChart` | `/quotations?follow_up=overdue&overdue_days=8-14` (new filter) |
| 1 | By owner, admins only | horizontal `BarChart` | same, plus `&owner=` |
| 2 | Ageing: not due / 1-30 / 31-60 / 61-90 / 90+ (INR) | stacked `BarChart` (invoiced vs part-paid) | `/collections?bucket=` (exists) |
| 2 | Top 10 clients by overdue | horizontal `BarChart` | `/companies/:id` (Collections tab) |
| 3 | At-risk enquiries by reason | `BarChart` | `/enquiries?risk=no_reply` (new filter) |
| 3 | Enquiry age vs value | `ScatterChart` (optional, v2) | the record |
| 4 | Deal → PO → billed funnel | `BarChart` laid out as a funnel (Recharts `FunnelChart` is weak with labels) | `/quotations?stage_id=`, `/purchase-orders?payment_status=` |
| 4 | Awaiting PO by expected close month | `BarChart` | `/quotations?stage_id=<awaiting>&close_month=` (new) |
| 5 | Expected revenue per period | stacked `ComposedChart` (bars + target line) | `/cashflow?month=` (exists), quarter → `/cashflow?from=&to=` (new) |

Colours: use the existing tokens (`--late`, `--waiting`, `--settled`,
`--info`, `--forecast`, `--primary`) and the maps in `Reports.jsx`
(`AGE_COLOUR`, `CASH_BANDS`). Move those maps to `components/charts.jsx` so
both pages share them. Check both themes; dark mode is handled by
`ui/chart.tsx` `THEMES`.

---

## 4. Server

### 4.1 Endpoint

`GET /api/insights?owner=&granularity=month|quarter|fy&horizon=3|6|12`

```jsonc
{ "data": {
  "today": "2026-10-01",
  "follow_ups":   { "count", "value_inr", "buckets":[{key,count,value}], "by_owner":[…], "top":[…5 rows] },
  "receivables":  { "outstanding", "overdue", "buckets":[…], "top_clients":[…10], "top":[…5], "unconverted":[…] },
  "enquiry_risk": { "count", "by_reason":[{reason,count}], "top":[…5 with reasons[]] },
  "po_pipeline":  { "stages":[{key,label,count,value,weighted}], "awaiting_po_by_month":[…], "po_status":[…] },
  "revenue":      { "periods":[{period,label,received,invoiced,scheduled,pipeline,target}], "unscheduled", "later" },
  "settings":     { "quotation_idle_days", "enquiry_idle_days", "enquiry_reply_days", … } // for the ⓘ text
}}
```

Put the route in `server/src/routes/insights.js` and the logic in
`server/src/lib/insights.js` (or `.ts`, following `docs/typescript.md`). The
route stays thin. The lib takes `(db, {scope, today, granularity, horizon})`
so tests can call it directly.

Each section is its own function, run with `Promise.all`. If one section is
slow later, it can move to `/api/insights/:section` without changing the
shape.

### 4.2 Section by section

1. **Follow-ups.** Reuse `loadRecords()`, `lastActivity()`, `dueInfo()`,
   `scheduleState()` and `readSettings()` from `followUps.js`. Add a `scope`
   argument to `loadRecords()`; the only current caller passes
   "unrestricted". Do **not** depend on `follow_up_cycles`. The dashboard
   must work with the follow-up job switched off.
2. **Receivables.** Do not touch `/collections`. Its unscoped, INR-only
   behaviour is deliberate. Write a scoped query over
   `src.vPaymentStages` (`scopedSources`) and convert with
   `RATES`/`rateOn` from `salesReport.js`, using the invoice date. Keep the
   bucket edges identical to `collections.js:30-37`; extract them to a
   shared constant.
3. **Enquiry risk.** This is new. See §4.3.
4. **PO pipeline.** Reuse the stage aggregation from `routes/pipeline.js`.
   Move the loop at `:58-79` into `lib/pipeline.js` so both callers share it.
   Then add the PO side from `src.vPurchaseOrders`: not cancelled, not
   replaced, grouped by `payment_status`, with `balance_to_bill`.
5. **Revenue.** Add a `scope` argument and FX conversion to
   `lib/cashflow.js` behind an option, so `/cashflow` keeps its current
   output. Then roll months into quarters or FYs with `financialQuarter()`.
   Targets come from `salesTargets.js` when set.

### 4.3 Enquiry risk rule (`lib/enquiryRisk.js`, pure)

An **open** enquiry (`ENQUIRY_STATUS.open`) is at risk for one or more of
these reasons:

| Reason | Rule | Default |
| --- | --- | --- |
| `no_reply` | `first_responded_at IS NULL` and no outbound activity, and `enquiry_date` is more than *N* working days ago | N = 1 |
| `follow_up_missed` | `next_follow_up_at` (or the next open task) has passed with nothing logged since. Same `scheduleState()` as quotations. | — |
| `decision_near` | `expected_decision_date` is within *D* working days and no quotation exists yet | D = 5 |
| `idle` | existing `followup_enquiry_idle_days` rule | 3 |

Severity orders the list: `decision_near` with no quote first, then by days
late × estimated value (INR). The new settings go in a migration as
`settings` rows (`enquiry_reply_days`, `enquiry_decision_warn_days`), shown in
the existing Settings → Follow-ups area.

`no_reply` needs "first outbound activity". Derive it with
`lastActivity()`-style SQL (earliest communication, outbound mail or
completed task). Do **not** add a column; `first_responded_at` is only set
from the inbox.

### 4.4 Rules every new route must follow

- Declare `/insights` in `server/src/lib/authz/policy.js` with
  `access: signedIn` and `restrictions: ['record-owner']`. The coverage test
  fails otherwise.
- Use `scopeOf(req)` and `scopedSources()` from `auth/ownership.js`, not
  `lib/scope.js`. Alias every relation, and give each query its own
  `params` array.
- `owner=` is honoured only for unrestricted (admin) users and ignored for
  everyone else.
- Dates: use `businessToday()` and working days from `lib/businessDate.ts`.
  Pass `today` into SQL instead of `CURRENT_DATE`; see the IST/UTC note at
  `dashboard.js:165-181`.
- Money is in INR at the rate on the record's own date. Records with a
  missing rate are listed under `unconverted`, never guessed.
- Indexes: check `EXPLAIN` on staging data for `tasks(due_at) WHERE
  completed_at IS NULL` and `enquiries(status, enquiry_date)`. Add a
  migration only if a plan shows a sequential scan that matters.

---

## 5. Web

### 5.1 Files

| File | Change |
| --- | --- |
| `web/src/pages/Insights.jsx` | New page. Filter bar, action strip, five sections. Lazy-loaded in `App.jsx` like Reports. |
| `web/src/components/insights/*.jsx` | One component per section, so each stays small and testable. |
| `web/src/lib/insights.js` | **Pure** data shaping: rows for `ChartCard`, period labels, tone choice and drill-down hrefs. Unit-tested. |
| `web/src/components/charts.jsx` | Take `AGE_COLOUR`/`CASH_BANDS` from Reports, plus a small `FunnelBars` helper. |
| `web/src/App.jsx` | Route, plus `NAV_TOP` entry (Today, Inbox, **Insights**, Reports), or ⌘K only (see §8). |
| `web/src/lib/commands.js` | ⌘K jumps. |
| `web/e2e-smoke/routes.spec.js` | Add `/insights` to `ROUTES`. |

### 5.2 Behaviour

- One `useFetch(() => api.raw('/insights?' + qs), [qs])`, with filters from
  `useSearchParams`.
- Skeletons per section (`Skeleton`). `ErrorState` with retry per section if
  a section errors. The server returns `{error}` per failed section instead
  of failing the whole request.
- Money uses `money(v,'INR',{compact:true})`. Unconverted amounts appear as a
  footnote, as on Reports.
- Accessibility: `ChartCard` already renders an sr-only table twin. Every
  tile and bar is reachable by keyboard.

### 5.3 New list filters needed for drill-down

| List | New URL filter | Server side |
| --- | --- | --- |
| Quotations | `follow_up=overdue`, `overdue_days=a-b` | add to `resources.js` quotations filters, reusing the follow-up SQL |
| Enquiries | `risk=<reason>` | same, using `enquiryRisk` |
| Quotations | `close_month=YYYY-MM` | filter on `expected_close_date` |
| Cashflow | `from=&to=` for a quarter | `Cashflow.jsx` reads it |

**Fix while here:** Reports sends quoted-vs-won bars to
`/quotations?month=`, which Quotations ignores (`Reports.jsx:117`). Confirm
this in the browser, then accept `month` too.

---

## 6. Build order (one PR each, each shippable)

1. **Server foundations.** Make `loadRecords` scope-aware, extract the
   pipeline aggregation and the bucket constant, and add the scope/FX option
   to cash flow. Behaviour unchanged, so existing tests must pass untouched.
2. **`/api/insights` sections 1, 2, 4, 5,** with policy entry and tests.
3. **Enquiry risk rule.** Pure lib, settings migration, section 3, tests.
4. **Insights page v1.** Action strip, five sections, drill-down to
   existing filters. Includes the smoke route and e2e.
5. **New list filters** (§5.3) and the deeper drill-downs that use them.
6. **Polish.** ⓘ rule text, Today link, ⌘K, top-5 action buttons, the
   Reports `month` fix. Screenshot for the README.

---

## 7. Tests

- **Pure** (`server/test`, `node:test`): `enquiryRisk` reasons and
  severity, with holidays and weekends; period roll-up month → quarter → FY
  at the April boundary; bucket edges (day 30 vs 31).
- **Database-backed:** seed a sales user and an admin. Assert that the sales
  user sees only their own rows in every section, and that `owner=` is
  ignored for them. Assert that foreign-currency records convert at the
  record-date rate and that a missing rate lands in `unconverted`. Assert
  that totals match `/collections` and `/pipeline` for the admin. The same
  number on two screens must agree.
- **Authz:** `e2e-authz` covers `/insights` for each role.
- **Web unit** (`web/test`): `lib/insights.js` hrefs and tones.
- **E2E** (`web/e2e/flows.spec.js`): follow the Reports test at `:173-200`.
  Load `/insights`, check the sr-only tables, click a bar, and land on the
  filtered list with the expected count.

---

## 8. Decisions for the product owner

Defaults are given; the build can start with them.

1. **Who sees it?** Default: everyone, scoped. Sales users see their own
   records, and admins see all with an owner filter. The alternative is
   admins only.
2. **Sidebar or ⌘K?** `App.jsx:121-129` says new screens go in ⌘K. Default:
   add **Insights** to `NAV_TOP` anyway, because it is a landing screen like
   Reports. Alternatively, fold it into Reports as a first tab.
3. **"Before it's too late" for enquiries.** Default: reply within 1 working
   day, warn 5 working days before the expected decision date. Both are
   editable in Settings.
4. **Revenue basis.** Default: **cash basis**, meaning money expected in the
   bank, which is what cash flow does. A toggle shows **order basis**:
   POs/wins by month, which is what the revenue report does.
5. **Pipeline in revenue.** Default: include weighted open quotations as a
   separate, lighter band, never mixed into the "scheduled" figure.
