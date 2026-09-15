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
  - Date range, with *All time / This financial year / This month*. Enquiries follow the
    enquiry date, everything else the quotation date.
  - **Sector-wise POs:** a table per sector with Enquiries, POs won, Lost, Pipeline,
    Win %, Won value and FX deals, plus a Total row, and a chart of POs by sector.
  - **FX deals:** every client with won POs in a currency other than INR, with its
    sector, currency, number of POs, won value and the quotation numbers.
  - **FX deals** also shows the rate and the **Won value (INR)** for each deal.
  - **Repeat clients**, **Single enquiry clients** and a **Client summary**, each with
    Client group, Enquiries, POs won, Win %, Won value (INR) and Repeat orders.
  - **Revenue**, for one calendar year (Jan–Dec), with its own **Year**, **Month**,
    **Sector** and **Sales person** filters. It does not follow the period above.
    - **Order intake by month:** Orders won, Order intake (INR), Average deal (INR).
    - **Invoicing & collections by month:** POs, PO value, Invoiced, Received, Due now
      and Balance, all in INR.
    - Pick a month (or click its row) to see its orders one by one, with the same
      figures per order and a link to register the project or add the PO.
  - A **Download CSV** button on each report, which opens in Excel and follows the chosen
    dates and filters.
  - **Download PDF** (top right): the whole report as one A4 landscape PDF, with a cover
    page with the key figures, then sector-wise POs, FX deals, client analysis, revenue
    (with every order won in the year) and notes. It uses the period above and the Revenue
    section's year and filters, exactly as on screen. The server builds it with `pdfmake`
    from the same data as the page; nothing is stored and no outside service is used.
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
- **Revenue months** follow the quotation date of the won order. Every month in the range
  is listed, so a month with no orders shows zeros.
- **Order intake** = won quotation values in INR. **Average deal** = order intake ÷ the
  orders that have a value.
- **PO value, Invoiced, Received, Due now** come from the purchase orders **linked** to each
  won quotation (the PO's *Won quotation* field). A PO counts once, against that quotation,
  even when its project holds several won quotations. A new PO is linked automatically when
  its project has one won quotation; otherwise pick it on the PO. **Balance** = PO value −
  Received. A won order with no linked PO is counted in Orders won but not in these
  columns, and a PO not linked to a won quotation is listed so it can be fixed.
- **Undated won quotations** appear in a **No date** row when no date range is chosen.
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
