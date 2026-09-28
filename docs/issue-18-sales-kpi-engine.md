# Issue #18 Phase 4 — Sales KPI Backend Engine and Annual Targets

Branch `feature/issue-18-sales-kpi-engine`, stacked on `feature/issue-18-assignment-history` (Phase 3) $\to$ `feature/issue-18-row-scoping` (2C) $\to$ `ownership-backfill` (2B) $\to$ `ownership-schema` (2A) $\to$ `activity-log` (1.5) $\to$ `auth-hardening` (1C).

Parent commit: `54cb4f3` (`feat: add ownership assignment and handover history`).

---

## 1. Overview

Phase 4 delivers the backend foundation for individual sales KPI reporting, administrative team-wide sales reporting, annual sales target management, and reliable sales attribution across historical cohorts.

A critical principle of Phase 4 is the architectural separation between:
1. **Current Workload & Active Pipeline**: Who is currently responsible for progressing or delivering an active deal (`owner_user_id`).
2. **Historical Creation & Cohort Performance**: Which salesperson originally originated the business opportunity (`originating_user_id`, `originating_user_snapshot_id`, `originating_user_name`).
3. **Financial Attribution & Honest Boundaries**: Strict distinction between authoritative financial metrics (such as order intake derived from won deals) and structurally unavailable metrics (such as annual cash collections).

Backend only. React dashboards, visual charts, and target management forms are deferred to future frontend phases.

---

## 2. Originating-Salesperson Attribution Rules

### 2.1 Schema Additions (`062_sales_targets_and_origin.sql`)
Three immutable attribution fields are added to `enquiries`, `quotations`, and `projects`:
* `originating_user_id` (`integer REFERENCES users(id) ON DELETE SET NULL`): Active foreign key to the user account.
* `originating_user_snapshot_id` (`integer`): Durable user ID snapshot preserved even if the user account is later deleted or deactivated.
* `originating_user_name` (`text`): Durable display name snapshot preserved even if the user account is renamed or deleted.

### 2.2 Capture and Propagation Rules
1. **Sales-Created Records**:
   * When an authenticated database sales user creates an enquiry, quotation, or project via `POST /api/:resource`, `crud.js` sets:
     * `owner_user_id = req.user.id`
     * `originating_user_id = req.user.id`
     * `originating_user_snapshot_id = req.user.id`
     * `originating_user_name = req.user.name`
2. **Admin-Created Records**:
   * When an administrator (database admin or shared admin) creates a record, `owner_user_id` remains `NULL` and `originating_user_*` fields remain `NULL`. No fictitious sales origin is manufactured.
3. **Enquiry Conversion (`quoteWonEnquiry`)**:
   * When an enquiry is marked `Won - Quotation Sent`, the created quotation inherits `owner_user_id` from the enquiry (Phase 2C), and preserves `originating_user_id`, `originating_user_snapshot_id`, and `originating_user_name` from the enquiry.
   * If the enquiry was unowned/unattributed, the quotation remains unattributed.
4. **Quotation Conversion (`POST /api/quotations/:id/convert`)**:
   * When converting a won quotation to a *new* project, the new project inherits `owner_user_id` from the quotation and preserves verified `originating_user_*` fields from the quotation.
   * When linking a won quotation to an *existing* project (`linkProjectQuotation`), the project's existing origin and owner are untouched.
5. **Administrative Assignment & Reassignment**:
   * Initial assignment, reassignment, and unassignment (`PATCH /api/:resource/:id/owner`) mutate `owner_user_id` and record an `ownership_history` row.
   * Assignment actions **never** modify or overwrite `originating_user_*` fields.
6. **Protection Against Client Modification**:
   * Originating fields are not in the writable `columns` or `schema` of any resource in `resources.js`.
   * Standard REST `PATCH /api/:resource/:id` requests cannot alter originating fields.
7. **Account Deactivation & Deletion**:
   * Deactivated sales accounts retain full historical attribution.
   * If a user account is deleted, foreign keys `SET NULL`, but `originating_user_snapshot_id` and `originating_user_name` retain attribution in team aggregation and historical records.

---

## 3. KPI Definitions and Categories

All reporting is scoped by calendar year using half-open date intervals in `Asia/Kolkata`:
$$\text{from} \le \text{date} < \text{to}$$
$$\text{from} = \text{year-01-01},\quad \text{to} = (\text{year}+1)\text{-01-01}$$

