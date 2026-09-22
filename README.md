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
| `BUSINESS_TIME_ZONE` | `Asia/Kolkata` — the year in reference numbers and server-stamped dates |
| `EMAIL_MODE`        | `log` — nothing is sent. `sandbox`: only `EMAIL_ALLOWLIST` addresses. `live`: over SMTP |
| `SMTP_HOST` / `_PORT` / `_SECURE` / `_USER` / `_PASS` | none — needed for `EMAIL_MODE=live` |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` / `EMAIL_BCC` | the sender on every outgoing email |
| `OPENROUTER_API_KEY` | none — without it the importer uses its built-in rules only |
| `OPENROUTER_MODEL`  | `deepseek/deepseek-v4.1-flash` — any model id OpenRouter serves |

Every email is written to `email_log` whatever the mode, so `log` gives a full dry run:
the reminder is composed and recorded, and marked `suppressed` because nothing left the
server. A stage only counts as chased once an email really goes out, so switching to
`live` sends the first real reminders that day rather than treating them as already sent.

The repository variable `CODEQL_ENABLED=true` turns on the CodeQL scan in CI. It is off
until GitHub code scanning is enabled for the repository; the other scans always run.

### Tests

```bash
cd server
npm test               # needs no database; the migration runner's tests are skipped

# With a Postgres the tests may create throwaway databases on, those run too:
TEST_DATABASE_URL=postgres://localhost:5432/postgres npm test
```

### Database commands

| Command              | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `npm run db:create`  | Create the database if it does not exist                |
| `npm run migrate`    | Drop and rebuild the schema and views                   |
| `npm run db:upgrade` | Apply pending `db/migrations`, then views if needed — keeps data |
| `npm run seed`       | Load `db/seed.sql` — the real data from your workbook    |
| `npm run seed:demo`  | Load `db/demo.sql` — the workbook's worked example       |
| `npm run reset`      | create → migrate → seed, in that order                  |

`npm run migrate` **drops every table**. It is a rebuild, not an incremental migration.
On a database that holds real data, `npm run db:upgrade` runs only the files in
`db/migrations` that have not run yet, in name order, and records each in
`schema_migrations`. It rebuilds the views, which hold no data, when `views.sql` changed
or a migration ran. Production needs no one to run it: the container does it on every
start (see [Deploying](#deploying)).

A schema change goes in two places: `schema.sql`, and a new file in `db/migrations`
numbered after the last (`010_…sql`). Each migration:

- **runs once**, in its own transaction together with its record, so it is applied
  whole or not at all. Leave `BEGIN`/`COMMIT` out of the file; the runner refuses one
  that has them.
- **is never edited once merged.** A changed file is not run again; put the fix in a new
  migration.
- **is checked by CI**, which applies it to the schema production has and fails if the
  result differs from a database built from `schema.sql`.

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
│   │   ├── migrations/     numbered changes for a database that holds data
│   │   ├── seed.sql        generated from your workbook
│   │   └── demo.sql        the workbook's worked example
│   ├── scripts/
│   │   ├── db.js           create / migrate / upgrade / seed
│   │   └── generate_seed.py  workbook → SQL
│   └── src/
│       ├── start.js          production entry: pending migrations, then the API
│       ├── migrations.js     the migration runner (schema_migrations, advisory lock)
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
GET /api/lookups/next-id/:kind   the next number in a series (CTZ/QT/2026/063, PRJ-2026-008, …) —
                                 enquiry, quotation and project numbers are assigned by the
                                 server on create and cannot be typed or changed
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

### The worker

Scheduled work runs in a second process, not in the API:

```bash
npm run worker --prefix server
```

**Without it nothing scheduled happens at all** — no payment reminders, no finance
digest, no nightly document purge. The API still serves the app, and the admin
"Run now" button on Emails & jobs still runs a job by hand, so the absence is quiet.

In Dokploy it is a second application from the same image and the same environment,
with the start command changed to `node server/src/worker.js`. Run exactly one:
two workers would send every reminder twice.

The schedule lives in `server/src/jobs.js`, in the business time zone:

| Job | When | What it does |
| --- | --- | --- |
| `reminders.payment` | 09:00, weekdays | One email per client with overdue invoices, at most once per `reminder_interval_days` |
| `finance.digest` | 09:30, weekdays | Summary to `finance_email`: stages to invoice, overdue invoices, reminders sent today |
| `documents.purge` | 03:00, daily | Finishes interrupted document removals |

The digest runs after the reminders so its count covers the same morning.

### CI/CD: from a merge to production

```
pull request ──► checks
merge to main ─► checks ─► deploy job moves `production` ─► Dokploy builds and starts
                  │                                            the container: pending
                  └─ any failure: nothing is deployed          migrations, then the API
