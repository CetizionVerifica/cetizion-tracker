---
name: test-app
description: Test the Cetizion tracker end to end, isolated from the dev database. Runs typechecks, server and web unit tests, the DB-backed suites, the migration check, the web build, Playwright critical flows and a smoke test of every route, then reports what failed and why. Use when asked to test the app, check a branch before a PR, or confirm nothing is broken.
argument-hint: "[quick | full | ci] [--keep-db] [--fix]"
disable-model-invocation: true
---

# /test-app: test the tracker thoroughly

Arguments: `$ARGUMENTS`

| Mode | Runs |
| --- | --- |
| `quick` | Phases 0–2: preflight, static checks, unit tests (no database) |
| `full` (default) | Every phase below |
| `ci` | Exactly what `.github/workflows/ci.yml` runs, nothing extra (phases 0–4 + e2e flows) |

`--keep-db` leaves the QA database in place afterwards for inspection.
`--fix` lets you fix failures after the report; **without it, do not edit any
source file.** Report and stop.

## Ground rules

- **Never touch the developer's data.** Don't run `npm run reset`,
  `npm run migrate` or `npm run seed*` without an explicit
  `DATABASE_URL` pointing at the QA database `cetizion_tracker_qa`. The
  server's `dotenv` does not override variables already set, so an exported
  `DATABASE_URL` always wins over `server/.env`.
- Never run anything against production or staging URLs.
- Force `EMAIL_MODE=log` for every process you start, so nothing is emailed.
- Run phases in order and **keep going after a failure**. The goal is the full
  picture, so record each failure and continue. Only stop early if
  preflight cannot be satisfied.
- Run long commands with a generous timeout (server tests and Playwright can
  take several minutes). Save each phase's full output to the scratchpad
  directory so failures can be quoted exactly.
- Run from the repo root (`git rev-parse --show-toplevel`). Use absolute
  paths.

## Phase 0: Preflight

Check and record each of these. Fix what you safely can, and ask the user about anything else.

1. `node -v`. The project targets **Node 24**. On anything lower, warn in the
   report (CI uses 24, so version-specific failures may be local only), but
   continue.
2. `pg_isready`. Postgres must be up. If not, stop and tell the user how to
   start it (`brew services start postgresql@17`).
3. `git status --short` and `git rev-parse --abbrev-ref HEAD`. Note the branch
   and any uncommitted changes in the report, because the results apply to the working
   tree, not a commit.
4. Dependencies: if `server/node_modules` or `web/node_modules` is missing, or
   older than its `package-lock.json`, run `npm ci` in that directory.
5. Playwright browser: `npx --prefix web playwright install chromium` (fast
   no-op when present).
6. Ports **4000, 5173 and 4100**: `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
   - 4100 must be free (the QA server). If taken, pick another free port
     and use it for `PORT`/`SMOKE_BASE_URL` below.
   - If 4000 or 5173 is in use, the developer's dev servers are running.
     Playwright's critical-flow config reuses them, so it would test **the dev
     database**, not the QA one. Ask the user whether to stop them for the run
     or skip the e2e-flows step. Never kill their processes without asking.
7. Work out the database URLs:
   - Admin URL for throwaway databases: `TEST_DATABASE_URL`, if set; else
     `postgres://localhost:5432/postgres`. Check it with
     `psql "$URL" -c 'select 1'`; if that fails, try
     `postgres://postgres:postgres@localhost:5432/postgres`, then ask.
   - QA database: the same server with database `cetizion_tracker_qa`.

## Phase 1: Static checks

```bash
npm --prefix server run typecheck
npm --prefix web run typecheck
npm --prefix web run build          # also produces web/dist for phase 6
```

## Phase 2: Unit tests (no database)

```bash
npm --prefix server test
npm --prefix web test
```

`quick` mode stops here and goes to the report.

## Phase 3: Database-backed server suites

These create and drop their own throwaway databases.

```bash
TEST_DATABASE_URL=<admin url> npm --prefix server test
```

Compare the pass count with phase 2. If it is the same, the DB suites
silently skipped. Report that as a problem, not a pass.

## Phase 4: Migrations upgrade production's schema correctly

