# Issue #18 Phase 2A — ownership schema foundation

Branch `feature/issue-18-ownership-schema`, stacked on
`feature/issue-18-activity-log` (Phase 1.5), which is stacked on
`feature/issue-18-auth-hardening` (Phase 1C). Neither is on `main` yet.

## Why

Every sales record already names a salesperson — `sales_person`, free text,
filled in from the workbook and typed by hand since. That is enough for a
report, which can normalise `Ramesh` and `ramesh ` into one heading and
where a mistake costs a wrong row in a summary.

It cannot answer the question Phase 2 asks. "Show this salesperson only
their own records" needs a name that cannot be retyped, cannot be two
people, and cannot stop matching when a spelling drifts. That is a foreign
key, and `users` (015) now exists to point at.

So this phase adds the pointer **beside** the text, not instead of it. The
two coexist deliberately: `sales_person` keeps every historical report
producing the numbers it produced yesterday.

## The change

Migration `059_record_ownership.sql`, mirrored into `db/schema.sql`.

```
enquiries.owner_user_id   int NULL  → users(id) ON DELETE SET NULL
quotations.owner_user_id  int NULL  → users(id) ON DELETE SET NULL
projects.owner_user_id    int NULL  → users(id) ON DELETE SET NULL
```

One name across all three. It means *the database user currently
responsible for this sales record* — not its creator, not its last editor,
not the audit actor (that is `activity_log.actor_user_id`, Phase 1.5), and
not a history of assignment (Phase 3).

Untouched on purpose: `sales_person` / `sales_person_email` on all three,
`projects.project_manager`, and every related table — `purchase_orders`,
`payment_stages`, `travel_logs`, `employee_expense_claims`,
`travel_vendor_invoices`, `documents`, `companies`, `contacts`. Ownership of
those follows from the record they hang off, and deciding that now would be
guessing.

### Nullable, and left null

No backfill. The migration contains no `INSERT`, `UPDATE`, `DELETE`,
`TRUNCATE` or `COPY` — there is a test asserting that against the file
itself. Existing rows keep `owner_user_id = NULL`.

That is not laziness. There is no reliable way to turn the existing text
into a user: some rows name people who never had an account, some name
nobody, and a wrong owner is worse than a blank because a blank is visibly
unanswered while a wrong guess looks like an answer. Phase 2B decides the
rules with somebody who knows the business.

### ON DELETE SET NULL

`CASCADE` would mean deleting a leaver's account deletes their quotations,
enquiries and projects — the company's sales history removed as a side
effect of tidying up. `RESTRICT` is the opposite failure: nobody can ever be
deleted once they have owned anything. `SET NULL` keeps the record and
forgets only the pointer, leaving the row in exactly the state every row is
in today — unowned, and visibly so. It matches `activity_log.actor_user_id`
and the `company_id` / `contact_id` keys already on these three tables.

### Inactive users

No `CHECK` ties ownership to `users.active`. Somebody who has left still
owned what they owned; a constraint saying otherwise would make deactivating
a leaver fail against every record they ever touched. Whether an inactive
user may be given something **new** is an assignment rule, and belongs in
the application where it can explain itself. Phase 2C.

### Indexes

```
enquiries_owner_user_id_idx   ON enquiries  (owner_user_id)
quotations_owner_user_id_idx  ON quotations (owner_user_id)
projects_owner_user_id_idx    ON projects   (owner_user_id)
```

Two reasons, and the second applies today. Phase 2C will read
`WHERE owner_user_id = $me` on each of these lists. More immediately, the
foreign key itself needs it: Postgres must find the referencing rows to null
them when a user is deleted, and without an index on the referencing side
that is a sequential scan of all three tables on every account deletion.

Single-column only. A composite with status or date would be guessing at
Phase 2C's query shapes before they exist, and an unused index still costs
maintenance on every insert and update.

### Why the foreign keys are declared apart in schema.sql

`schema.sql` creates `quotations`, `projects` and `enquiries` well before
`users`. An inline `REFERENCES users(id)` on those tables would name a table
that does not exist yet. So the columns are declared bare with their tables
and the three constraints are added in one block after `users`. The
constraint names are the ones Postgres generates for an inline reference
(`<table>_owner_user_id_fkey`), so a database upgraded through the migration
and one built from `schema.sql` carry an identical catalogue signature —
which the CI checker verifies.

## What did NOT change

**No application code at all.** The whole phase is the migration, the schema
mirror, tests and this document.

That is not an oversight — the generic CRUD layer already refuses the column
twice over, so nothing needed tightening:

1. `def.schema` is a non-strict Zod object, so `owner_user_id` in a request
   body is dropped at parse.
2. `pickWritable(def, …)` copies only keys listed in `def.columns`, and
   `owner_user_id` is not in any of the three.

`buildWhere` and `buildOrder` allow only `columns ∪ search ∪ filters ∪ id`,
so `?owner_user_id=` and `?sort=owner_user_id` are ignored rather than
applied. Tests cover all of it: a client — admin included — cannot set
ownership on create or change it on update.

### Read exposure, and one asymmetry worth knowing

| resource | reads from | returns `owner_user_id`? |
|---|---|---|
| `enquiries` | the table (`view: null`) | **yes** — `SELECT *` |
| `quotations` | `v_quotations` | no — explicit column list |
| `projects` | `v_projects` | no — explicit column list |

Also `GET /api/companies/:id/full` returns it in its `enquiries` array, for
the same `SELECT *` reason.

The views were deliberately left alone. Nothing breaks without the column,
adding it would change report and export output for no present gain, and
Phase 2C will need to revisit these projections anyway. Documented here so
the asymmetry is a known state rather than a surprise.

The value returned is always `null` today, and reading it leaks nothing:
it is an integer that only an admin-visible `users` list can resolve to a
person.

## Conversion flows

Unchanged. `quoteWonEnquiry` (a won enquiry becoming a quotation) inserts an
explicit column list that does not include `owner_user_id`, so ownership is
not propagated. `linkProjectQuotation` only writes `project_id` and
`po_received`. `linkPurchaseOrder` is untouched.

No propagation was added, per the phase brief. Nothing can silently drop an
owner, because no API path can set one — the only way to set ownership today
is a direct database write, which is what Phase 2B's backfill will be.

## Activity log

Untouched. No assignment event is logged, because no assignment workflow
exists to log. The migration writes no rows and therefore logs nothing.
Reassignment events are Phase 3.

## Deferred

* **Phase 2B** — ownership backfill rules, and the backfill itself
* **Phase 2C** — row-level filtering across lists, details, exports,
  lookups, reports, documents and dashboards, landed *in one piece*; and the
  assignment API, including whether an inactive user may receive new work
* **Phase 3** — reassignment and handover history
* ownership UI — salesperson dropdown, owner badge, filters
* KPI logic and dashboards
