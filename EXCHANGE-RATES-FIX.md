# Fix: dated exchange rates

Five bugs, all from the same root cause: exchange rates were single values in
Settings (`fx_rate_EUR`, `fx_rate_USD`, `fx_rate_GBP`, `fx_rate_AED`,
`fx_rate_SGD`), and every report converted every amount with whatever that
value happened to be at the moment the report ran.

---

## Bug 1 — last year's figures moved when someone edited a rate

### The problem

A report run today and the same report run next month disagreed, with no way to
tell which was right. A deal won at ₹83 to the dollar was reported at today's
rate, so won value, Sales KPIs (#18) and margin (#39) were all built on it.
Production has 9 non-INR quotations.

### Why it happened

`RATES` in `server/src/lib/salesReport.js` read one current value per currency
out of `settings`, and every report joined on currency alone:

```sql
LEFT JOIN rates r ON r.currency = q.currency
```

Nothing in the join knew when the quotation, PO, invoice or payment happened.

### What was changed

A new `exchange_rates` table (migration `013_exchange_rates.sql`) holding
`from_currency`, `to_currency`, `rate`, `effective_from`, `source`,
`entered_by`, `note`, unique on currency plus date.

`RATES` now reads that table, and a new `rateOn()` helper builds the join, so
every figure converts at the rate in force on **its own date**:

```sql
LEFT JOIN LATERAL (
  SELECT rate, effective_from FROM rates
   WHERE currency = q.currency
     AND effective_from <= COALESCE(q.quotation_date, CURRENT_DATE)
   ORDER BY effective_from DESC
   LIMIT 1
) r ON true
```

All 14 converting queries across `salesReport.js`, `revenueReport.js` and
`salesReviewData.js` go through it. A quotation joins on its quotation date, a
PO on its PO date, an invoice on its invoice date, a payment on its payment
date. A record with no date falls back to today's rate, exactly as before.

Where no rate covers a record's date, the amount is reported as unconverted —
the same path a missing rate already used, so no new behaviour to learn.

---

## Bug 2 — section 2 of the review PDF was invisible to the rate warnings

### The problem

The PDF's exchange-rate line and the "Set the exchange rates" action in section
7 were built from the sector, customer, FX and revenue figures only. Section 2
(quotation status) also converts open and lost quotations, but its currencies
were left out.

With one Submitted USD quotation and no USD rate, section 2 showed
`+ $1,000 (no rate)` while the rate line still read "Not needed — every amount
in this report is in INR", and section 7 never asked anyone for the rate.

### Why it happened

`salesReportPdf.js` assembled `used` and `missingRates` from four sources and
simply did not include `quotationStatus.total.unconverted`.

### What was changed

Quotation-status currencies now feed both lists, so the warning logic has one
source. Covered by the existing test *"problems in the data are called out, not
hidden"*.

---

## Bug 3 — a wrong-date rate was invisible

### The problem

A blank rate was correctly treated as "not set", but a rate from the wrong date
looked exactly like a right one.

### What was changed

- The PDF rate strip now reads `1 USD = ₹88.90 from 2026-09-20` instead of just
  the number.
- Hovering any converted figure shows the rate and the date it took effect —
  on the Revenue tables and, newly, on the Sales report's sector, client and FX
  figures.
- The FX table's rate column shows the effective date under the rate.
- Settings → Exchange rates lists every rate by currency and date, badges the
  one currently in force, charts the rate over time, and warns about currencies
  with no rate at all.

---

## Bug 4 — invoiced and received converted at the PO's date

### The problem

`v_purchase_orders` sums every stage first, and the revenue report then
multiplied that single total by the **PO date's** rate. An invoice raised eight
months after the PO was priced at the PO's rate.

### What was changed

`revenueReport.js` now converts each stage separately before summing — the
invoice date for what was billed, the payment date for what came in. `po_value`
still uses the PO date, which was already correct.

Verified on a real USD PO: two stages of the same PO converted at **86.50** and
**88.90**, which the old code could not do.

Stages whose date no rate covers are now counted and flagged
("2 stages with no rate on their date") instead of silently contributing zero —
a hole that only opened once conversion moved to stage level.

---

## Bug 5 — realised FX gain or loss was hidden

### The problem

Money made or lost purely on currency movement between invoicing and collection
disappeared into the totals.

### What was changed

```sql
SUM(s.amount_received * (pr.rate - ir.rate))
  FILTER (WHERE s.payment_received_date IS NOT NULL)
```

$5,000 invoiced at 86.50 and collected at 88.90 is now reported as **+₹12,000**
rather than absorbed. The filter matters: an unpaid invoice has realised
nothing yet.

Shown as an **FX gain / loss** column in the Revenue tables (green for a gain,
amber for a loss, `—` on INR), the same column in the review PDF, and two new
CSV columns.

---

## Migration

`013_exchange_rates.sql` copies today's Settings values in as rows effective
from the earliest transaction date, so **no figure moves at the moment of the
switch**, with a note that rates before that date are estimates. A blank or
unusable setting stays "not set" rather than becoming a rate.

The `fx_rate_*` settings are then read-only — `PATCH /api/settings/fx_rate_*`
returns 422 pointing at the new screen — and hidden from the Settings
Assumptions table. They are kept for reference and removed later.

---

## How it was verified

| Check | Result |
| --- | --- |
| A new rate of 999 added today, five figures re-run | every number identical |
| Dated lookup in Postgres: before first rate, on the day a rate starts, between rates, after the last, no rate, INR, undated | 9 tests pass |
| Migration 010 on a throwaway database holding data | figures identical before and after |
| `scripts/ci/check-migrations.sh` | migrations bring the deployed schema to the same schema as `schema.sql` |
| Full suite with a database | 81 tests pass |
| Web build, review PDF render | clean |

One test caught a wrong expectation of its own author's: an undated record was
asserted to use 88.90, but returns 86.50, because that rate starts 2026-09-20
and the run date was the 16th. The code was right; the assertion was rewritten
to compare against "a record dated today" so it cannot rot.

---

## Files changed

**Server**

- `db/migrations/013_exchange_rates.sql` — new table, carry-over, settings marked read-only
- `db/schema.sql` — the same table for a database built from scratch
- `src/lib/salesReport.js` — `RATES` reads `exchange_rates`; new `rateOn()` and `ratesUsedFor()`; sectors convert in SQL
- `src/lib/revenueReport.js` — per-stage conversion, realised gain/loss, rate details
- `src/lib/salesReviewData.js` — dated joins; `exchangeRates()` returns rate plus effective date
- `src/lib/salesReportPdf.js` — quotation currencies in the warnings, dated rate strip, gain/loss column
- `src/lib/salesReviewAnalysis.js` — reworded the "Set the exchange rates" action; removed the now-dead `inrValue()`
- `src/lib/resources.js` — `exchange-rates` resource and its validation
- `src/routes/lookups.js` — `fx_rate_*` settings made read-only

**Web**

- `src/pages/Settings.jsx` — Exchange rates table, edit sheet, chart, missing-rate warning
- `src/pages/SalesReport.jsx` — rate and date on hover, effective date in the FX table
- `src/components/RevenueReport.jsx` — FX gain / loss column, unconverted-stage flag

**Tests**

- `test/exchangeRates.test.js` — the SQL contract: rates never come from `settings`, no dateless join survives
- `test/exchangeRateLookup.test.js` — the lookup itself, in Postgres
- `test/exchangeRateMigration.test.js` — migration 010 on a database holding data

---

## Not done

- **Daily feed job** (#21) — not built. `source: 'feed'` exists as a placeholder.
- **`entered_by`** — the column and API field exist, but no session user is
  wired in, so rows are created with it null.
- **Out of scope as specified:** hedging, revaluing open balances at period end,
  currencies other than INR as the base.

### Separate, still open

`Due now` is defined in `SALES-REPORTS.md`, the page hint and the PDF as
`Invoiced − Received`, but `v_purchase_orders.balance_due_now` counts a stage as
soon as its trigger fires, invoiced or not — so the figure and its definition
disagree, and collection rate can exceed 100%. Not part of this fix; it needs a
decision about the six operational screens that share that number.
