# Cetizion Tracker: project context and workflow

One page to read before touching the code. It says what the tracker is, how
it is built, and how a change travels from a branch to production. The
detail lives elsewhere and is linked; this file is the map.

---

## 1. What the project is

The tracker replaced `Cetizion_Sales_Expenses_and_Project_Tracker_final.xlsx`,
a nine-sheet workbook. It holds Cetizion Verifica's whole commercial cycle in
one web app:

- **Sales.** Enquiries, quotations priced line by line (GST, validity,
  revisions, discount approval, a client acceptance link) and a pipeline board.
- **Shared inbox.** Client email from connected Microsoft 365 mailboxes,
  matched to company and deal, assigned, and turned into enquiries.
- **Money.** Purchase orders with payment schedules, invoicing, receipts,
  collections ageing, cash-flow forecast, payables and profitability per
  project.
- **Delivery and travel.** Projects, onboarding checklists, milestones, site
  visits, trips, vendor invoices, expense claims, certificates and renewals.
- **Around the edges.** A command palette, saved views, a client portal,
  webhooks for n8n, an MCP server so Claude can query live data, and a bulk
  importer for the sales sheet, with optional AI review of the remarks.

Production: <https://tracker.cetizionverifica.com>

### The business flow

```
Enquiry ─▶ Quotation (line items, GST) ─▶ won ─▶ Register project
        ─▶ Purchase order + payment stages (must total 100%)
        ─▶ stage becomes "To Invoice" on its trigger (registration, delivery, milestone)
        ─▶ finance invoices ─▶ receipts ─▶ Paid / Partially Paid / Overdue follow by themselves
```

Travel has the same shape: a trip is logged once, and vendor bills and
employee claims attach to it and roll into the project's cost.

### The two rules the design rests on

1. **Nothing derived is stored.** Stage amounts, due dates, statuses and
   rollups are computed in SQL views (`server/db/views.sql`, e.g.
   `v_payment_stages`) on every read. If a value can be calculated, never add
   a column for it.
2. **Each fact is typed in exactly one place.** Foreign keys enforce this. A
   PO has no client name: it belongs to a project, which has one.

New features should follow both rules.

---

## 2. Stack and layout

**Node 24 · Express 5 · PostgreSQL 17 · React 19 · Vite · Tailwind 4 ·
shadcn/Radix · Recharts · pg-boss · Zod**

The server runs TypeScript directly through Node's type stripping, with no
build step. The codebase is being moved from `.js` to `.ts` one file at a time
(see [docs/typescript.md](docs/typescript.md)). `enum`, decorators, parameter
properties and namespaces holding values aren't allowed.

```
cetizion-tracker/
├── package.json            root scripts: setup, dev, build, reset
├── scripts/
│   ├── dev.js              starts API + web together (npm run dev)
│   ├── ci/                 check-migrations.sh, wait-for-deploy.sh
│   ├── backup/             backup, verify, restore-table
│   └── staging/            refresh.sh (restore + scrub)
├── server/
│   ├── db/
│   │   ├── schema.sql      tables: only the facts a person types
│   │   ├── views.sql       every workbook formula, as SQL
│   │   ├── migrations/     NNN_name.sql, numbered, never edited after merge
│   │   ├── seed.sql / demo.sql / scrub.sql
│   └── src/
│       ├── start.js        production entry: run migrations, then the API
│       ├── index.js        dev entry
│       ├── worker.js       scheduled jobs process (pg-boss); schedule in jobs.js
│       ├── auth/           sign-in, sessions, OAuth (Microsoft/Google), role gate
│       ├── lib/resources.js  one registry entry per resource, with its Zod schema
│       ├── lib/crud.js     turns a registry entry into a REST router
│       ├── lib/authz/      authorization policy and row scoping
│       ├── lib/mailbox/    Microsoft Graph sync, classification, sanitising
│       ├── lib/mcp/        MCP server tools
│       ├── import/         the bulk sheet importer
│       └── routes/         dashboards, workflow actions, exports, reports, webhooks
└── web/
    ├── src/
    │   ├── styles/globals.css   theme tokens (dark + derived light mode)
    │   ├── components/ui/       shadcn primitives; build from these
    │   ├── components/          ListPage, RecordForm, charts, shared dialogs
    │   ├── lib/                 api.js, auth, permissions, format helpers
    │   └── pages/               one file per screen
    ├── test/                    unit tests (node --test)
    ├── e2e/                     Playwright critical flows
    └── e2e-authz/               Playwright authorization checks
```