Base ref: `origin/production` if it exists, else `origin/main`.
`git fetch origin --quiet` first.

```bash
TEST_DATABASE_URL=<admin url> scripts/ci/check-migrations.sh <base ref>
```

Also check the rules from WORKFLOW.md on any migration this branch adds
(`git diff --name-only <base ref> -- server/db/migrations`):
- the file is new; no merged migration was edited
- no `BEGIN`/`COMMIT`
- the numbering continues without a gap or duplicate
- `server/db/schema.sql` changed in the same diff

## Phase 5: Prepare the QA database

```bash
export DATABASE_URL=<qa url> EMAIL_MODE=log AUTH_MODE=shared \
       AUTH_USERNAME=admin AUTH_PASSWORD=cetizion-dev NODE_ENV=development
npm --prefix server run reset       # creates/rebuilds cetizion_tracker_qa only
npm --prefix server run seed:demo
```

Before running `reset`, echo `DATABASE_URL` and confirm it ends in
`/cetizion_tracker_qa`. If not, stop.

## Phase 6: Browser tests

**6a. Critical flows** (`web/e2e/flows.spec.js`: sign-in, quote, companies,
import and commit), with the phase-5 environment still exported:

```bash
E2E_USERNAME=admin E2E_PASSWORD=cetizion-dev npm --prefix web run test:e2e
```

Skip this step if the user chose not to free ports 4000/5173.

**6b. Route smoke test** (`web/e2e-smoke/`: every screen, admin session,
fails on render crash, uncaught error, console error or API 5xx). Start the
QA API in the background (it serves `web/dist` from phase 1):

```bash
PORT=4100 node server/src/index.js      # run_in_background, same env as phase 5
```

Wait until `curl -fsS localhost:4100/api/health` answers (up to ~30 s), then:

```bash
SMOKE_BASE_URL=http://localhost:4100 E2E_PASSWORD=cetizion-dev npm --prefix web run test:smoke
```

If routes in `web/src/App.jsx` aren't in `ROUTES` in
`web/e2e-smoke/routes.spec.js`, list them in the report as untested.

**6c. Flake check.** Re-run each failing Playwright test once on its own
(`--grep "<title>"`). If it passes the second time, mark it **flaky**, not
failed, and say so.

`web/e2e-authz/` is **not runnable as committed** (see the note at the top
of `authz.spec.js`). Don't run it; mention it in the report as a known gap.

## Phase 7: Clean up (always, even after failures)

- Stop the QA API on 4100 and any dev servers Playwright started.
- Unless `--keep-db`:
  `psql <admin url> -c 'DROP DATABASE IF EXISTS cetizion_tracker_qa WITH (FORCE)'`
- Leave `web/test-results/` (traces and screenshots of failures). It is
  git-ignored.
- `git status --short` must match preflight, apart from git-ignored files.
  If a test run changed a tracked file, report it.

## Phase 8: Report

Lead with a one-line verdict: **ready for a PR**, **not ready**, or
**ready but with warnings**. Then a table:

| Phase | Result | Detail |
| --- | --- | --- |
| Typecheck server / web | ✅ / ❌ | error count |
| Web build | | |
| Unit tests server / web | | passed / failed / skipped |
| DB-backed server suites | | |
| Migration check | | |
| E2E critical flows | | |
| Route smoke | | N routes, N detail pages |

Group failures that share a root cause into one entry and name every test it
hits. For example, one console error repeated on all 45 routes is one bug,
not 45. Then, for each distinct failure, in order of severity:
- the test or check name, and `file:line` where it failed
- the exact error (quoted, trimmed to the lines that matter)
- your read of the cause, saying whether you verified it or are inferring
- for Playwright failures, the trace path under `web/test-results/`

Then list warnings: Node version, flaky tests, skipped suites, untested
routes, the e2e-authz gap, and uncommitted changes.

Don't call something passing unless it ran. A suite that was skipped is
reported as skipped.

With `--fix`, after the report, fix the failures one at a time. Re-run only
the affected check after each fix, then re-run the full set once at the end and
report again. Never "fix" a failure by weakening or deleting the test unless
the user agrees the test is wrong.
