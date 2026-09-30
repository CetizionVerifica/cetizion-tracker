# Issue #18 Phase 2B — ownership backfill

Branch `feature/issue-18-ownership-backfill`, stacked on
`feature/issue-18-ownership-schema` (2A) → `feature/issue-18-activity-log`
(1.5) → `feature/issue-18-auth-hardening` (1C). None is on `main` yet.

> **NULL ownership after the backfill is valid.** It means the historical
> owner could not be determined safely, not that the backfill failed.

## What this phase does

Phase 2A added `owner_user_id` to `enquiries`, `quotations` and `projects`
and left it null everywhere, because a migration that knows nothing about
the business has no safe way to fill it in. Migration
`060_backfill_record_ownership.sql` fills in the subset where the historical
data names somebody exactly, and leaves the rest alone.

The whole design is one rule: **never guess.** A null owner is a true and
useful statement. A wrong owner is a lie that looks like an answer, and
every later phase — row-level filtering, KPIs, reassignment — would build on
it silently.

## Matching precedence

**1. Exact salesperson email.** `lower(btrim(sales_person_email))` against
`lower(btrim(users.email))`, assigning only when exactly one user matches.
An email is an identity: two people do not share one, and `users_email_key`
(a unique index on `lower(email)`) enforces that. The count guard is
belt-and-braces — if the data ever contrives a second match, nobody is
assigned rather than whichever row the planner reached first.

Available on `enquiries` and `quotations` only. **`projects` has no
`sales_person_email` column** — only `sales_person`, plus `project_manager`
and `project_manager_email`, which belong to a different person.

**2. Exact salesperson name, and only when there is no email at all.**
`lower(regexp_replace(btrim(x), '\s+', ' ', 'g'))` on both sides, assigning
only when exactly one user carries that name.

**3. Otherwise NULL.**

### Why the name rule is guarded so heavily

It is genuinely weaker, and the data says so. The historical records name a
salesperson by bare first name — `Ramesh`, `Vishnu` — and `users.name` has
no unique index, so two people can share one. Three things keep it from
guessing:

* It runs **only where there is no email at all**. A row whose email matches
  nobody is left alone rather than falling back to its name: an address that
  resolves to no account means the data is off, and the name sitting beside
  a wrong address is not better evidence.
* It assigns **only when exactly one** user matches. Two Rameshes and the
  row stays null for a person to settle.
* "Ignoring spacing" means collapsing whitespace runs and trimming the ends
  — nothing more. No initials, no nicknames, no similarity, no partial
  matching. The app has a fuzzy name matcher for client names (`name_key`)
  and it is deliberately **not** used here.

It is also the only rule that can reach `projects`. Without it that table
could never be backfilled at all.

## Normalization

| | |
|---|---|
| Case | ignored, both sides (`lower`) |
| Leading/trailing space | ignored, both sides (`btrim`) |
| Internal whitespace runs | collapsed to one space, names only |
| Anything else | not normalised — `AliceSmith` ≠ `Alice Smith` |
| `NULL`, `''`, `'   '` | all treated as missing |

## Ambiguity

| situation | result |
|---|---|
| email matches two users | NULL |
| email matches nobody | NULL — **no** fallback to the name |
| email is malformed | NULL — no fuzzy correction |
| name matches two users | NULL |
| name matches nobody | NULL |
| both fields blank | NULL |

## Inactive users

Not filtered on `users.active`, and not on `users.role`. Somebody who has
left still owned what they sold, and an account promoted to admin since does
not stop having owned it.

This matters more than it sounds: an **attribution-only** user row — a name
from the old data, no email, cannot sign in (Phase 1A, `015_users.sql`) — is
exactly what the name rule exists to resolve. It is how a historical
salesperson becomes a real identity without inventing an email address for
somebody who never had one.

## Existing ownership is never overwritten

Every statement is `WHERE owner_user_id IS NULL`. A correction made by hand,
or any assignment made later, survives a re-run. There is a test that reads
the migration file and asserts all five `UPDATE`s carry that predicate, and
another that sets an owner contradicting every historical signal and checks
it stands.

## No relationship propagation

Each table is backfilled from **its own** fields. A quotation does not
inherit its enquiry's owner, and a project does not inherit its quotation's.
Phase 2A added no propagation either, and none is added here — inventing
relationship-based ownership is guessing by another name.

`project_manager` / `project_manager_email` are never consulted: delivering
a project is not owning the sale.

## What the migration must not do — and does not

