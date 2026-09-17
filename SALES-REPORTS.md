# Sales reports: sector-wise POs and new vs repeat customers

Two of the six planned sales reports, built on the existing `quotations` table
(no customer master yet).

| # | Report | Status |
|---|---|---|
| 3 | Sector-wise POs | **Done** |
| 5 | Customer analysis (new vs repeat) | **Done** |
| 1, 2, 4, 6 | Enquiries, enquiry status, best-selling services, revenue | Later |

## What users see

- **Quotations page:** a new **Sector** field on the form. It suggests sectors already
  used, and Agriculture / Metal Industry / Pharmaceutical / Other to start with. Any new
  sector can be typed in. There is also a Sector column and a Sector filter, which
  includes **Not set** to find quotations still missing one.
- **Sales reports page** (sidebar → Sales → Sales reports):
  - Date range, with *All time / This calendar year / This month*. Enquiries follow the
    enquiry date, everything else the quotation date.
  - **Sector-wise POs:** a table per sector with Enquiries, POs won, Lost, Pipeline,
    Win %, Won value and FX deals, plus a Total row, and a chart of POs by sector.
  - **FX deals:** every client with won POs in a currency other than INR, with its
    sector, currency, number of POs, won value and the quotation numbers.
  - **FX deals** also shows the rate and the **Won value (INR)** for each deal.
  - **Repeat clients**, **Single enquiry clients** and a **Client summary**, each with
    Client group, Enquiries, POs won, Win %, Won value (INR) and Repeat orders.
  - **Revenue**, for one calendar year (Jan–Dec) or one month of it, with its own **Year**
    and **Month** filters. It does not follow the period above.
    - **Order intake by month:** Orders won, Order intake (INR), Average deal (INR), from
      won quotations.
    - **Invoicing & collections by month:** POs, PO value, Invoiced, Received and Due now,
      from purchase orders. Below its Total row, once for the whole period:
      **Collection rate** (Received ÷ Invoiced) and **Invoiced % of PO value**.
    - **Payment status:** the same figures for each PO status (Overdue, To Invoice, Pending,
      Up to date, Fully Paid). Click a status to open those POs on the Purchase orders page.
    - Click a month row to show only that month.
  - A **Download CSV** button on each report, which opens in Excel and follows the chosen
    dates and filters.
  - **Download PDF** (top right): the *Sales & Enquiry Performance Review*, an A4 portrait
    management report with charts and a written analysis. Page 1 has the key figures, the
    headline and key findings. Then: 1 enquiry volume, 2 quotation status,
    3 sector-wise performance, 4 service-wise sales, 5 client analysis, 6 revenue and
    collections, 7 what management needs to fix, and an appendix (FX deals, client lists,
    notes). It uses the period above and the Revenue section's year and month. The
    enquiry and quotation status breakdowns, service lines and data-gap checks appear only in
    the PDF, not on the page.
    The server builds it with `pdfmake` (charts drawn as SVG); nothing is stored and no
    outside service or AI is used. The analysis follows fixed rules listed in its notes.
- **Settings page:** an **FX rate** per currency (INR for 1 EUR, USD, GBP, AED, SGD).
  Blank until someone enters it. Until then those deals are shown next to the INR values
  as "rate not set" instead of being guessed.

## The rules the reports follow

- **A PO** is a quotation with status **Won - PO Received**. Many won deals have no PO
  registered in the PO register yet, so counting that register would miss them.
- **Enquiries** are the rows on the Enquiries page. **Lost** is a quotation marked Lost.
  **Pipeline** is every other quotation (Submitted, Under Negotiation, On Hold), so
  POs won + Lost + Pipeline = all quotations in the period.
- **Win %** = POs won ÷ (POs won + Lost). Open deals have no outcome yet, so they are
  left out. It shows — when nothing has been decided.
- **FX deal** = a won PO in any currency other than INR. The FX deals total matches the
  FX deals column of the sector table.
- **Same spelling = same client / same sector.** Capital letters and extra spaces are
  ignored ("Hetero" = "hetero "). Any other difference is a separate client
  ("Hindalco" ≠ "Hindalco - Kuppam").
- **Repeat client:** 2 or more won POs up to the end of the chosen period.
  **Single enquiry client:** every other client, including one won PO, quoted but not
  won, or only on the Enquiries page. Each client is in exactly one group.
- **Clients are counted once.** A client's enquiries and quotations are joined by spelling
  into one row. An enquiry that became a quotation counts once under Enquiries, and its
  quotation counts only under POs won / Lost.
- **Repeat orders** = won POs after the first one (up to the end of the period).
- **Won value (INR)** = INR deals + FX deals × the Settings rate. It matches the INR won
  value in the sector table plus the INR total of the FX table.
