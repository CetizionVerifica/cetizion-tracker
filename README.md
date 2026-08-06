# Cetizion Tracker

A web application that replaces `Cetizion_Sales_Expenses_and_Project_Tracker_final.xlsx` —
the sales pipeline, project register, PO payment schedule, onboarding checklist and
travel/expense workbook — with a Node + Express + PostgreSQL API and a React front end.

Everything the workbook computed with formulas is computed by the database, so the
numbers cannot drift the way copied-down cells do, and nobody can type into a grey cell
by accident.

---

## Quick start

Requires **Node 18+** and **PostgreSQL 14+** running locally.

```bash
# 1. API
cd server
npm install
npm run reset          # creates the database, applies schema + views, loads your data
npm run seed:demo      # optional: adds the workbook's worked example (PO-77310 / PO-77455)
npm start              # http://localhost:4000

# 2. Web app  (second terminal)
cd web
npm install
npm run dev            # http://localhost:5173
```

Open <http://localhost:5173>. The dev server proxies `/api` to port 4000, so the browser
only ever talks to one origin.

### Configuration

Everything has a working default. To change one, copy `server/.env.example` to
`server/.env`:

| Variable       | Default                                          |
| -------------- | ------------------------------------------------ |
| `PORT`         | `4000`                                           |
| `DATABASE_URL` | `postgres://localhost:5432/cetizion_tracker`     |
| `CORS_ORIGIN`  | `http://localhost:5173`                          |

### Database commands

| Command              | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `npm run db:create`  | Create the database if it does not exist                |
| `npm run migrate`    | Drop and rebuild the schema and views                   |
| `npm run seed`       | Load `db/seed.sql` — the real data from your workbook    |
| `npm run seed:demo`  | Load `db/demo.sql` — the workbook's worked example       |
| `npm run reset`      | create → migrate → seed, in that order                  |

`npm run migrate` **drops every table**. It is a rebuild, not an incremental migration.

---

## What got imported

`server/scripts/generate_seed.py` reads the workbook and writes the SQL. It has already
been run; re-run it if the workbook changes:

```bash
cd server
python3 scripts/generate_seed.py "../Cetizion_Sales_Expenses_and_Project_Tracker_final (2).xlsx"
npm run migrate && npm run seed
```

It loaded:

- **61 quotations** — with `₹2,90,000`, `€ 9600` and `833$` parsed into an amount plus a
  currency code, so mixed-currency values now add up correctly per currency.
- **7 projects** — one from the Project Tracker; the rest created from won quotations that
  referenced a project ID the tracker never defined.
- **25 trips** and **18 travel vendor invoices** from the travel sheets.
- **11 onboarding steps** for PRJ-2026-001, also available as a reusable checklist.
- The Services, Travel Vendors, Expense Categories and Settings lists.

Rows the workbook marked `Example - delete` were left out of `seed.sql` and put in
`demo.sql` instead, so the real data stays clean while the finance screens still have
something to show.

**Two things the import surfaced about the source data**, both visible on the dashboard:

- 18 quotations are marked *Won - PO Received* but have no project ID, so nothing can be
  invoiced against them. The action list has a **Register project** button for each.
- 18 travel vendor invoices have an invoice number but no amount — HR recorded the
  reference without the value. They show as *Enter amount*.

---

## How the app maps to the workbook

| Workbook sheet            | In the app                                                    |
| ------------------------- | ------------------------------------------------------------- |
| Sales Tracker             | **Quotations** — the four grey "reflected" columns are live    |
| Project Tracker           | **Projects**, plus a detail page per project                   |
| PO Register               | **Purchase orders**, plus a detail page per PO                 |
| PO Services               | Service lines on the PO detail page                            |
| Payment Schedule          | **Payment schedule** — the finance worklist                    |
| Onboarding                | Onboarding tab on the project page, with a standard checklist  |
| Travel Log                | **Trips**                                                      |
| Travel Vendor Invoices    | **Vendor invoices**                                            |
| Employee Expense Claims   | **Expense claims**                                             |
| The three dashboard tabs  | **Dashboard** and **Travel spend**                             |
| Instructions / follow-ups | **Action list** — every queue in one place                     |

### The flow, unchanged

1. Log the enquiry on **Quotations**.
2. When it is won, press **Register project** — this creates the project, links the
   quotation and optionally adds the 11-step onboarding checklist.
3. Register the **purchase order**. A project can hold several.
4. Add its **service lines** and set its **payment stages** (50/50, 30/70, 40/30/30 —
   the split builder checks they total 100%).
5. The moment the PO date is recorded, any stage triggered *On PO Registration* turns
   **To Invoice** and appears on the action list.
6. Finance presses **Invoice**, enters the number and date. The due date is computed from
   the PO's payment terms.
7. Finance presses **Record payment**. Status moves to Paid / Partially Paid / Overdue by
   itself.