No `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `INSERT` or `DELETE`. It is
**DML-only**: five `UPDATE`s, writing one column. No user is created,
reactivated, re-roled or altered — the `users` table is only ever read, and
a test snapshots it either side to prove it. `sales_person`,
`sales_person_email` and `project_manager` are untouched, down to their
original whitespace.

No authorization change of any kind. Row-level filtering is Phase 2C, and it
lands in one piece because scoping some endpoints and not others is worse
than scoping none.

No activity-log event. This is historical data normalisation, not a person
assigning work. Reassignment history is Phase 3.

## Two ways to run it, and why both exist

### Migration `019` — once, at deploy

Runs with every other pending migration when the container starts. It
opportunistically assigns any record whose salesperson already matches a
`users` row, and is then marked applied for good.

On every database that exists today that means it assigns **nothing**: the
historical salespeople are text in the records and not rows in `users`. That
is the correct, safe outcome — and it is also permanent, because a migration
does not run twice. Left there, those records would stay unowned forever.

### `npm run ownership:backfill` — whenever, by an operator

The same SQL, run on demand. The command does not contain the matching
rules: it reads `db/migrations/060_backfill_record_ownership.sql` and
executes it. One statement of what a deterministic match is, two ways to
invoke it — two SQL files that start identical and drift is how a "safe
deterministic backfill" quietly stops being either. A test asserts the
command's SQL is byte-identical to the migration on disk.

Run it **after** Settings → Users contains the historical salespeople, and
**before** Phase 2C row scoping is switched on. Run it again whenever more
people are added; it claims what newly resolves and leaves everything else
exactly as it was.

```
npm run ownership:backfill -- --dry-run   # counts only, writes nothing
npm run ownership:backfill                # apply, in one transaction
```

Not an API route, and deliberately not: this is a data-maintenance step
taken once with the user list in front of you, not something a browser
should be able to set off.

### Dry run

`--dry-run` is a real measurement, not a simulation: it classifies every
unowned row by the same rules the backfill applies, so the "email" and
"name" columns are exactly the set a run would claim. It is the same query
as the standalone diagnostic, formatted.

```
  table        total  owned  email   name ambiguous no match no signal
  ---------- ------ ------ ------ ------ --------- -------- ---------
  enquiries        0      0      0      0         0        0         0
  projects         7      0      0      7         0        0         0
  quotations      61      0      0     61         0        0         0

  68 records would be assigned an owner.
```

Counts only — no name and no email address leaves the command, asserted by
a test.

### Transaction

The apply path runs all three tables in **one** transaction: either every
deterministic assignment commits or none does. A run that got halfway would
leave quotations owned and projects not, with no way to tell which half
ran. Nothing is caught — a database refusal rolls the whole thing back and
exits non-zero, because a maintenance command that prints "done" over a
failure is worse than one that stops. There is a test that blocks the last
table mid-run and checks the first two were rolled back with it.

## Production sequence before Phase 2C

1. Review and create the historical salespeople under **Settings → Users**.
   Attribution-only rows — a name, no email, inactive — are the right shape
   for people who never had an account.
2. `npm run ownership:backfill -- --dry-run` — see what would be claimed.
3. `npm run ownership:backfill` — apply.
4. `npm run ownership:backfill -- --dry-run` again — confirm the counts.
5. Look at what is left. `ambiguous` means two users share a name; `no
   match` means an address belongs to no account; `no signal` means nothing
   usable was recorded. Fix the user list and repeat, or accept them.
6. Only then consider enabling Phase 2C sales row scoping.

**Every record does not need an owner.** NULL stays valid, and Phase 2C
treats an unowned record as admin-only.

## Re-running it

Safe and useful. It only ever moves a row from "no owner" to "this owner",
so a second run finds those rows non-null and skips them. If somebody is
added to `users` later, re-running claims the records that now resolve and
leaves everything else exactly as it was. There is a test for precisely that
sequence.

## Diagnostics

`db/diagnostics/ownership-backfill.sql` — read-only, counts only. No name,
no address and no record id leaves it, so its output can be pasted into a
ticket.

```
npm run ownership:backfill -- --dry-run                      # formatted
psql "$DATABASE_URL" -f db/diagnostics/ownership-backfill.sql  # raw
```

Deliberately not an API endpoint: it is an operator's question asked once
before Phase 2C, not a feature. The two "would match" columns should read
zero straight after a backfill; a number there means somebody has joined
`users` since, and a re-run would now claim those records.

### Against the shipped seed data

The seed carries 61 quotations and 7 projects, every one naming a
salesperson as text, none with a salesperson email, and no `users` rows at
all:

| state | table | total | owned | unassigned |
|---|---|---|---|---|
| seed as shipped | quotations | 61 | 0 | 61 |
| | projects | 7 | 0 | 7 |
| | enquiries | 0 | 0 | 0 |
| after adding `Ramesh` and `Vishnu` as attribution-only users | quotations | 61 | **61** | 0 |
| | projects | 7 | **7** | 0 |

Which is the phase in miniature: with nobody to match against it claims
nothing, and the moment the historical salespeople exist as user rows every
record resolves by unique name — with no guessing in between.

## Deferred

* automatic owner assignment for **new** records
* the admin assignment / reassignment workflow, and whether an inactive user
  may receive new work
* **Phase 2C** — row-level authorization across lists, details, lookups,
  exports, documents, reports and dashboards, landed together
* **Phase 3** — ownership history and handover
* ownership UI
* KPI logic and dashboards
