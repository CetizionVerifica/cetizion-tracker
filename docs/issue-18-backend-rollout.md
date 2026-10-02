# Issue #18 backend: migrating, rehearsing, and switching it on

What has to happen, in what order, to take a database from "one shared
login and a free-text salesperson" to "every record belongs to an account".

The dangerous part is not the schema. Every migration here is additive and
re-runnable. The dangerous part is **step 5**: the moment row scoping is
live, a record with no owner becomes admin-only, and a salesperson whose
records were never backfilled loses sight of their own pipeline. Issue #18
names that as the rollout risk in its own words:

> an admin must check the Unassigned queue **before** scoping is switched
> on, or people will lose sight of their records.

So the order below exists to make that moment boring. Everything before it
is reversible and changes nothing anybody can see.

---

## What the migrations do

| | | Reversible? |
|---|---|---|
| `059_record_ownership.sql` | `owner_user_id` on enquiries, quotations, projects. Writes no row. | yes — drop three columns |
| `060_backfill_record_ownership.sql` | Assigns an owner where the data names one beyond doubt. DML only. | no, but it only ever fills a null |
| `061_ownership_history.sql` | `ownership_history`, the handover record. | yes |
| `062_sales_targets_and_origin.sql` | `sales_targets`, and the originating-salesperson columns. | yes |
| `064_mcp_token_identity.sql` | `api_tokens.user_id`; binds existing tokens, revokes what it cannot bind. | column yes; **the revocations are not** |
| `065_decision_dates.sql` | `won_at`, `lost_at`, `enquiries.decided_at` and their estimated flags, plus the trigger that keeps them. Backfills from `closed_at` or `quotation_date`. | yes |
| `066_auth_events_identity.sql` | `auth_events.user_id`, so a sign-in names an account. | yes |
| `067_target_periods.sql` | `sales_targets` keyed on a period rather than a calendar year; seeds the stale-quotation threshold. | yes |
| `068_payment_origin.sql` | `payments.origin`, so a receipt can be told from a balance carried in. | yes |

Two of these change what somebody sees the moment they run:

- **064 revokes MCP tokens** whose `person` matches no account, or more than
  one. Anybody using such a token gets a 401 on their next call. That is
  deliberate — see `db/migrations/064_mcp_token_identity.sql` — but it is
  the one migration that can interrupt someone's day, so run it knowing who
  holds a token. `SELECT name, person FROM api_tokens WHERE revoked_at IS
  NULL AND role = 'sales'` before, and re-issue afterwards from Settings.
- **065 stamps decision dates** on every won and lost quotation. Figures
  derived from a guess carry `won_at_estimated` / `lost_at_estimated`; a
  report that does not surface that flag will show a sales cycle of zero
  days for historical deals and look broken rather than approximate.

Two more change shape rather than behaviour, and are worth knowing about:

- **067 re-keys `sales_targets`** from `calendar_year` to a period. Existing
  annual targets keep their value and become a January–January range;
  `calendar_year` is kept beside them and becomes nullable. Nothing anybody
  set is lost, but any client posting `calendar_year` must now post a
  period — see the API note below.
- **068 labels existing `payments` rows** by what they are. It only ever
  relabels rows the trigger itself wrote, and the arithmetic
  `payments_changed` does is untouched: the stage total is still the sum of
  its rows.

### What collections will and will not tell you

Worth setting expectations before the first report is read, because the
number is deliberately not one number:

| bucket | what it is |
|---|---|
| `collected_inr` | receipts with a real date, inside the period. The confident figure. |
| `collected_estimated_inr` | a pre-#27 cumulative total carried in on the last receipt's date. It lands in one period when it may have arrived across several. |
| `collected_undated_inr` | money on a stage that never reached the ledger, or a receipt with no date. Real, and not placeable in any period. |

The per-receipt history before #27 was never recorded and cannot be
reconstructed. Spreading a lump across periods would be fabrication that
looks like data, so it is reported separately instead.

---

## The order

### 1. Take a backup

The cutover writes nothing irreversible, but 060 and 065 write data and
064 revokes tokens. This is the cheapest moment to have one.

### 2. Run the migrations

```bash
npm --prefix server run db:upgrade
```

Nothing visible changes yet. `owner_user_id` is null on every row, and an
unowned record is not yet restricted because scoping is not live until the
application code that reads it is deployed (step 5).

### 3. Create the people

The historical salespeople are text on records, not accounts. 060 matches
against accounts that already exist, so on a database where none do it
correctly assigns nothing — and a migration runs once.

Rehearse first. It writes nothing:

```bash
npm --prefix server run ownership:backfill -- --create-users --dry-run
```

```
Historical salespeople — dry run. Nothing is written.

  would create  Ramesh Kumar  (37 records · ramesh@cetizion.in)
  would create  Vishnu        (24 records · no address)
  AMBIGUOUS     Asha — 2 accounts carry this name; assign these 6 records by hand.
```

Read that list with somebody who knows the business. This is the only step
that invents identities, and an identity invented wrongly is a person who
does not exist appearing in Settings → Users and on a leaderboard.

Then, when the list is right:

