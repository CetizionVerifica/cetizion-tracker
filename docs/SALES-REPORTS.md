# Sales reports

The **Reports** page (`/reports`) answers six questions about a period, on screen,
as CSVs and as one PDF. All three read the same definitions
(`server/src/lib/reportDefinitions.js`), so they never disagree. How it was planned,
and why each rule is what it is: [sales-report-rework-plan.md](sales-report-rework-plan.md).

1. **Total enquiries.** How many enquiries came in per day, week or month?
2. **Enquiry status.** How many converted to a PO, are still in the pipeline, were
   quoted but not won, or were lost?
3. **Sector-wise POs.** How many POs, worth how much, came from each sector?
4. **Service-wise sales.** Which service lines sell best?
5. **Customer analysis.** Which enquiries came from new customers, and which orders were
   repeats from existing ones?
6. **Revenue.** What is the PO value each month, and which sales make it up?

`/sales-report`, the old page, redirects here with its dates.

## What users see

- **Period:** This FY (listed first), This quarter (FY), This month, Last month, Last FY,
  This calendar year, Last calendar year or Custom. The period lives in the address bar,
  so a link or a bookmark reopens the same report.
- **Group by:** day for a month or less, week for up to six months, month beyond that.
  The user can change it.
- **Owner** (admins only): one salesperson's records. A sales user always sees their own.
- **Summary strip:** Enquiries · Converted to PO (n and %) · POs and their value ·
  New clients. Each opens its records.
- **About these figures:** what limits the numbers, with a link to fix each one.
  Examples: enquiries with no date, POs with no sector, amounts with no exchange rate,
  quotations marked won with no PO.
- **Six sections.** Each is titled with its question and opens with a one-sentence
  answer written from the figures. That sentence is the same one the PDF prints.
- **Every bar opens the records it counted.** The same goes for the first cell of every
  row in "Open as table". The Enquiries or Purchase orders list re-runs the report's own
  rules (`?report_from=&report_to=&report_outcome=…`), so it holds exactly what the bar
  counted. A banner says why the list is short, with a link back to all of it. The
  list's CSV and Excel exports and a saved view carry the same filter.
- **CSV beside each question**, for the period, grouping and owner on screen:
  `enquiries`, `outcomes`, `sector-pos`, `services`, `new-customers`, `repeat-orders`,
  `revenue` and `revenue-pos` (every PO behind the revenue).