### Category A: Current Workload and Pipeline (Current Owner Basis)
Operates on `owner_user_id = $userId`. Reflects current operational responsibilities:
* `open_enquiries`: Count of enquiries where `owner_user_id = $userId` and `status = 'In Progress'`.
* `open_quotations`: Count of quotations where `owner_user_id = $userId` and `status NOT IN ('Won - PO Received', 'Lost')`.
* `pipeline_value_inr`: Sum of open quotation values converted to INR via historical dated exchange rates (`v_exchange_rates`).
* `assigned_projects`: Total, active (`percent_complete < 1`), and completed (`percent_complete >= 1`) projects where `owner_user_id = $userId`.
* `financial_operations_reminders`: Count of overdue payment stages and stages ready to invoice under purchase orders linked to projects or quotations currently owned by the user.

### Category B: Historical Creation and Cohort Performance (Verified Origin Basis)
Operates on `COALESCE(originating_user_id, originating_user_snapshot_id) = $userId`:
* `enquiries_created`: Enquiries with `enquiry_date` in the calendar year originated by the salesperson.
* `enquiries_quoted`: Enquiries created in the calendar year that transitioned to `Won - Quotation Sent`.
* `enquiry_quote_rate_percentage`: $\frac{\text{enquiries\_quoted}}{\text{enquiries\_created}} \times 100$. Returns `null` if total enquiries is 0.
* `quotations_created`: Quotations with `quotation_date` in the calendar year originated by the salesperson.
* `quotations_cohort_won`: Quotations dated in the calendar year originated by the salesperson currently marked `Won - PO Received`.
* `quotations_cohort_lost`: Quotations dated in the calendar year originated by the salesperson currently marked `Lost`.
* `cohort_win_rate_percentage`: $\frac{\text{quotations\_cohort\_won}}{\text{quotations\_cohort\_won} + \text{quotations\_cohort\_lost}} \times 100$. Returns `null` if closed count is 0.

### Category C: Financial Performance
* `order_intake_inr`: Total value of won quotations dated in the calendar year originated by the salesperson, converted to INR via dated FX rates. Deals in foreign currencies without a matching rate are flagged in `order_intake_unconverted_deals`.
* `collections`: **Explicitly Unavailable**. The application returns:
  ```json
  {
    "status": "unavailable",
    "value": null,
    "reason": "Accurate annual collections require receipt-event data. payment_stages stores cumulative balances with only the latest receipt date and cannot be partitioned across calendar years reliably."
  }
  ```

### Category D: CRM Follow-Ups
* `crm_follow_ups`: **Explicitly Unavailable**. Returns `status: "unavailable"` and `value: null` because Cetizion Tracker does not possess a sales CRM follow-up task table.

### Category E: Admin Team-Wide Reporting
Aggregates performance across all salespeople and maintains strict separation between attributed and unattributed business:
* `team_pipeline_summary`: Separates `assigned` vs `unassigned` open quotations and pipeline value.
* `team_order_intake_summary`: Separates `attributed` vs `unattributed` won quotation counts and intake value. Unattributed intake is never artificially credited to any sales rep.
* `origin_conflict_deals`: Flags purchase orders linked to both a project and a quotation where the project origin differs from the quotation origin. Attribution is left unresolved (`unresolved_conflict`) rather than guessing.
* `salespeople`: Array of individual salesperson KPI reports.

---

## 4. Annual Sales Targets

### 4.1 Schema (`sales_targets` Table)
```sql
CREATE TABLE sales_targets (
  id                          serial PRIMARY KEY,
  salesperson_user_id         integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  calendar_year               integer NOT NULL CHECK (calendar_year BETWEEN 2000 AND 2100),
  metric                      text NOT NULL CHECK (btrim(metric) <> ''),
  target_value                numeric(16,2) NOT NULL CHECK (target_value >= 0),
  unit                        text NOT NULL CHECK (unit IN ('count', 'currency', 'percentage')),
  currency                    text CONSTRAINT sales_targets_currency_not_blank
                                CHECK (currency IS NULL OR btrim(currency) <> ''),
  created_by_user_id          integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id          integer REFERENCES users(id) ON DELETE SET NULL,
  actor_type                  text NOT NULL DEFAULT 'user'
                                CHECK (actor_type IN ('user', 'shared_admin', 'system')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sales_targets_unit_currency_check CHECK (
    (unit = 'currency' AND currency IS NOT NULL) OR
    (unit IN ('count', 'percentage') AND currency IS NULL)
  ),
  CONSTRAINT sales_targets_count_integer_check CHECK (
    unit <> 'count' OR (target_value = round(target_value))
  ),
  CONSTRAINT sales_targets_percentage_check CHECK (
    unit <> 'percentage' OR (target_value >= 0 AND target_value <= 100)
  ),
  CONSTRAINT sales_targets_actor_needs_user CHECK (
    created_by_user_id IS NULL OR actor_type = 'user'
  )
);

CREATE UNIQUE INDEX sales_targets_unique_idx
  ON sales_targets (salesperson_user_id, calendar_year, metric, COALESCE(currency, ''));
```

