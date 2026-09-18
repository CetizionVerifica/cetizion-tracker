# Issue #18 Phase 1.5 — activity / audit log foundation

Branch `feature/issue-18-activity-log`, stacked on
`feature/issue-18-auth-hardening` (Phase 1C), which is not yet on `main`.

## Why

Until now the tracker recorded things but not acts. The `users` table says
what an account looks like now; who switched it off, and when, was nowhere.
A company merge rewrites the client name on every record of two companies
and deletes one of them, with no undo and nothing saying who asked for it.
A test email sends real mail from the tracker's mailbox to an address the
caller chose.

This phase adds one durable, append-only record of acts, and starts writing
to it from the handful of places where the absence was most obviously
wrong. It is the foundation the later work reads: admin auditing now, and
salesperson timelines, ownership and reassignment history, and KPI
drill-downs when Phase 2 gives records an owner.

## The table

`activity_log`, migration `017_activity_log.sql`, mirrored in
`db/schema.sql`.

| column | | |
|---|---|---|
| `id` | `bigserial` | primary key; also the paging cursor |
| `actor_user_id` | `integer NULL` | → `users(id)` `ON DELETE SET NULL` |
| `actor_type` | `text NOT NULL` | `user` \| `shared_admin` \| `system` |
| `action` | `text NOT NULL` | stable machine key, e.g. `user.deactivated` |
| `entity_type` | `text NOT NULL` | `user`, `company`, `job`, `email` |
| `entity_id` | `text NULL` | text, because some things are named not numbered |
| `metadata` | `jsonb NOT NULL DEFAULT '{}'` | non-secret context only |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | server-generated |

There is no `updated_at` and no trigger: a row is never updated.

Constraints: `action`, `entity_type` and (when present) `entity_id` may not
be blank; `actor_type` is held to the three values above; `metadata` must be
a JSON object; and `actor_user_id` may only be set when `actor_type` is
`user`. A row whose actor has since been deleted keeps `actor_type = 'user'`
and loses the id — `SET NULL`, deliberately not `CASCADE`, because deleting
an account is the one deletion an audit trail exists to survive.

Indexes: the primary key already serves the default `ORDER BY id DESC` with
an `id < cursor` page, so there is no separate `created_at` index. Three
more back the three supported filters, each carrying `id DESC` so one index
answers the filter and the paging together: `(actor_user_id, id DESC)`,
`(action, id DESC)`, `(entity_type, entity_id, id DESC)`.

## Actors

| request | `actor_user_id` | `actor_type` |
|---|---|---|
| database mode | the account's own id | `user` |
| shared mode (`AUTH_MODE=shared`) | `NULL` | `shared_admin` |
| background / script | `NULL` | `system` |

No row is invented for the shared admin. `AUTH_USERNAME` is a name in the
environment, not a person, and writing it into `actor_user_id` would either
need a fake account — which the Users screen would then list — or would put
a number there pointing at whoever happens to hold that id. The name is
carried in `metadata.actor_name` instead, where it reads as a label. That
matches what the tracker already does: `email_log.sent_by` and
`job_runs.started_by` have recorded the shared username as text since #21.

`actorFrom()` throws on an unrecognised session rather than guessing. Every
audited route is behind `requireAuth`, so that is a bug, and the safe way
for a bug to surface on a security path is a failed request.

## Events written in this phase

```
user.created          user.updated          user.password_reset
user.deactivated      user.reactivated
company.merged
job.run
email.test_sent
```

An account edit produces exactly one row. Switching `active` gets the
specific name (`user.deactivated` / `user.reactivated`) and no second
`user.updated` beside it; `metadata.changed_fields` still lists everything
that moved.

Nothing else is audited yet, on purpose. Enquiries, quotations, projects,
travel logs, expense claims, vendor invoices and payment stages are left
alone until Phase 2 gives records an owner, because "who changed this" is
only half an answer while "whose is it" has none.

## Transaction behaviour

| act | atomic with its audit row? |
|---|---|
| `user.created` | yes — same transaction as the insert |
| `user.updated` / `user.deactivated` / `user.reactivated` | yes — same transaction as the update |
| `user.password_reset` | yes — same transaction as the hash and the session revocation |
| `company.merged` | yes — same transaction as the merge |
| `job.run` | no |
| `email.test_sent` | no |