### Sign-in and roles

`AUTH_MODE=shared` (dev default) means one admin login: `admin` /
`cetizion-dev`. `AUTH_MODE=database` gives real accounts with `admin` or
`sales` roles, Microsoft or Google sign-in, and record-level scoping, so sales
users see their own records and no margin. The authorization matrix is
enforced by tests (`server/test/authorization.test.js`, see
[docs/issue-18-authorization.md](docs/issue-18-authorization.md)).

### The worker

Scheduled work (payment reminders, digests, mailbox sync, exchange rates,
renewals, webhook delivery) runs in a **separate process**:
`npm run worker --prefix server`. If the worker isn't running, nothing
scheduled happens, and nothing reports it. Run exactly one, because two would
send every email twice. The job table is in the README.

Email is safe by default. `EMAIL_MODE=log` records every email in `email_log`
and sends nothing. `sandbox` sends only to `EMAIL_ALLOWLIST`, and `live` sends
over SMTP.

---

## 3. Local development

```bash
npm run setup        # install server + web, create and seed the database
npm run dev          # API on :4000, web on :5173 (proxies /api)
```

Open <http://localhost:5173> and sign in with `admin` / `cetizion-dev`.

| Need | Command (in `server/`) |
| --- | --- |
| Apply new migrations, **keeping data** | `npm run db:upgrade` |
| Start over with seed data | `npm run reset` |
| Load the workbook's worked example | `npm run seed:demo` |
| Drop and rebuild everything | `npm run migrate` (**never on a database you care about**) |

Configuration goes in `server/.env` (copy `server/.env.example`). Every
variable has a dev default; the full table is in the README.

Never commit `server/import/` (real client sales sheets), `.env`, or
`.mcp.json`. They are already in `.gitignore`.

---

## 4. Workflow: from idea to production

The team rules are in [WORKFLOW.md](WORKFLOW.md). Below is the whole path as
it runs today.

### 4.1 Pick up work

1. Find the issue on GitHub. If it already has an assignee, a linked PR or a
   branch, someone else owns it; leave it.
2. Assign yourself and comment with what you'll build and how. That comment
   claims it.
3. Check the issue's **Needs** line. If it depends on unmerged work, build
   against what is merged and note the gap in the PR.
4. Update [ISSUE-PLAN.md](ISSUE-PLAN.md) with the claim.

### 4.2 Branch

Always cut from the latest `main`. Never commit to `main` or `production`.

```bash
git fetch origin
git switch -c <type>/<short-name> origin/main
```

Branch prefixes in current use: `feat/`, `fix/`, `docs/`, `chore/`, with the
issue number when there is one, e.g. `fix/issue-85-expense-approval` or
`feat/client-contact-details`. Older branches used `issue/<n>-<name>` and
`feature/<name>`; both are still accepted.

Keep one issue per branch and one PR per issue. Merge `origin/main` into your
branch before opening the PR, and again whenever `main` moves while it's open.

### 4.3 Commit

Use the Conventional-style prefix, optionally scoped, followed by a short
plain sentence describing what changes for the user:

```
feat(web): a light mode, derived rather than inverted
fix: a database failure reading a session is not a sign-out
docs: a plan for My Today, one sales person's list for the day
```

### 4.4 Database changes

CI rebuilds production's schema from the migrations and diffs it against
`schema.sql`, so the two must always agree.

- Add a **new** `server/db/migrations/<next number>_<name>.sql`. The latest
  is `064`.
- Make the same change in `schema.sql`, and in `views.sql` if a view changes.
- Don't put `BEGIN`/`COMMIT` in a migration; the runner wraps each one in a
  transaction and refuses a file that has them.
- **Never edit a merged migration.** The runner stores a checksum. Put fixes
  in a new file.
- Keep migrations **additive and safe**. They run on container start while the
  old version is still serving, so a failing migration takes the deploy down.

### 4.5 Checks before opening a PR

CI runs exactly these, so run them locally first:

