# Issue #18 Phase 3 — Ownership Assignment, Reassignment and Handover History

Branch `feature/issue-18-assignment-history`, stacked on `feature/issue-18-row-scoping` (2C) $\to$ `ownership-backfill` (2B) $\to$ `ownership-schema` (2A) $\to$ `activity-log` (1.5) $\to$ `auth-hardening` (1C).

## Overview

Phase 3 implements an explicit administrative ownership management and handover tracking mechanism for Cetizion Tracker's ownership-scoped resources:
* `enquiries`
* `quotations`
* `projects`

Prior to this phase, records were either automatically owned by their sales creator or left unassigned when created by an administrator. Phase 3 provides the backend foundation for assigning unassigned records, reassigning records between sales representatives, explicitly unassigning records back to the unassigned pool, and recording a durable, tamper-evident audit history of every transition.

---

## 1. Assignment API

Two dedicated admin-only endpoints are exposed for each of the three entities:

### 1.1 Mutation: `PATCH /api/:resource/:id/owner`

* `:resource`: `enquiries` | `quotations` | `projects`
* `:id`: Primary key integer (e.g. `12`) or business natural key (e.g. `CTZ/ENQ/2026/001`, `CTZ/QT/2026/001`, `PRJ-2026-001`). URL encoded if containing slashes.

#### Request Headers
* `Cookie`: valid session cookie for an administrator.

#### Request Body
```json
{
  "new_owner_user_id": 12,
  "expected_owner_user_id": 7,
  "reason": "Sales territory handover"
}
```

* Initial assignment: `expected_owner_user_id` is explicitly `null`.
* Reassignment: `expected_owner_user_id` is the current owner ID; `new_owner_user_id` is the target sales user ID.
* Unassignment: `new_owner_user_id` is `null`.

#### Response (`200 OK`)
```json
{
  "data": {
    "id": 123,
    "entity_type": "quotations",
    "entity_id": 123,
    "natural_key": "CTZ/QT/2026/001",
    "previous_owner_user_id": 7,
    "new_owner_user_id": 12,
    "ownership_history_id": 45,
    "no_op": false,
    "updated_at": "2026-09-21T11:00:00.000Z"
  }
}
```

### 1.2 Timeline: `GET /api/:resource/:id/ownership-history`

Returns the handover history for the given business record, newest first.

#### Query Parameters
* `limit`: Page size (integer between `1` and `500`, default `50`).
* `before`: Cursor ID for backward pagination (`id < before`).

#### Response (`200 OK`)
```json
{
  "data": [
    {
      "id": 45,
      "entity_type": "quotations",
      "entity_id": 123,
      "previous_owner": {
        "id": 7,
        "name": "Sam Sales",
        "email": "sam@example.com",
        "active": true,
        "deleted": false
      },
      "new_owner": {
        "id": 12,
        "name": "Bea Sales",
        "email": "bea@example.com",
        "active": true,
        "deleted": false
      },
      "changed_by": {
        "id": 1,
        "name": "Alice Admin",
        "actor_type": "user",
        "deleted": false
      },
      "reason": "Sales territory handover",
      "created_at": "2026-09-21T11:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50
}
```

---

## 2. Authorization Rules

Only administrators may assign, reassign, unassign, or view ownership history:

| Caller Role / Authority | `PATCH .../owner` | `GET .../ownership-history` |
|---|---|---|
| Database Administrator (`role = 'admin'`) | **200 Authorized** | **200 Authorized** |
| Legacy Shared Admin (`mode = 'shared'`) | **200 Authorized** | **200 Authorized** |
| Database Sales User (`role = 'sales'`) | **403 Forbidden** | **403 Forbidden** |
| Unauthenticated Caller | **401 Unauthorized** | **401 Unauthorized** |

Sales users cannot assign records to themselves or others, claim unassigned records, or read the history log. Ordinary CRUD endpoints remain strictly guarded: `owner_user_id` is excluded from client-writable columns and ignored on generic PATCH/PUT requests.

---

## 3. Target User Eligibility

When `new_owner_user_id` is not null:
1. The target user must exist in the `users` table.
2. The target user must be active (`active = true`).
3. The target user must have the sales role (`role = 'sales'`).

Refusals:
* Target user nonexistent $\to$ **422 Unprocessable Entity**.
* Target user inactive $\to$ **422 Unprocessable Entity**.
* Attribution-only user (cannot sign in) $\to$ **422 Unprocessable Entity**.
* Admin-role user proposed as owner $\to$ **422 Unprocessable Entity**.

Existing records owned by inactive or historical users remain valid. Administrators may freely reassign records away from inactive users.

---

## 4. Concurrency Protection & Transaction Safety

Ownership mutations execute within a PostgreSQL transaction:

```sql
BEGIN;

-- 1. Lock the business record
SELECT * FROM quotations WHERE id = $1 FOR UPDATE;

-- 2. Concurrency check
-- Compare expected_owner_user_id with locked record's owner_user_id.
-- If mismatched, abort with 409 Conflict.

-- 3. Check for genuine no-op
-- If new_owner_user_id === current owner, return 200 without inserting history or activity.

-- 4. Lock target user row to guard against concurrent deactivation
SELECT id, name, email, role, active FROM users WHERE id = $targetId FOR UPDATE;
-- Validate active = true and role = 'sales'

-- 5. Update record owner
UPDATE quotations SET owner_user_id = $newOwnerId, updated_at = now() WHERE id = $recordId;

-- 6. Insert history record with immutable attribution snapshots
INSERT INTO ownership_history (...) VALUES (...);

-- 7. Insert activity log event
INSERT INTO activity_log (...) VALUES (...);

COMMIT;
```