```bash
npm --prefix server run ownership:backfill -- --create-users
```

Accounts are created **inactive**, with no password. They cannot sign in
until an admin sets one deliberately. An admin can also do all of this from
the app — `GET`/`POST /api/ownership/historical-salespeople`.

### 4. Assign the owners, and clear what is left

```bash
npm --prefix server run ownership:backfill -- --dry-run   # what it would claim
npm --prefix server run ownership:backfill               # claim it
```

Safe to re-run: it only ever moves a row from "no owner" to "this owner".
Run it again after adding more people.

Then work the queue down. **This is the step that must finish before step 5.**

```
GET  /api/ownership/unassigned                          how many are left, per table
GET  /api/ownership/unassigned?entity=quotations        oldest first
GET  /api/ownership/unassigned/quotations/suggestions?ids=…
PATCH /api/{enquiries|quotations|projects}/:id/owner    accept one — writes the history
```

A suggestion is never applied automatically. Accepting one is the PATCH,
which is what writes `ownership_history` and the activity row.

It is fine to finish with records still unowned — a deal nobody can place
is a real state. What must not happen is finishing with records unowned
that somebody *is* actively working, because they will stop seeing them.

### 5. Deploy the application

Row scoping goes live here, not at the migration. From this point:

```
admin, or the legacy shared login    every row
a database sales user                rows they own
nobody                               rows owned by nobody
```

A sales user asking for a record they do not own gets **404, not 403** — the
same answer as an id that does not exist, so nobody can map the database by
asking for ids one at a time.

### 6. Re-issue MCP tokens

Check what 064 revoked and issue replacements against accounts:

```
GET  /api/api-tokens
POST /api/api-tokens   { name, role: 'sales', user_id: <users.id> }
```

A name is still accepted and resolved, but only when it names exactly one
active account.

### 7. Re-point anything that posts a target

`PUT /api/kpis/users/:id/targets/:metric` now takes a period instead of
`calendar_year`:

```jsonc
// before
{ "calendar_year": 2026, "target_value": 5000000, "unit": "currency", "currency": "INR" }
// after — a month, which is what #18 §4 asks for
{ "period": { "preset": "month", "anchor": "2026-04-15" }, "target_value": 400000, "unit": "currency", "currency": "INR" }
// or a whole year
{ "period": { "preset": "fy", "anchor": "2026-06-01" }, "target_value": 5000000, "unit": "currency", "currency": "INR" }
```

The reports take the same vocabulary — `?period=month&on=2026-04-15`, or an
explicit `?from=&to=` — and default to the current Indian financial year.

### 8. Confirm

- `GET /api/ownership/unassigned` → the total you expect, not a surprise.
- Sign in as a sales user: their lists, search, CSV and PDF show their work.
- Sign in as an admin: everything, plus the handover history.
- `SELECT COUNT(*) FROM quotations WHERE status = 'Won - PO Received' AND won_at IS NULL` → the deals with nothing to infer a date from.

---

## Rehearsing on a copy of production

#18's acceptance criteria require the backfill to be rehearsed on a copy
before release. The whole of steps 2–4 is safe to run against a restored
dump, and produces the numbers you will see live:

```bash
createdb tracker_rehearsal
pg_restore -d tracker_rehearsal <dump>
DATABASE_URL=postgres://…/tracker_rehearsal npm --prefix server run db:upgrade
DATABASE_URL=postgres://…/tracker_rehearsal npm --prefix server run ownership:backfill -- --create-users --dry-run
DATABASE_URL=postgres://…/tracker_rehearsal npm --prefix server run ownership:backfill -- --dry-run
```

The dry-run report classifies every unowned row by why it is unowned, and
prints counts only — no name, no address, no record id — so the output can
be pasted into a ticket.

| column | meaning |
|---|---|
| email / name | rows a backfill would claim, by which rule |
| ambiguous | the name belongs to more than one account — left unowned |
| no match | an address that belongs to no account — left unowned |
| no signal | no salesperson recorded, or a name nobody carries |

**Do not run any of this against production data from a developer
machine.** Steps 2–4 belong in the deploy pipeline or on the box, with the
production credentials that live there.

---

## Rolling back

| Situation | What to do |
|---|---|
| Scoping hides too much | Redeploy the previous application build. The columns stay; nothing reads them. This is the fast lever and it needs no database change. |
| The backfill assigned wrongly | Reassign through `PATCH …/owner`, which records the correction. Do not `UPDATE` the column by hand — the history is the point. |
| A token was revoked in error | Issue a new one. A revoked token is never un-revoked: the row is the record that it stopped working. |
| A decision date is wrong | `UPDATE quotations SET won_at = …, won_at_estimated = false`. The trigger keeps an explicit date; only a null is filled with `now()`. |
| A collections figure looks low | Check `estimates.collected_estimated_inr` and `collected_undated_inr` beside it. Money from before #27 is usually in one of those rather than missing. |

There is no `DROP COLUMN` step in any of these. Removing `sales_person` and
the other free-text columns is a separate, later migration, and #18's rule
is that it does not happen until an admin has checked the backfill.