```bash
cd server && npm run typecheck && npm test
TEST_DATABASE_URL=postgres://postgres:<pw>@localhost:5432/postgres npm test   # DB-backed suites
cd ../web && npm run typecheck && npm test && npm run build
npm run test:e2e                                                              # Playwright, needs reset + seed:demo
TEST_DATABASE_URL=... scripts/ci/check-migrations.sh origin/main             # from repo root
```

If you touched the importer, also run the graded workbooks (see
PROGRESS.md). The rules score must stay at 100%, and the AI review must catch
every planted case with no false flags.

### 4.6 Pull request

- The description says what changed and how it was tested, and ends with
  `Fixes #<number>`.
- A workflow automatically requests a review from **Hayyan612** (except on
  their own PRs). Drafts wait until marked ready.
- CI jobs that must pass: **Types**, **Server tests and migrations**, **Web
  build**, **Browser tests (Playwright)** and **Docker image builds**. The
  **Security** workflow (npm audit, gitleaks, Trivy, CodeQL when enabled)
  runs as well.

### 4.7 Merge and deploy (automatic)

```
PR merged to main ─▶ CI runs every check on main
                   ─▶ all green ─▶ deploy job fast-forwards the `production` branch
                   ─▶ Dokploy redeploys ─▶ container runs pending migrations ─▶ API starts
                   ─▶ CI waits until /api/health reports the new container
```

- **Staging** follows `main` the same way once the lead sets
  `STAGING_ENABLED=true`. It uses a scrubbed copy of production data and can't
  send email, webhooks or mailbox traffic (see [docs/staging.md](docs/staging.md)).
- **Rollback:** point `production` at the last good commit
  (`git push --force-with-lease origin <sha>:production`). Migrations only move
  forward, so see [docs/operations.md](docs/operations.md) before rolling back
  past one.

### 4.8 After merging

- Update [PROGRESS.md](PROGRESS.md), the plain-language summary for the boss,
  with no code.
- Update [ISSUE-PLAN.md](ISSUE-PLAN.md) with the new status.
- If a team rule changed, update [WORKFLOW.md](WORKFLOW.md).

---

## 5. Decisions that belong to the lead, not the team

- Server access and credentials: Dokploy, backups, database port, staging,
  monitoring. The team writes the code and runbooks; the lead applies them.
- Third-party accounts: SMTP, Microsoft 365 app registration, Cloudinary,
  accounting software (Zoho, Tally).
- Open product calls: the Next.js rewrite (#17; UI work stays in the current
  Vite app until decided), the mobile app (#51) and timesheets (#52).

---

## 6. Where to read more

| Topic | File |
| --- | --- |
| Product overview, config table, job schedule, API | [README.md](README.md) |
| Team rules for issues, branches and checks | [WORKFLOW.md](WORKFLOW.md) |
| Every issue, its owner and state | [ISSUE-PLAN.md](ISSUE-PLAN.md) |
| What has shipped, in plain language | [PROGRESS.md](PROGRESS.md) |
| Batch-by-batch build notes | [docs/batches/](docs/batches/) |
| Running production, incidents, rollback | [docs/operations.md](docs/operations.md) |
| Staging / backups / security | [docs/staging.md](docs/staging.md), [docs/backups.md](docs/backups.md), [docs/security.md](docs/security.md) |
| Bulk importer and its AI review | [docs/bulk-import.md](docs/bulk-import.md) |
| Authorization, ownership and row scoping (issue #18) | `docs/issue-18-*.md` |
| MCP server ("ask the tracker") | [docs/mcp.md](docs/mcp.md) |
| Webhooks into n8n | [docs/webhooks-n8n.md](docs/webhooks-n8n.md) |
| TypeScript migration rules | [docs/typescript.md](docs/typescript.md) |
| Sales reports and KPIs | [docs/SALES-REPORTS.md](docs/SALES-REPORTS.md) |
| Follow-up reminders and escalation (plan, tests) | [docs/follow-up-escalation-plan.md](docs/follow-up-escalation-plan.md), [docs/follow-up-escalation-test-plan.md](docs/follow-up-escalation-test-plan.md) |
| Quotation/PO documents (Cloudinary) | [DOCUMENTS.md](DOCUMENTS.md) |