```

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job | What it does |
| --- | --- |
| Server tests and migrations | `npm test` against a Postgres 17 service, then `scripts/ci/check-migrations.sh`: builds the schema production has (a pull request's base; for `main`, the `production` branch) with its seed data, upgrades it with this commit's migrations as the container would, upgrades again to confirm nothing is left, and diffs the result against a database built from `schema.sql` |
| Web build | `npm run build` for the front end |
| Docker image builds | The image Dokploy deploys still builds |
| Deploy to production | On `main` only, once the three above pass: fast-forwards the `production` branch to this commit, then waits until `/api/health` reports a new `started_at`, i.e. the new container is serving |

**Dokploy deploys the `production` branch, not `main`.** A push to `main` that fails a
check is never deployed. Nobody pushes to `production` by hand, except to roll back.

Run the migration check locally before pushing a schema change:

```bash
TEST_DATABASE_URL=postgres://localhost:5432/postgres scripts/ci/check-migrations.sh origin/production
```

### Database changes ship with the code

`npm start`, and the Docker image, run `src/start.js`: it applies any pending migrations,
then starts the API. There is no step to remember.

- A deploy with no schema change logs `database schema is up to date` and starts.
- A migration that fails is rolled back and **the API does not start**, so the app never
  serves requests against a schema its code does not match. The log names the file and
  the error, and the deploy job fails. Dokploy starts a new container before stopping
  the old one and rolls back a container that does not come up, so the previous version
  keeps serving. Fix it in a new commit and merge again.
- **Migrations must work with the code already running.** The old container still
  serves while the new one migrates: add columns and tables freely, but remove or rename
  one only in a later deploy, after no running code reads it.
- Two containers starting together are safe: an advisory lock makes the second wait,
  then find nothing to do.
- A brand-new, empty database still needs `schema.sql` and `views.sql` once, by hand
  (`npm run migrate`). From then on migrations take care of it.

### Rolling back

Point `production` at the last good commit; Dokploy deploys it:

```bash
git push --force origin <good-commit>:production
```

Code rolls back; the database does not. A migration already applied stays applied,
which is why migrations must work with the code before them. The next merge to `main`
deploys as usual, since `main` still contains the commit rolled back to. Only a commit
made on `production` alone (never do this; fix on `main`) stops the deploy job, which
refuses to overwrite it.

---

## Operations, security and integrations

| Guide | What it covers |
| --- | --- |
| [docs/operations.md](docs/operations.md) | The incident note: where to look, how to roll back, who to tell; error tracking, uptime checks, alerts and metrics |
| [docs/backups.md](docs/backups.md) | Off-site backups, the weekly restore check, and the restore runbook |
| [docs/security.md](docs/security.md) | Closing the database port, where secrets live, rotating them, sign-in protection, access review |
| [docs/staging.md](docs/staging.md) | The staging environment: what it is for, how it is deployed and refreshed |
| [docs/mcp.md](docs/mcp.md) | Asking Claude about live tracker data |
| [docs/webhooks-n8n.md](docs/webhooks-n8n.md) | Webhooks, signatures and two n8n recipes |

## Notes before production use

Sign-in closes the front door. Still missing for wider use:

- **Roles.** One account, full access. Anyone who can sign in can write anything.
- **An audit trail.** Rows carry `created_at` / `updated_at`, but not who changed what —
  which is nearly free to add now that requests carry a user.
- **Backups** of the Postgres database.
