# Reports section rework: implementation plan

The Reports section should answer six questions on screen, and the same six
must come out as a PDF:

1. **Total enquiries.** How many enquiries were received per day, week and
   month?
2. **Enquiry status.** Of those enquiries, how many (and what %) were
   converted into a PO, are still in the pipeline, or were lost?
3. **Sector-wise POs.** How many POs came from each sector: Metal Industry,
   Agriculture, Pharmaceutical and Others?
4. **Service-wise sales.** Which services sell best: EcoVadis, ESIA, Climate
   Change, ESG, HSE, Sustainability and Others?
5. **Customer analysis.** Which enquiries came from new customers, and which
   orders were repeats from existing ones?
6. **Revenue.** What is the total revenue each month, and which sales make
   it up?

This file is written for the person (or Claude Code session) who builds it.
Read [PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md) and
[SALES-REPORTS.md](SALES-REPORTS.md) first. The plan follows the two design
rules: nothing derived is stored, and each fact is typed in one place. It was
written against commit `5db1ccb`. A companion plan,
[insights-dashboard-plan.md](insights-dashboard-plan.md), covers the
forward-looking "what needs action now" screen. This plan covers the
backward-looking "what happened in a period" report.

---

## 1. What already exists, and why it is not this

A sales report with a PDF already exists. The work is a **restructure plus
filling gaps**, not a rebuild.

**Two report pages:**

- `/reports` (`web/src/pages/Reports.jsx`) shows Recharts charts by Indian
  financial-year quarter. It has **no PDF**.
- `/sales-report` (`web/src/pages/SalesReport.jsx`) has a free from/to
  period, mostly tables, CSV per table, and a **Download PDF** button
  (`/api/export/sales-report.pdf`).

**The PDF** is generated on the server with **pdfmake** (`lib/pdf.js`,
`lib/salesReportPdf.js`). Its charts are SVG strings from `lib/pdfCharts.js`
(`stackedColumns`, `horizontalBars`, `donut`); no browser is involved. The
sections today are: volume, status, contracts, sector, service, client,
revenue and fixes (`salesReportPdf.js:1164-1171`).

| Question | What exists | Gap |
| --- | --- | --- |
| 1. Enquiries per day/week/month | Monthly series only, from `enquiryRows` / `enquirySummary` (`salesReviewData.js:61,169`) by `enquiry_date`, plus counts by source and sector. | No **daily** or **weekly** bucketing. Enquiries with no `enquiry_date` are dropped from a dated period. |
| 2. Status: converted / pipeline / lost | `enquiryPipeline` gives contracted / declined / pending. `contractDateOf()` links an enquiry to its PO through `enquiries.quotation_no`, then the quotation, then `purchase_orders`. | "Pending" mixes enquiries still being worked on with enquiries whose **quotation was lost or expired**. No percentages on screen. |
| 3. Sector-wise POs | `sectorReport` (`salesReport.js:278`) counts real PO rows by the sector of their quotation, ignoring case and spacing. | Sector is **free text**; only the suggestions in `routes/lookups.js:14` match the four requested. Spelling variants become separate sectors. "Other" is not a roll-up. |
| 4. Service-wise sales | `lib/serviceLines.js` sorts free-text `quotations.service_quoted` with 8 regex buckets. | The buckets don't match the requested list: there is **no ESIA**, and the names differ. A bundle counts its **full value in each line** it names. The structured data (`quotation_lines.service_id`, `po_services`) is not used. |
| 5. New vs repeat customers | `customerReport` (`salesReport.js:472`) labels a client "repeat" when it has 2 or more won deals, otherwise "single". | No **"new customer"** idea (first PO in the period). There is no list of enquiries from new versus existing customers. Clients are grouped by spelling of `client_name`, not by `company_id`. |
| 6. Monthly revenue | `revenueReport` (`revenueReport.js:198`) gives order intake per month plus invoicing and collections. It converts every currency to INR at the record-date rate. | Order intake is dated by **won-quotation date**, while sector and client sections use **PO date**, so the totals disagree. "Revenue" is not defined in one place, and there is no per-month list of the sales behind it. |

**Also out of date:** `SALES-REPORTS.md` still says a PO is a Won quotation
(line 56). It describes separate Revenue filters (line 28) and uses legacy
enquiry status names (lines 93-94). Fix these in the same PR as §6 step 6.

---

## 2. Scope

### In scope

1. **One Reports page** with six sections in the order of the questions,
   above the existing analysis charts. One period control drives all six.