- **Download PDF** (top right): the same six sections. See [The PDF](#the-pdf).
- **More analysis** (folded until opened): pipeline by stage, collections ageing, cash
  expected, win rate by quarter and by owner, sector or service, quoted against won, and
  open deals by status. These are about now, not the period, so they keep their own
  months control. Under them are the detailed CSVs the old page offered:
  - sector funnel
  - clients (repeat or single)
  - deals in another currency
  - order intake
  - invoicing and collections
  - payment status
  - overdue invoices by client
- **Settings → Report categories** (admins): the headline sectors and service lines and
  their order, sector aliases, and which line each catalogue service counts under.

## The rules

**Every query is scoped** to what the reader may see. A sales user gets their own
records and an admin gets everything, or one owner's with `?owner=`. **Every amount** is
converted to INR at the rate in force on the record's own date. An amount with no rate is
left out of the INR figures and named, never guessed. **A PO that counts as a sale** is
one that is neither cancelled nor replaced by a revision.

### 1. Enquiries received

- An enquiry counts on its **enquiry date**. If that is blank, it counts on the day the
  record was created, in India time, and a note says how many did.
- Buckets are calendar days, ISO weeks starting Monday (labelled "w/c 6 Oct") or calendar
  months. Quiet buckets show 0.
- More than 400 buckets fall back to the next coarser grouping, with a note.
- Each enquiry is split by **lead source**: the source picked from the list, or the typed
  one if none was picked.

### 2. Enquiry outcome

Judged **as at the end of the period**. Every enquiry has exactly one outcome; the first
match wins.

| Outcome | Rule |
| --- | --- |
| **Converted to PO** | A PO that counts as a sale, dated by the period's end, on the enquiry's quotation. |
| **Lost** | Closed as Unqualified **without a quotation**. |
| **Quoted, not won** | Its quotation was lost by the period's end, or ran past its validity while still Submitted or Under Negotiation. Listed by lost reason. |
| **In pipeline** | Everything else. Split into *not yet quoted* and *quoted, awaiting a decision*. |

- An enquiry that was quoted is **never Lost**, whatever happened to the quotation.
- A quotation lost only after the period ended was open at the time, so it counts in the
  pipeline.
- A quotation marked won with no PO by the period's end stays in the pipeline, with a note.
- Percentages are of the enquiries received in the period, and always add up to 100.

### 3. Sector-wise POs

- A PO's sector is its quotation's sector, or else its company's.
- That is matched to a **headline sector** (Settings → Report categories) by its name or
  an alias, ignoring case and spacing.
- Anything else is **Other**, with the spellings behind it listed. A blank is **Not set**.
- Nothing on a record is rewritten.

### 4. Service-wise sales

- A PO's value is split across service lines using, in order of preference:
  1. its recorded **PO service lines**;
  2. its quotation's **lines**, weighted by value including GST, each named by its
     catalogue service where it has one;
  3. **keywords** in the quotation's service text (`lib/serviceLines.js`).
- A piece naming several lines is **split equally** between them.
- The service values therefore add up to the revenue total. A PO counts once in each line
  it touches, so the PO counts can add up to more.
- A catalogue service's **report line**, when an admin sets one, overrides the keywords.
- A line the report does not list, or text matching none, is **Other**.

### 5. New and existing customers

- A customer is a **company**: the PO's project, then its quotation, then the company of
  the same name.
- Only when none matches is the client name the key, and a note counts those POs.
- **New customer:** their first-ever counting PO falls in the period.
  **Existing:** their first PO was before the period.
- **Repeat order:** any PO in the period that is not the customer's first. So a new
  customer's second PO in the period is a repeat. First orders and repeats add up to the
  revenue total.
- **Enquiry from a new customer:** the customer had no PO before the enquiry's own date,
  or has none at all.
- Order history is judged against **every** PO, not just the reader's. Otherwise a sales
  user taking over an account would see a long-standing client as new. A reader sees only
  a count of earlier POs, never the POs themselves.

### 6. Monthly revenue

- Revenue is the **value of counting POs including GST** (`po_value` as entered), by
  **PO date**, in INR at the PO-date rate. That is the order basis, so it is the same
  money sections 3, 4 and 5 split up.
- **Invoiced** and **received** sit beside it, dated by the invoice and by the payment and
  converted on those dates. They are the billing and cash view of each month, not a split
  of its PO value. Every PO counts in them, cancelled or replaced, because that money is
  real.
- The **order intake** in the detailed CSV uses the same basis. Until this rework it
  counted quotations marked won, by quotation date, so figures from older exports will not
  match.

## The PDF

`GET /api/export/sales-report.pdf?from=&to=&grain=&owner=` takes the same parameters as
the screen. It is built by `lib/reportPdf.js` with pdfmake and SVG charts, with no browser
and no outside service.

- **Cover:** company name, period, owner when an admin narrowed it, generated time, the
  four summary boxes, and the contents.
- **One section per question:** heading, the server's sentence, chart and table.
- **Notes and what to fix**, then **How these are counted**.
- **Footer:** "Page x of y", the period, and "confidential".
- **Limits:**
  - A daily chart longer than 31 days is drawn by week, and says so.
  - The PO list behind the revenue goes on a landscape page and stops at 200 rows; the
    customer lists stop at 100. Each says which CSV holds the rest.
  - An empty section reads "Nothing in this period."

## Endpoints

| Endpoint | What |
| --- | --- |
| `GET /api/reports/sales?from=&to=&grain=&owner=` | Every section in one response: `{enquiries, outcomes, sectors, services, customers, revenue, notes, stale_rates, narrative}` |
| `GET /api/reports/categories` | Admin: the category lists, aliases, and where every sector spelling and catalogue service lands today |
| `GET /api/export/sales-report.pdf` | The PDF |
| `GET /api/export/sales-report/:report.csv` | A section CSV, or one of the detailed tables |
| `GET /api/enquiries?report_…`, `/api/purchase-orders?report_…` | The records behind a slice |

The category lists are saved through `/api/settings/report_sectors` and
`/api/settings/report_service_lines` (JSON lists, validated on save),
`/api/sector-aliases` and `report_line` on `/api/services`.

## Files

| File | What |
| --- | --- |
| `server/src/lib/reportDefinitions.js` | The six definitions, the drill-down filters, and `salesReport()` |
| `server/src/lib/reportPdf.js`, `pdfBlocks.js`, `pdfCharts.js` | The PDF |
| `server/src/lib/reportCsv.js` | The section CSVs |
| `server/src/lib/serviceLines.js` | The service-line keywords |
| `server/src/lib/salesReport.js`, `revenueReport.js` | Shared SQL (periods, rates, the PO-to-quotation rule) and the detailed tables |
| `server/db/migrations/065_report_categories.sql` | Sector aliases, `services.report_line`, the two category settings |
| `web/src/pages/Reports.jsx`, `web/src/components/SalesReportSections.jsx` | The page |
| `web/src/pages/ReportCategories.jsx` | Settings → Report categories |
| `web/src/lib/reportPeriods.js` | Period presets and drill-down links |

## Tests

| Test | Covers |
| --- | --- |
| `server/test/reportRules.test.js` | Buckets, grain, percentages, outcome precedence, sector and service mapping, the split, customers |
| `server/test/reportDefinitionsSql.test.js` | Every section against a real database, "as at the period's end", scoping, drill-downs agreeing with charts |
| `server/test/reportPdf.test.js` | The six headings in order, empty sections, daily-to-weekly, the PO cap and landscape page, CSVs |
| `web/test/reportPeriods.test.js` | Presets, FY quarters, drill-down links |
| `web/e2e/flows.spec.js` | Last month → Lost → the same number of enquiries → PDF download |
