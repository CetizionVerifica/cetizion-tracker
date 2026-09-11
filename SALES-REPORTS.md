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
  - Date range on the quotation date, with *All time / This financial year / This month*.
  - **Sector-wise POs:** a chart and a table showing POs, customers and won value per sector.
  - **Customer analysis:** every customer quoted in the period, with tabs for
    Repeat / New / No order yet.
  - A **Download CSV** button on each report, which opens in Excel and follows the chosen dates.

## The rules the reports follow

- **A PO** is a quotation with status **Won - PO Received**. Many won deals have no PO
  registered in the PO register yet, so counting that register would miss them.
- **Same spelling = same client / same sector.** Capital letters and extra spaces are
  ignored ("Hetero" = "hetero "). Any other difference is a separate client
  ("Hindalco" ≠ "Hindalco - Kuppam").
- **Repeat customer:** 2 or more won orders up to the end of the chosen period.
  **New customer:** exactly 1. **No order yet:** quoted but nothing won.
- **Money stays in its own currency.** INR, EUR and USD are shown side by side and never
  added together.
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