### 4.1 Stale Expected Owner Detection
The mandatory `expected_owner_user_id` field prevents lost updates when two administrators attempt concurrent reassignment. If Admin A and Admin B both load the page seeing Owner X:
* Admin A reassigns to Owner Y (succeeds).
* Admin B attempts reassignment expecting Owner X (fails immediately with **409 Conflict**).

### 4.2 Protection Against Concurrent Deactivation
The target user is locked with `FOR UPDATE` in `users`. If another administrator is currently deactivating the user via `updateUser({ active: false })`, the assignment transaction waits until deactivation commits, reads the updated `active = false` state, and cleanly rejects the assignment with **422 Unprocessable Entity**.

### 4.3 Expected Owner Validation Precedes No-Op
`expected_owner_user_id` is checked before evaluating whether `new_owner_user_id === current_owner_user_id`. A request proposing the current owner with a stale expected owner returns **409 Conflict**, not a silent no-op.

---

## 5. Reason Policy

All administrative ownership mutations require a meaningful, non-empty business explanation:
* Required for initial assignment, reassignment, and unassignment.
* Validated with `.trim().min(1).max(1000)`.
* Blank, empty, or whitespace-only strings are rejected with **422 Unprocessable Entity**.

---

## 6. Ownership History Schema & Migration 020

Defined in `migrations/061_ownership_history.sql` and mirrored in `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS ownership_history (
  id                          bigserial PRIMARY KEY,
  entity_type                 text NOT NULL
                                CHECK (entity_type IN ('enquiries', 'quotations', 'projects')),
  entity_id                   integer NOT NULL,
  previous_owner_user_id      integer REFERENCES users(id) ON DELETE SET NULL,
  previous_owner_snapshot_id  integer,
  previous_owner_name         text,
  new_owner_user_id           integer REFERENCES users(id) ON DELETE SET NULL,
  new_owner_snapshot_id       integer,
  new_owner_name              text,
  changed_by_user_id          integer REFERENCES users(id) ON DELETE SET NULL,
  changed_by_snapshot_id      integer,
  changed_by_name             text,
  actor_type                  text NOT NULL
                                CHECK (actor_type IN ('user', 'shared_admin', 'system')),
  reason                      text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ownership_history_reason_not_blank      CHECK (btrim(reason) <> ''),
  CONSTRAINT ownership_history_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  CONSTRAINT ownership_history_actor_id_needs_user   CHECK (changed_by_user_id IS NULL OR actor_type = 'user')
);

CREATE INDEX IF NOT EXISTS ownership_history_entity_idx
  ON ownership_history (entity_type, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS ownership_history_new_owner_idx
  ON ownership_history (new_owner_user_id, id DESC);
CREATE INDEX IF NOT EXISTS ownership_history_prev_owner_idx
  ON ownership_history (previous_owner_user_id, id DESC);
```

### Attribution Survival Across User Deletion
Foreign keys to `users` use `ON DELETE SET NULL` so deleting a user does not cascade-delete history. To prevent attribution erasure, immutable snapshots (`previous_owner_snapshot_id`, `previous_owner_name`, `new_owner_snapshot_id`, `new_owner_name`, `changed_by_snapshot_id`, `changed_by_name`) are captured at insertion time. Even if an account is hard-deleted from `users`, historical entries retain the original user ID and display name with `deleted: true`.

---

## 7. Activity Log Integration

Every successful ownership change emits one of three actions:
* `ownership.assigned`: Transition from `NULL` to a sales representative.
* `ownership.reassigned`: Transition from one sales representative to another.
* `ownership.unassigned`: Transition from a sales representative to `NULL`.

Events include entity type, entity ID, previous owner ID, new owner ID, history entry ID, and the stated reason in `metadata`.

---

## 8. Strict No-Cascade Invariant

Ownership assignment operates strictly on the targeted record:
* Reassigning an enquiry **never** reassigns its linked quotation or project.
* Reassigning a quotation **never** reassigns its parent enquiry or linked project.
* Reassigning a project **never** reassigns linked quotations or purchase orders.

Responsibility propagates downstream *only* when new records are created during conversion (Phase 2C). Once created, existing downstream records have independent lifecycles.

---

## 9. Immediate Visibility Transitions

After reassignment from Sales A to Sales B:
1. **Detail endpoints**: `GET /api/quotations/:id` immediately returns **404** for Sales A and **200** for Sales B.
2. **Lists and search**: The record immediately vanishes from Sales A's list and appears in Sales B's list.
3. **Parent-derived records**: Purchase orders and payment stages linked to the quotation immediately transfer visibility from Sales A to Sales B.
4. **Documents**: Attached files immediately become inaccessible to Sales A and accessible to Sales B.

---

## 10. Operational Limitations & Deferred Scope

* **No Frontend UI**: Controls, dropdowns, and timeline views are deferred to a subsequent phase.
* **No Bulk Reassignment**: Administrative endpoints accept single-record mutations.
* **No Automatic Deactivation Cascades**: Deactivating a user leaves their existing records assigned to them until an administrator explicitly reassigns them.
* **No Sales Targets / KPIs**: Quota computation and performance dashboards are outside Phase 3 scope.