2. A **report-definitions module** that defines each metric once and is used
   by the screen, the CSV export and the PDF, so the three always agree.
3. Daily and weekly enquiry series. The bucket size is chosen from the
   period length, and the user can override it.
4. A **three-way enquiry outcome** (Converted to PO / In pipeline / Lost)
   in which "Lost" means closed without ever becoming a quotation. Quoted
   enquiries that did not win are shown separately (§4.2).
5. **Controlled sector and service categories** for reporting, mapped from
   the existing free text without rewriting history.
6. "New" and "existing" customers defined by first PO date, keyed by
   company.
7. One definition of monthly revenue, with a monthly list of the sales
   behind it.
8. The PDF regenerated to match the six sections. It stays server-side with
   pdfmake.
9. Tests for every rule, plus the first e2e test for the report and the PDF.

### Out of scope (say so in the PR)

- Changing how enquiries, quotations or POs are entered. One exception: a
  **sector and service picker** in place of free text (§4.3, §4.4), which is
  optional and can ship later.
- Scheduled or emailed reports. The PDF is generated on demand.
- Forward-looking forecasts; the Insights plan covers those.
- Replacing pdfmake or rendering the PDF with a headless browser.

---

## 3. The page: what the user sees

### 3.1 Layout

```
┌ PageHeader: Reports ──── [This month ▾ | from–to] [Group by: Day|Week|Month] [Owner ▾] [⤓ PDF] ┐
│ ── Summary strip: Enquiries 142 │ Converted to PO 31 (22%) │ POs 34 · ₹1.8Cr │ New clients 9 ── │
├──────────────────────────────────────────┬─────────────────────────────────────────────────────┤
│ 1. How many enquiries did we receive?    │ 2. What happened to them?                          │
│   column chart per day/week/month        │   donut: Converted to PO / Pipeline / Lost / Quoted–not won (% + n) │
│   split by source (stacked, toggle)      │   + bar per month (stacked 100%)                    │
├──────────────────────────────────────────┼─────────────────────────────────────────────────────┤
│ 3. Which sectors gave us POs?            │ 4. Which services sell best?                       │
│   horizontal bars: count + value (INR)   │   horizontal bars ranked by PO value, count label  │
│   Metal · Agri · Pharma · Others ▸       │   EcoVadis · ESIA · Climate · ESG · HSE · Sust ·    │
│                                          │   ISO · ASI · Social audits · Other                 │
├──────────────────────────────────────────┴─────────────────────────────────────────────────────┤
│ 5. New vs existing customers                                                                     │
│   tiles: new customers · repeat orders · repeat share of value                                  │
│   two tables: "Enquiries from new customers" │ "Repeat orders from existing customers"          │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 6. Monthly revenue                                                                               │
│   column chart per month: PO value (bars) + invoiced + received (lines)                          │
│   expandable month rows → the POs in that month (client, sector, service, owner, value)         │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ More analysis (existing): win rate by quarter, quoted vs won, pipeline, collections ageing    │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 How it helps the reader

- **Each section is titled with its question.** A one-sentence answer
  follows, written from the data. For example: "142 enquiries, 22% already
  converted to a PO. Metal Industry gave the most POs (14)."
  `salesReviewAnalysis.js` already writes sentences like this for the PDF.
  Reuse it so the screen and the PDF say the same thing.
- **Period presets:** This month, Last month, This quarter (FY), This FY,
  Last FY, Custom. The default **Group by** follows the period length:
  - up to 31 days: day
  - up to 6 months: week
  - longer: month
- **Every bar, slice and row drills down** to the filtered list:
  - enquiries: `/enquiries?from=&to=&outcome=`
  - POs: `/purchase-orders?sector=&from=&to=`
  - and so on.
  This uses the `ChartCard` `rows[].href` pattern already in Reports.
- **Show % and number together** everywhere the user asked for it, for
  example "31 · 22%".
- **CSV per section**, as today, plus **one PDF** of the whole report for
  the selected period and owner.
- **Data-quality notes:**
  - "7 enquiries have no date and are not counted."
  - "3 POs have no sector."
  - "2 amounts lack an exchange rate."
  Each note links to the record list so someone can fix it. The PDF already
  has a "fixes" section; keep it as the last page.

### 3.3 Merging the two pages

Today `/reports` and `/sales-report` split one job in two. Make `/reports`
the single page with the six sections, followed by the existing Recharts
analysis under **More analysis**. Redirect `/sales-report` to `/reports`,
keeping its query string, so saved links still work. Update ⌘K
(`lib/commands.js`) and the smoke `ROUTES`.

---

## 4. Definitions (`server/src/lib/reportDefinitions.js`, pure)

This is the core of the plan. Each question gets one function that the
screen, CSV and PDF all call.

### 4.1 Enquiries received

- **Date:** `enquiry_date`, falling back to `created_at::date` in IST. Count
  how many records used the fallback, and show that in the data-quality note.
- **Buckets:**
  - day: the calendar date
  - week: ISO week, Monday start, labelled "w/c 6 Oct"
  - month: the calendar month
  Empty buckets are filled with 0, generalising `monthRows()` into
  `periodRows(from, to, grain)`.
- **Split:** by `lead_sources` via `source_id`. Free-text `source` is used
  only when `source_id` is null.
- **Scope:** `src.enquiries` from `scopedSources`.

### 4.2 Enquiry outcome

**Decided:** a *lost* enquiry is one that was **never converted into a
quotation**, i.e. it was closed (status `Unqualified`) with no
`quotation_no`. An enquiry that did become a quotation is never "lost",
whatever happened to the quotation afterwards.

Every enquiry in the period has exactly one outcome:

| Outcome | Rule (first match wins) |
| --- | --- |
| **Converted to PO** | `contractDateOf()` finds a PO that counts as a sale (`poCountsAsSale`: not cancelled, not replaced) through `enquiries.quotation_no`. |
| **Lost** | status is `Unqualified` and `quotation_no IS NULL`: closed without a quotation. |
| **In pipeline** | still being worked on. Two sub-rows: *not yet quoted* (open statuses New / Contacted / Qualified / Nurture, no quotation) and *quoted, awaiting decision* (linked quotation still open). |
| **Quoted, not won** | linked quotation is `Lost` (`stage_type = 'lost'`) or expired with no PO (`v_quotations.expired`). Shown as its own slice, broken down by `lost_reason_id`, so these enquiries neither inflate the pipeline nor count as lost enquiries. |

An `Unqualified` enquiry that *does* have a `quotation_no` (the status was
set after quoting) follows its quotation: pipeline, quoted-not-won or
converted. It is listed as a data-quality note.

Percentages use the enquiries received in the period as the denominator.
They are computed with `share()` from `reportMath.ts`, so the slices add up
to 100% after rounding.

The outcome is judged **as of the end of the period**. A PO received after
`to` does not count, which matches how `customerReport` already treats time.

### 4.3 Sector

- **Reporting categories:** Metal Industry, Agriculture, Pharmaceutical and
  Other. Make the list a `settings` row (`report_sectors`), so a new headline
  sector needs no code change.
- **Mapping:** a sector maps to a category when `nameKey(sector)` matches the
  category, or an alias in a small `sector_aliases` table. For example
  "steel", "metals", "aluminium" all map to Metal Industry. Admins edit the
  aliases in Settings → Reports.
- Everything else is **Other**. The table can expand "Other" to show the
  raw sector names behind it, so nothing is hidden.
- **Which sector a PO gets:** the sector of its resolved quotation
  (`poResolved`), then the company's `companies.sector`, then "Not set".
- **Optional, can follow later:** make the sector field on quotations and
  enquiries a combobox fed by these categories, so new data arrives clean.
  Existing free text is left as it is.

### 4.4 Service

- **Reporting categories (decided):** EcoVadis, ESIA, Climate Change, ESG,
  HSE, Sustainability, **ISO certification**, **ASI / Copper Mark / LME**,
  **Social & supply-chain audits**, and Other. ISO, ASI and social audits
  are their own lines and are **never counted in Other**. Keep the list in a
  `report_service_lines` setting, ordered.
- **Source of truth, in order of preference:**
  1. **`po_services`** rows for the PO, giving the actual value split per
     service at registration. This removes the double-counting problem.
  2. Otherwise **`quotation_lines.service_id` → `services`**, with each
     catalogue service mapped to a category.
  3. Otherwise the existing regex on `quotations.service_quoted`. A
     multi-match splits the value **equally** across the categories it
     matches, instead of counting it in full in each one. The PDF footnote
     says when this fallback was used.
- **Mapping:** add a nullable `report_line` text column to `services`. It is
  a typed fact, the category an admin assigns to a catalogue entry, so
  storing it is allowed. Rework `SERVICE_LINES` regexes to the new
  categories:
  - add ESIA: `/\besia\b|environmental\s+(and\s+)?social\s+impact/i`
  - rename "Climate & environment (GHG / LCA / CBAM)" to **Climate Change**,
    "Sustainability reporting & assurance" to **Sustainability**,
    "HSE / process safety" to **HSE** and "ESG strategy & advisory" to
    **ESG**, keeping their patterns
  - keep the ISO, ASI / Copper Mark / LME and social-audit patterns as
    their own lines
  - **Other** is only what matches none of the above
- **Ranking:** by PO value in INR. Show the PO count as a label. A toggle
  ranks by count instead.
- **Seed check:** the services ESIA, Climate Change and HSE are **not in the
  catalogue** (`seed.sql`). Add them through Settings → Services in
  production rather than in the seed file.

### 4.5 New vs existing customers

- **Customer key:** `companies.id`. A PO reaches its company through its
  project, then the quotation. Fall back to `nameKey(client_name)` only for
  legacy rows with no company link, and list them as a data-quality note.
- **First order date:** `MIN(po_date)` over counting POs per company,
  computed in a CTE and never stored.
- **New customer in the period:** their first order date falls in the
  period.
- **Existing customer:** their first order date is before `from`.
- **Repeat order:** a counting PO in the period from an existing customer,
  or a customer's second or later PO inside the period.
- **The two lists the user asked for:**
  1. *Enquiries from new customers.* Enquiries in the period whose company
     had no PO before the enquiry date, including companies with no PO at
     all.
  2. *Repeat orders from existing customers.* The repeat POs above, with
     client, PO date, value, service and the number of previous orders.
- Keep the existing "repeat / single" labels in `customerReport` for the
  CSV, but the screen and PDF use **new / existing**.

### 4.6 Monthly revenue

**Decided:** revenue = **value of counting POs including GST** (`po_value`
as stored, `register.js:144`), by `po_date`, in INR at the PO-date rate.
This is the order basis, and it agrees with sections 3, 4 and 5.

- No GST derivation is needed: `po_value` is already gross. Label the chart
  and PDF "PO value incl. GST" so nobody reads it as net.
- Sections 3 and 4 use the same gross value, so a sector or service total
  adds up to the revenue total. `po_services.service_value` is already
  grossed up to the PO value at registration (`register.js:139-160`), so
  the service split also sums to `po_value`.
- Show **invoiced** and **received** per month alongside, as lines on the
  chart, from the existing `revenueReport` invoicing half. These are the
  "billing" and "cash" views of revenue.
- **Sales details per month:** the list of POs (client, sector, service,
  owner, PO value, invoiced, received), reusing `contractPipeline`
  (`salesReviewData.js:263`).
- Change `revenueReport().orders` to use PO rows by `po_date` instead of Won
  quotations by `quotation_date`. Call out this change of figures in the
  PR.

### 4.7 Rules every query follows

- **Scope:** `scopeOf(req)` and `scopedSources()` (`auth/ownership.js:392`),
  with one params array per statement. Admins get an `owner=` filter.
  Library functions take `scope = UNRESTRICTED` as now.
- **Period:** `reportPeriod()` (`salesReport.js:239`) and `inPeriod()`. Add
  `grain=day|week|month`.
- **FX:** `RATES` and `rateOn()` at the record's own date. A missing rate is
  never guessed; it is listed as unconverted.
- **Dates:** use `businessToday()` and IST, not Postgres `CURRENT_DATE`
  (see `dashboard.js:165-181`).

---

## 5. Server and PDF

### 5.1 Endpoints

| Endpoint | Change |
| --- | --- |
| `GET /api/reports/sales?from=&to=&grain=&owner=` | **New.** Returns all six sections in one response: `{enquiries, outcomes, sectors, services, customers, revenue, notes, narrative}`. Runs the six sections with `Promise.all`, with concurrency capped at 2 as `export.js` does. |
| `GET /api/export/sales-report.pdf` | Same parameters. Calls the same function and renders it. |
| `GET /api/export/sales-report/:section.csv` | Same function, one section. Add `enquiries`, `outcomes`, `services`, `new-customers`, `repeat-orders` and `revenue` to `SALES_REPORTS`. |
| `/api/dashboard/sales-report`, `/revenue-report` | Keep them during the change, with the old page reading them. Remove them in the last step and update `policy.js`. |

Declare every new route in `server/src/lib/authz/policy.js` with
`access: signedIn` and `restrictions: ['record-owner']`.
`authzPolicy.test.js` and `authzDocs.test.js` fail otherwise.

### 5.2 PDF

Keep pdfmake and SVG charts. Restructure `salesReportDocDefinition`:

1. **Cover:** title, period, owner filter, generated-at time (IST), and the
   summary strip as four boxes.
2. **One section per question**, in order. Each has the question as its
   heading, the narrative sentence, the chart and the table:
   - 1: `stackedColumns` by day/week/month. Daily is capped at 31 columns;
     beyond that the PDF uses weekly, with a note.
   - 2: `donut` + table with n and %.
   - 3: `horizontalBars` (count and INR).
   - 4: `horizontalBars` ranked.
   - 5: two tables, plus tiles.
   - 6: `stackedColumns` + month table + PO detail. Use landscape for the
     detail table if it is wider than 7 columns.
3. **Notes and fixes:** data-quality notes, unconverted amounts and stale
   rates. This is the existing fixes section.
4. **Footer:** page x of y, period and "Cetizion Verifica, confidential".
   Header: company logo from settings, if one is set.

Add one chart helper to `pdfCharts.js`: `lineOverColumns`, for revenue
columns with invoiced and received lines.

Large periods: a full FY of daily enquiries or hundreds of POs must stay
under about 5 s. Cap the PO detail table at 200 rows in the PDF, with "and
N more, see CSV".

---

## 6. Build order (one PR each, each shippable)

1. **Definitions, part 1:**
   - `reportDefinitions.js` with §4.1, §4.2 and §4.6, plus `periodRows`.
   - The new endpoint returns these three.
   - Pure and database-backed tests.
2. **Categories:**
   - Migration for `sector_aliases`, `services.report_line` and the two
     settings rows.
   - Settings → Reports screen for aliases and the service mapping.
   - §4.3 and §4.4.
3. **Customers:** §4.5, with company-keyed first order date.
4. **Screen:**
   - Six sections on `/reports`, summary strip, drill-downs.
   - Existing charts move under More analysis.
   - `/sales-report` redirects.
5. **PDF and CSV:** restructured document, new CSVs, and the first e2e
   test, which downloads the PDF, checks it is non-empty and has the
   expected page headings (via `pdf-parse` in the test only).
6. **Clean-up:**
   - Switch `revenueReport().orders` to PO basis.
   - Remove the old endpoints.
   - Rewrite `SALES-REPORTS.md`.
   - Update README screenshots.

---

## 7. Tests

- **Pure** (`server/test/reportRules.test.js`, extend it):
  - `periodRows` for day, week and month: week crossing a year end, a
    period starting midweek, empty buckets.
  - Outcome precedence: Unqualified with a PO counts as Converted;
    Unqualified with no quotation counts as Lost; a lost or expired
    quotation counts as Quoted, not won (never Lost).
  - `share()` sums to 100.
  - Service split: one line, a bundle split equally, `po_services`
    preferred.
  - The ESIA regex.
  - Sector alias mapping, case and spacing.
- **Database-backed** (`salesReportSql.test.js`, extend it):
  - Seed a small world: 2 companies, one with an earlier PO, enquiries
    across days, one cancelled PO, one replaced PO, one USD PO with and
    without a rate.
  - Assert every section's numbers, and that the screen endpoint, CSV and
    PDF doc definition agree.
  - Assert that a sales user sees only their own rows, and that `owner=` is
    ignored for them.
- **PDF** (`salesReportPdf.test.js`): six section headings in order; a
  daily chart over 31 days falls back to weekly; empty sections render
  "Nothing in this period", not an empty chart.
- **E2E** (`web/e2e/flows.spec.js`):
  - Open `/reports` and pick "Last month".
  - Click the "Lost" slice, and land on `/enquiries` with `outcome=lost`
    and the same count.
  - Download the PDF.

---

## 8. Decisions

### Decided by the product owner

1. **Revenue** is PO value **including GST**, by PO date (order basis).
   Invoiced and received are shown alongside (§4.6).
2. **ISO, ASI / Copper Mark / LME and social & supply-chain audits** are
   their own service lines and are **not counted in Other** (§4.4).
3. **"Lost" enquiries** are those **never converted into a quotation**:
   closed as Unqualified with no quotation. Quoted enquiries that did not
   win are a separate "Quoted, not won" slice (§4.2).

### Still open (defaults given; the build can start with them)

4. **Bundled services** (one PO covering several services). Default: use
   the actual split from the PO's services. If there is none, split
   equally, so totals add up. Today the full value is counted in each
   line.
5. **"New customer".** Default: first-ever PO falls in the period. The
   alternative is that the company record was created in the period.
6. **Calendar or financial year** for the presets. Default: both are
   offered; This FY is listed first, since Reports already uses Indian FY
   quarters.
7. **Where "Quoted, not won" goes.** Default: its own slice next to the
   three you asked for. The alternative is to count it inside "In
   pipeline".