### 4.2 Validation Rules
* `calendar_year`: Integer between 2000 and 2100.
* `unit`: Must be one of `count`, `currency`, `percentage`.
* `target_value`: Non-negative numeric. For `count`, must be a whole integer. For `percentage`, must be between 0 and 100.
* `currency`: Required for `currency` targets; must be `NULL` for `count` and `percentage` targets.
* Target salesperson must exist and have `role = 'sales'`.
* Unique index prevents duplicates even when currency is `NULL`.
* Target salesperson reference uses `ON DELETE RESTRICT` to prevent accidental loss of historical target definitions when deleting user accounts.

### 4.3 Atomic Audit Logging
Every creation or modification of a target logs an event in `activity_log` inside the same transaction:
* Action: `target.created` or `target.updated`.
* Entity Type: `sales_targets`.
* Metadata: Salesperson ID, name, calendar year, metric, previous value, new value, unit, and currency.

---

## 5. API Endpoints and Authorization

All `/api/kpis` endpoints require authentication.

| Endpoint | Method | Role Allowed | Description |
| :--- | :--- | :--- | :--- |
| `/api/kpis/me?year=YYYY` | `GET` | Database `sales` only | Returns personal KPI report and target progress. Shared admin receives `400`. |
| `/api/kpis/team?year=YYYY` | `GET` | Database `admin`, Shared `admin` | Returns team-wide aggregated KPI report, unassigned pipeline, unattributed intake, PO origin conflicts, and individual rep reports. |
| `/api/kpis/users/:userId?year=YYYY` | `GET` | Admins, or Sales requesting own `userId` | Returns individual salesperson KPI report. Sales requesting another rep receives `403`. |
| `/api/kpis/targets?year=YYYY&salesperson_user_id=ID` | `GET` | Admins, or Sales requesting own targets | Lists targets. Sales reps requesting another rep's targets receive `403`. |
| `/api/kpis/users/:userId/targets/:metric` | `PUT` | Database `admin`, Shared `admin` | Creates or updates an annual sales target. Sales reps receive `403`. |

---

## 6. Financial Limitation: Collections Reporting

### Structural Limitation of `payment_stages`
In Cetizion Tracker, `payment_stages.amount_received` stores a single cumulative balance, and `payment_stages.payment_received_date` records only the single most recent receipt date.

When a client makes multiple payments across different calendar years (e.g. ₹40,000 in December 2025 and ₹60,000 in January 2026), the database stores `amount_received = 100000` and `payment_received_date = '2026-01-15'`. Grouping by `payment_received_date` would incorrectly attribute the entire ₹100,000 to 2026.

### Architectural Policy
1. Phase 4 **does not** compute cumulative stage receipts grouped by payment date as annual collections.
2. Collections metrics in salesperson KPIs and target progress are explicitly set to `null` with `status: "unavailable"` and a descriptive explanation.
3. No payment event ledger is fabricated in this phase.

---

## 7. Migration Verification

The migration content, originally `021_sales_targets_and_origin.sql` and now renumbered to `062_sales_targets_and_origin.sql` for integration with current `main`, was verified against parent commit `54cb4f3` (`origin/feature/issue-18-assignment-history`) using the official CI migration checker:

```bash
TEST_DATABASE_URL="postgres://postgres:password@localhost:5432/postgres" \
  scripts/ci/check-migrations.sh origin/feature/issue-18-assignment-history
```

Results:
* Clean upgrade of deployed schema with seed data.
* Upgrade verification originally applied `021_sales_targets_and_origin.sql` and `views.sql`; the migration is now numbered `062_sales_targets_and_origin.sql`.
* Second upgrade verified database is fully up to date.
* Fresh schema (`schema.sql`) matched upgraded schema byte-for-byte with 0 diff lines.

---

## 8. Automated Test Suite

Four test suites verify Phase 4:
1. `server/test/salesTargets.test.js`: Annual targets CRUD, count integer constraints, monetary currency constraints, uniqueness with `NULL` currency, audit logging, role authorization, and `ON DELETE RESTRICT`.
2. `server/test/salesKpis.test.js`: Origin capture at creation, initial assignment safety (does not set origin), reassignment safety (preserves historical origin while shifting current owner), date interval boundary checks, zero-denominator win rate safety, origin snapshot durability after user deletion, PO origin conflict detection, and unavailable collections reporting.
3. `server/test/kpiAuthorization.test.js`: Unauthenticated 401 checks, sales rep isolation (cannot access other reps or team), admin access, direct project origin capture, quotation-to-project conversion, enquiry-to-quotation conversion, and immutability against ordinary CRUD patch.
4. `server/test/kpiAuthorizationShared.test.js`: Shared admin authorization parity (400 on `/me`, full access to `/team`, individual user reports, and target management with audit trail).