- **Order intake** follows the won quotation's date. **Order intake** = won quotation values
  in INR. **Average deal** = order intake ÷ the orders that have a value.
- **Invoicing & collections** and **Payment status** list every purchase order by its
  **PO date**, with PO value, Invoiced, Received, Due now and payment status exactly as on
  the Purchase orders page, so their totals match that list (FX POs converted to INR).
  **Due now** = Invoiced − Received, counting only invoices that have actually
  been raised. Work that is due to be invoiced but has no invoice yet is
  reported separately as **To bill**, so Due now never overstates what anyone
  has been asked to pay. **Collection rate** = received against invoices ÷
  Invoiced, so it cannot exceed 100%.

  Each amount is converted at the rate in force on its own date — the invoice
  date for Invoiced and Due now, the payment date for Received — so in INR
  those figures differ by the currency movement between billing and
  collection, reported in its own right as **FX gain / loss**.
  **Invoiced % of PO** = Invoiced ÷ PO value.
- **PDF enquiry volume:** counts come only from the Enquiries page, by enquiry date: In Progress,
  Declined, and Won - Quotation Sent ("quotation sent").
- **PDF quotation status:** quotations by quotation date and their status on the Quotations page:
  Submitted, Under Negotiation, On Hold, Won - PO Received and Lost, with count, share and
  quoted value in INR. The counts match POs won / Lost / Pipeline in the sector table.
- **PDF service lines:** the free-text service is matched by keywords into EcoVadis, ISO,
  ASI / Copper Mark / LME, Sustainability reporting & assurance, Social & supply-chain audits,
  Climate & environment, HSE / process safety and ESG strategy & advisory
  (`server/src/lib/serviceLines.js`). A bundled quotation counts in each line it names;
  the Total row counts it once. Anything unmatched is "Other services".
- **Payment status:** Overdue = an invoice is past its due date; To Invoice = a stage is due
  to be billed; Pending = invoiced, not yet overdue; Up to date = nothing due now; Fully
  Paid = every stage paid.
- Every month in the range is listed, so a quiet month shows zeros. Without a date range,
  undated rows appear in a **No date** row.
- A **PO without a PO date** cannot be placed in a year or month, so the Revenue section
  (page and PDF) lists it in a warning, with a link to add the date.
- **Money stays in its own currency** in the sector and FX tables. The client and revenue
  tables convert to INR at the Settings rate.
- A quotation with no date is only counted when no date range is chosen.

## Files changed

| File | Change |
|---|---|
| `server/db/migrations/001_quotation_sector.sql` | **New.** Adds the `sector` column (safe to re-run) |
| `server/db/schema.sql`, `server/db/views.sql` | `sector` on `quotations` and `v_quotations` |
| `server/scripts/db.js`, `server/package.json` | **New command** `npm run db:upgrade`: migrations + views, keeps data |
| `server/src/lib/salesReport.js` | **New.** The two report queries and their CSV layout |
| `server/src/routes/dashboard.js` | `GET /api/dashboard/sales-report?from=&to=` |
| `server/src/routes/export.js` | `GET /api/export/sales-report/sectors.csv` and `customers.csv` |
| `server/src/lib/resources.js` | `sector` is saved, searchable and filterable on quotations |
| `server/src/routes/lookups.js` | Sector suggestions for the form |
| `web/src/pages/SalesReport.jsx` | **New.** The report page |
| `web/src/pages/Quotations.jsx`, `web/src/App.jsx`, `web/src/lib/*` | Sector field, filter, menu entry, CSV links |
| `README.md` | Documents `db:upgrade` |

## Deploying to production

The new code reads the new `sector` column, so the database change and the deploy go
out together.

1. **Back up the production database** first.
2. Deploy the new version on Dokploy as usual.
3. **Straight away**, open a terminal in the running container and run:
   ```bash
   cd server && npm run db:upgrade
   ```
   It only **adds** the `sector` column and rebuilds the views. No table is dropped and
   no data changes. Until it runs, the Quotations and Sales reports pages will show an
   error.

**Never run `npm run migrate` or `npm run reset` on production.** They drop every table.

After deploying, open **Quotations → Sector filter → Not set** and fill in the sector
for the existing quotations. Until then they appear under **Not set** in the report.

## How it was tested

On the local database, with a few sectors filled in temporarily and cleared afterwards:

- Sector totals and customer counts were correct. "pharmaceutical " grouped with
  "Pharmaceutical".
- Date ranges: Hetero in May 2026 shows 2 won in the period and 4 to date (Repeat).
  Up to 30 Apr it has 2 to date (Repeat), and Orion (first quoted in May) is not listed.
- An invalid date (`2026-02-30`) and a backwards range are both rejected with a clear message.
- Both CSV downloads have the right file names and columns. The existing Quotations CSV
  now includes `sector`.
- The web app builds, and all 18 existing server tests pass.
