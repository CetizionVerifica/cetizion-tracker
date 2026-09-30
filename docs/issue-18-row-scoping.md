# Issue #18 Phase 2C — row-level ownership authorization

Branch `feature/issue-18-row-scoping`, stacked on
`feature/issue-18-ownership-backfill` (2B) → `ownership-schema` (2A) →
`activity-log` (1.5) → `auth-hardening` (1C). None is on `main` yet.

## The rule

```
admin, or the legacy shared login   every row
a database sales user               rows they own
nobody                              rows owned by nobody
```

An unowned record is **not public**. It is one whose owner could not be
determined (Phase 2B leaves those null deliberately), and the safe reading of
"we do not know whose this is" is "not yours". Admins see them; that is how
they get assigned.

Refusals are **404, not 403**, for a specific record a sales user does not
own — the same answer as an id that does not exist, so nobody maps the
database by asking for ids one at a time. 401 stays for unauthenticated, and
403 for things forbidden by role regardless of ownership (the admin-only
routes from Phase 1C are untouched).

## Where the rule lives

`src/auth/ownership.js`, and nowhere else. About twenty places can return one
of these rows; a rule written twenty times is a rule with twenty chances to
be written wrong, and the failure is silent — a missed predicate does not
break a test nobody wrote, it just serves somebody else's pipeline.

| helper | for |
|---|---|
| `ownershipScope(user)` / `scopeOf(req)` | the request's scope: `{ unrestricted, ownerId }` |
| `ownerClause(scope, params, {alias})` | `owner_user_id = $n`, or `''` for an admin |
| `purchaseOrderClause(…)` | a PO, via the quotation it fulfils or the project it sits under |
| `documentClause(…)` | a document, via whichever row references it |
| `scopedSources(scope, params)` | each table as a drop-in `FROM` replacement |
| `ownerForNewRecord(user)` | the owner a new record gets |
| `UNRESTRICTED` | the scope for system/background work |

Everything is parameterised; no id is ever interpolated into SQL.

`owner_user_id = $n` excludes unowned rows by itself — `NULL = anything` is
never true. That is the intended reading rather than an accident, which is
why there is no separate null case.

### Why `scopedSources` exists

The dashboard and the report builders are long multi-CTE queries whose
arithmetic is the business's own: Due now counts raised invoices, amounts
convert at the rate in force on the record's own date. Rewriting those to add
a predicate risks changing what they compute. Replacing the *table they read
from* cannot — every figure is still derived the same way, from fewer rows:

```sql
FROM v_quotations              -- admin: unchanged
FROM (SELECT * FROM v_quotations WHERE owner_user_id = $3) q   -- sales
```

For an admin each entry is the bare name, so the query that always ran is
literally the query that runs.

## What changed, surface by surface

| Surface | Change |
|---|---|
| CRUD list | predicate in SQL before `LIMIT`; the count uses it too |
| CRUD detail / PATCH / DELETE | one `scopedIdPredicate`, carried **into** the `UPDATE`/`DELETE` |
| CRUD create | owner from the session |
| `GET /api/export/:resource.{csv,xlsx}` | same predicate as the list |
| `GET /api/export/sales-report/*.csv`, `sales-report.pdf` | scope threaded into every builder |
| `GET /api/lookups` | projects, quotations, salespeople, sectors, POs, currencies scoped |
| `GET /api/dashboard/{overview,worklist,sales-report,revenue-report}` | scoped sources |
| `GET /api/companies/:id/full` | embedded enquiries/quotations/projects/POs scoped |
| `GET /api/projects/:id/full` | 404 unless the project is reachable |
| `GET /api/purchase-orders/:po/full` | derived from quotation or project |
| `POST /api/quotations/:id/convert` | reachable quotations only; project inherits the owner |
| `quoteWonEnquiry` | quotation inherits the enquiry's owner |
| `linkProjectQuotation` | reachable quotations only; ownership read, never written |
| `GET /api/documents/:id` | derived from the referencing record |
| Background jobs (`lib/reminders.js`) | **unchanged** — global, system semantics |
| `POST /api/import/*` | unchanged — the whole router is `requireAdmin` |
| `GET /api/activity` | unchanged — already admin-only |

No migration. `views.sql` gained `owner_user_id` on `v_quotations` and
`v_projects`, because the generic CRUD router reads those views and scoping
has to be a predicate in SQL rather than a filter applied after `LIMIT`. A
views rebuild is a normal checksum-driven step, not a schema migration;
`018` and `019` are untouched.

### TOCTOU

The predicate rides **inside** the `UPDATE` and `DELETE`, not in a `SELECT`
before them. Checking ownership in one statement and writing in the next is a
window, however small, in which a row can change hands. There is no window if
the write cannot match the row.

## New-record ownership

| who creates it | owner |
|---|---|
| database sales user | themselves |
| database admin | `NULL` |
| shared login | `NULL` |

Taken from the session, never from the body. `owner_user_id` is in no
resource's writable columns, so a client cannot propose one at all — the Zod
schema drops it and `pickWritable` would too. Tested: a sales user sending
another user's id still owns the record themselves.

An admin's record is unowned because guessing which salesperson they meant is
the mistake Phase 2B refused to make in bulk. An explicit assignment API is
Phase 3.

## Conversion

Responsibility follows the work down the pipeline, from `owner_user_id` and
never from the free-text `sales_person` beside it:

```
enquiry  --won-->  quotation   inherits the enquiry's owner
quotation --registered--> project   inherits the quotation's owner
```

An unowned source produces an unowned result — no owner is invented in
transit. An **admin** registering somebody's win does not become the owner;
the quotation's owner stays. Linking an existing project to a quotation reads
ownership and never writes it.

## One deliberate non-restriction, and two derived ones

**Companies stay global.** `companies` is master data — one spelling per
client, created by the link trigger the first time any record names a client.
A salesperson needs the whole list to file their own work against the right
client, and a client's *name* is not one salesperson's secret. The
records behind it are scoped; the client list is not. (Phase 2C brief §12:
"Company master information itself may remain readable".)

**Purchase orders, payment stages and PO service lines** carry no owner of
their own and take it from the record above them, declared as
`ownerScopedBy: 'purchase_order' | 'via_po'` in `resources.js`. Reads,
edits, creates and the workflow actions (splitting a PO into stages,
recording an invoice, recording a receipt, applying an onboarding template)
all check the parent. Creating one under a parent the caller cannot reach is
404. Deleting stays **403**, from Phase 1C's `adminOnlyDeletes`, which runs
before any ownership check — a role refusal, not an ownership one.

**Unattached documents are admin-only.** "No parent" means ownership is
unknown, and the rule for unknown ownership is admin-only — the same answer
an unassigned record gets. Treating it as public would make the window
between upload and save a way to read anybody's file by guessing a serial id.

Nothing needs that window: `POST /api/documents` returns the document's own
metadata, `RecordForm.attachDocuments` puts the returned id straight into the
record it saves in the same submit, and the only `GET` the app makes is
`api.documentUrl(current.id)` for a document already attached to a loaded
record. So this closes the gap at no cost to any working flow, and without
the uploader column a schema change would have needed.

## Background jobs

Untouched, by design. `lib/reminders.js` and the scheduled jobs process every
record: the payment reminders go to every client with an overdue invoice, not
to one salesperson's. Library functions default to `UNRESTRICTED` for exactly
this, and every route passes a real scope instead.

## Deferred

* admin ownership assignment / reassignment API
* handover and ownership history
* ownership UI (owner dropdown, "My records" filter, owner badges)
* the Activity screen
* KPI engine and dashboards