The first four run through `lib/users.js` and `routes/companies.js`, which
pass the transaction's own client into `logActivity`. If the audit write
fails, the change rolls back with it. A refused change — the last admin
demoting themselves, a duplicate email — leaves no activity row at all.

The last two cannot be atomic: one sends mail over SMTP and the other runs a
job that emails clients, and neither is something a database transaction can
take back. Their audit row is written after the act, naming the `email_log`
or `job_runs` row that records the act itself. If that write fails the
request fails with it and the server logs it — the failure is loud, and the
operation is still findable in its own table. What does not happen is the
failure being swallowed.

## Read API

```
GET /api/activity
```

Admin only, read only. Unauthenticated → 401, sales → 403.

* Paging: `limit` (default 50, max 200) and `before_id`, an exclusive
  cursor. The response carries `next_before_id`, or `null` on the last page.
  There is no unbounded form.
* Filters: `actor_user_id`, `actor_type`, `action`, `entity_type`,
  `entity_id`. All parameterised. A value the server cannot make sense of —
  or a parameter given twice — is a 422 with the field named, never silently
  ignored: a dropped filter on an audit log reads as "nothing happened".
* Ordering: newest first, by `id` rather than `created_at`, so a cursor can
  never straddle two rows written in the same millisecond.
* Shape: `{ id, actor: { id, name } | null, actor_type, action, entity_type,
  entity_id, metadata, created_at }`. The actor is a `LEFT JOIN` on `users`
  selecting `name` only — never `email`, `role`, `password_hash` or
  `session_version` — so a row whose actor has been deleted still comes
  back, with `actor: null` and `actor_type` still saying it was a person.

## Immutability

There is no `POST`, `PATCH` or `DELETE` under `/api/activity`, and
`activity_log` is deliberately absent from the resource registry in
`lib/resources.js` that generates those routes for other tables. Rows are
written only from inside the operations they describe.

This is an application rule, not a database trigger. A trigger refusing
`UPDATE` and `DELETE` would also refuse the retention policy this phase
explicitly does not write, and the gap it would close — somebody with direct
database access editing history — is not one the application layer was ever
guarding.

## Secrets

Never recorded: passwords, password hashes, session secrets, cookies,
tokens, environment secrets. `user.password_reset` records that a reset
happened and that the account's sessions ended, and nothing of the password.
`job.run` records the job's name and its `job_runs` id, not the run's
result, which can name every client it emailed. `email.test_sent` records
the destination *domain* and the delivery mode; the address, subject and
body stay in `email_log`, where they already are, rather than being copied
into a table retained indefinitely.

`lib/activity.js` also drops metadata keys whose names suggest a secret,
recursively, and caps the document at 8 KB. That is a backstop against a
future call site spreading a request body into metadata — not a licence to
pass secrets.

## Retention

Activity rows are kept indefinitely. No purge job, no retention window, no
automatic deletion. When there is a policy it will need to delete rows,
which is one reason the append-only rule lives in the application rather
than in a trigger.

## Migration validation, and the comparison base

This branch is stacked on Phase 1C, whose migration `016_session_version.sql`
is not on `main`. So a database built from `main`'s `schema.sql` is **not**
the database 017 will be applied to, and validating against it would be
validating against a schema that no deployment will ever be in.

`test/activityLogMigration.test.js` avoids the question rather than picking
a branch. It states the one thing 017 depends on — a `users` table with an
integer primary key — applies the migration to that, and compares the
resulting `activity_log` (columns, constraints, indexes, read back from the
catalogue) with the same table in a database built from the current
`db/schema.sql`. The upgrade path and the rebuild path must agree; which
branch is checked out does not come into it.

## Deferred

Not in this phase, and named here so nobody looks for them:

* ownership (`owner_id` / `assigned_to` / `salesperson_id`) — Phase 2
* row-level sales scoping — Phase 2
* broad CRUD history across enquiries, quotations, projects, travel,
  expenses, vendor invoices and payment stages
* the admin Activity screen — backend only for now
* a retention or purge policy
* KPI logic and dashboards
* production auth cutover