8. Recording the PO's **actual delivery date** flips its *On Delivery* stages to
   **To Invoice**.
9. Sales sees invoiced / received / outstanding / payment status on the quotation without
   touching finance's data.

Travel works the same way: HR logs the trip once, records the vendor's bill against the
travel ID, and finance is prompted to pay by the following month-end. Employee claims
attach to the same travel ID and roll into the project's travel cost.

---

## Architecture

```
cetizion-tracker/
├── server/
│   ├── db/
│   │   ├── schema.sql      tables — only facts a person types
│   │   ├── views.sql       every formula the workbook had, as SQL
│   │   ├── seed.sql        generated from your workbook
│   │   └── demo.sql        the workbook's worked example
│   ├── scripts/
│   │   ├── db.js           create / migrate / seed
│   │   └── generate_seed.py  workbook → SQL
│   └── src/
│       ├── lib/resources.js  one registry entry per resource, with its Zod schema
│       ├── lib/crud.js       turns a registry entry into a REST router
│       └── routes/           dashboards, workflow actions, lookups, CSV export
└── web/
    └── src/
        ├── styles.css        the whole design system
        ├── components/       ui.jsx, ListPage, RecordForm, action dialogs
        └── pages/            one file per screen
```

### Nothing derived is stored

`payment_stages` stores the percent, the invoice number and the amount received.
It does **not** store the stage amount, the due date, the status, or the follow-up text —
`v_payment_stages` computes those on every read, exactly as the spreadsheet formula did:

```sql
WHEN NOT b.due_to_invoice                            THEN 'Not Due'
WHEN ps.invoice_no IS NULL                           THEN 'To Invoice'
WHEN ps.amount_received >= b.amount AND b.amount > 0 THEN 'Paid'
WHEN CURRENT_DATE > b.invoice_due_date               THEN 'Overdue'
WHEN ps.amount_received > 0                          THEN 'Partially Paid'
ELSE 'Due'
```

The same holds for PO totals, project rollups and the quotation's reflected columns.
A payment recorded on a stage changes the PO, the project and the quotation on the next
page load, with no recalculation step.

### Type any fact in exactly one place

The workbook's rule is enforced by foreign keys. A PO does not store a client name — it
belongs to a project, which has one. A vendor invoice does not store the employee or the
project — it belongs to a trip, which knows both.

---

## API

All responses are `{ "data": ... }`; errors are
`{ "error": { "message": "...", "fields": { … } } }`.

**Resources** — `quotations`, `projects`, `purchase-orders`, `po-services`,
`payment-stages`, `onboarding`, `travel-logs`, `vendor-invoices`, `expense-claims`,
`services`, `travel-vendors`, `expense-categories`. Each supports:

```
GET    /api/<resource>?q=&limit=&offset=&sort=col:desc&<filter>=value
GET    /api/<resource>/:id          # numeric id, or the human key (PRJ-2026-001)
POST   /api/<resource>
PATCH  /api/<resource>/:id
DELETE /api/<resource>/:id
```

**Composite reads**

```
GET  /api/projects/:projectId/full         project + POs + stages + onboarding + travel
GET  /api/purchase-orders/:poNumber/full   PO + services + stages + travel
GET  /api/travel-logs/:travelId/full       trip + vendor invoices + claims
```

**Workflow actions**

```
POST /api/quotations/:id/convert                    won quotation → project
POST /api/projects/:id/onboarding/apply-template    add the 11 standard steps
POST /api/purchase-orders/:poNumber/stages          create a payment split (must total 100%)
POST /api/payment-stages/:id/invoice                record invoice no + date
POST /api/payment-stages/:id/payment                record a receipt
POST /api/vendor-invoices/:id/pay                   pay a travel vendor
POST /api/expense-claims/:id/decide                 approve / reject / hold
POST /api/expense-claims/:id/reimburse              reimburse an approved claim
```

**Other**

```
GET /api/dashboard/overview      headline numbers
GET /api/dashboard/worklist      everything waiting on someone
GET /api/dashboard/travel        travel spend analysis
GET /api/lookups                 dropdown data, in one request
GET /api/lookups/next-id/:kind   suggests CTZ/QT/2026/063, PRJ-2026-008, …
GET /api/settings                the assumptions the views read
GET /api/export/:resource.csv    any list, as a spreadsheet
```

CSV export means the spreadsheet is now an output, not the system of record.

---

## Notes before production use

This is an internal tool built to run on a trusted network. Before exposing it more
widely you would want to add:

- **Authentication and roles.** There is none — anyone who reaches the API can write.
  The workbook has the same property, but a URL travels further than a file.
- **An audit trail.** Rows carry `created_at` / `updated_at`, but not who changed what.
- **Incremental migrations.** `npm run migrate` rebuilds from scratch, which is right for
  setup and wrong once there is data you cannot regenerate.
- **Backups** of the Postgres database.
