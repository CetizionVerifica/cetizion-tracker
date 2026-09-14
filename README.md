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

Sign in with `admin` / `cetizion-dev` — the development fallback. See
[Sign-in](#sign-in) for the real thing.

### Configuration

Everything has a working default in development. To change one, copy
`server/.env.example` to `server/.env`:

| Variable            | Default                                      |
| ------------------- | -------------------------------------------- |
| `PORT`              | `4000`                                       |
| `DATABASE_URL`      | `postgres://localhost:5432/cetizion_tracker` |
| `CORS_ORIGIN`       | `http://localhost:5173`                      |
| `AUTH_USERNAME`     | `admin`                                      |
| `AUTH_PASSWORD`     | `cetizion-dev` — **required in production**  |
| `SESSION_SECRET`    | random per boot — **required in production** |
| `SESSION_TTL_HOURS` | `12`                                         |
| `COOKIE_SECURE`     | on when `NODE_ENV=production`                |
| `TRUST_PROXY`       | `0`                                          |
| `WEB_DIST_DIR`      | `../web/dist`                                |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | none — needed for document uploads           |
| `CLOUDINARY_FOLDER` | `cetizion-tracker` — use another folder locally |
| `DOCUMENT_MAX_MB`   | `10` (the Cloudinary Free plan limit)        |

### Tests

```bash
cd server
npm test               # the sign-in gate; needs no database
```

### Database commands

| Command              | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `npm run db:create`  | Create the database if it does not exist                |
| `npm run migrate`    | Drop and rebuild the schema and views                   |
| `npm run db:upgrade` | Apply `db/migrations`, then rebuild the views — keeps data |
| `npm run seed`       | Load `db/seed.sql` — the real data from your workbook    |
| `npm run seed:demo`  | Load `db/demo.sql` — the workbook's worked example       |
| `npm run reset`      | create → migrate → seed, in that order                  |

`npm run migrate` **drops every table**. It is a rebuild, not an incremental migration.
On a database that holds real data (production), use `npm run db:upgrade` instead: it
runs every file in `db/migrations` — each written so running it twice is harmless — and
rebuilds the views, which hold no data. A schema change goes in both `schema.sql` and a
new migration file.

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

1. Log the enquiry on **Enquiries**. Setting its status to *Won - Quotation Sent* creates
   the quotation on **Quotations** with the enquiry's details, and links the two.
2. When the quotation is won, press **Register project** — this creates the project, links the
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
│       ├── app.js            the Express app, assembled
│       ├── auth/             the sign-in gate (config, session, routes)
│       ├── web.js            serves web/dist in production
│       ├── lib/resources.js  one registry entry per resource, with its Zod schema
│       ├── lib/crud.js       turns a registry entry into a REST router
│       └── routes/           dashboards, workflow actions, lookups, CSV export
└── web/
    └── src/
        ├── styles.css        the whole design system
        ├── lib/auth.jsx      who is signed in
        ├── components/AuthGate.jsx  the gate around the app
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

## Sign-in

One user, one password, so a deployed link is not an open door. There are no accounts
table and no roles — the credentials live in the environment beside `DATABASE_URL`.

```
AUTH_USERNAME=admin
AUTH_PASSWORD=<a long password used nowhere else>
SESSION_SECRET=<32+ random characters>
```

Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**In production the API will not start without `AUTH_PASSWORD` and `SESSION_SECRET`.**
That is deliberate: a tracker that boots unlocked because a variable was missed is the
exact failure this is here to prevent. In development both fall back — the password to
`cetizion-dev` — so `npm run dev` needs no setup.

How it works:

- Signing in sets an `httpOnly`, `sameSite=lax` cookie holding a payload signed with
  `SESSION_SECRET`. Nothing is stored server-side, so restarting the API or running two
  of them keeps everyone signed in.
- The cookie lasts `SESSION_TTL_HOURS` (12 by default). After that the app returns to
  the sign-in screen on the next request.
- Every `/api` route needs that cookie except `/api/health`, which the host needs to
  poll and which reveals only that the database answered.
- Ten failed attempts in fifteen minutes locks sign-in for the rest of the window.
  Successful ones are not counted. A run of typos will lock you out too — that is the
  cost of the lock being worth anything.
- Changing `SESSION_SECRET` signs everyone out, which is how you revoke a session.

Since there is one user, the password is the whole boundary. Make it long, and do not
use it anywhere else.

---

## API

All responses are `{ "data": ... }`; errors are
`{ "error": { "message": "...", "fields": { … } } }`.

Every route below requires a signed-in session. Without one they answer `401`.

**Sign-in** — `POST /api/auth/login` `{username, password}`, `POST /api/auth/logout`,
`GET /api/auth/me`.

**Resources** — `enquiries`, `quotations`, `projects`, `purchase-orders`, `po-services`,
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

## Deploying

The API serves the built front end, so one container is the whole app:

```bash
npm install            # from the repo root: installs both halves
npm run build          # produces web/dist
NODE_ENV=production npm start --prefix server
```

Set at minimum `DATABASE_URL`, `AUTH_PASSWORD` and `SESSION_SECRET`. Behind Traefik,
nginx or a load balancer also set `TRUST_PROXY=1` so the sign-in limiter counts the
visitor rather than the proxy. Serve it over HTTPS — the session cookie is marked
`secure` in production and the browser will not send it over plain HTTP. If TLS
genuinely is not available, `COOKIE_SECURE=false` is the escape hatch, and sign-in
travels in the clear.

Quotations and POs can carry an uploaded document, stored privately in Cloudinary with
only its reference in Postgres. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and
`CLOUDINARY_API_SECRET` too — without them uploads are refused.

`web/dist` is not committed, so `npm run build` has to run as part of the deploy.

---

## Notes before production use

Sign-in closes the front door. Still missing for wider use:

- **Roles.** One account, full access. Anyone who can sign in can write anything.
- **An audit trail.** Rows carry `created_at` / `updated_at`, but not who changed what —
  which is nearly free to add now that requests carry a user.
- **Migration tracking.** `npm run db:upgrade` re-runs every file in `db/migrations`, so
  each must be safe to repeat; nothing records which ones have already run.
- **Backups** of the Postgres database.
