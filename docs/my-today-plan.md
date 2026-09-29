# My Today: implementation plan

A **My Today** button in the sidebar that opens one sales person's own list for
the day. It has two sections:

- **Due today**: what that person has to do today.
- **Late**: what is more than 2 working days overdue.

The list is built from four kinds of work the tracker already records:

- tasks
- enquiry follow-ups
- invoices ready to raise
- payments more than 7 days past due that need a chase

Written against commit `25536f5`; reviewed against `077710a`.

## Why the existing screens are not this

| Screen | What it shows | Why it is not My Today |
|---|---|---|
| **Today** (`/`, `web/src/pages/Today.jsx`) | Overdue money, invoices to raise, won deals with no project, travel bills, claims | Company-wide: every user sees every client. No tasks and no follow-ups. |
| **Action list** (`/worklist`, `web/src/pages/Worklist.jsx`) | The same data as Today, in tabs | Same data, same scope. |
| **Tasks** (`/tasks`, `web/src/pages/Tasks.jsx`) | Open tasks, filterable by person | Tasks only. Works out "today" in the browser, not in business time. |
| **Notification bell** and 08:30 digest (`server/src/lib/notify.js:55-72`) | Tasks due or overdue, and enquiry follow-ups, addressed per person | A feed of alerts, not a worklist. Invoices and payments go to everyone. Nothing leaves when it is done. |

Both Today and the Action list read `GET /api/dashboard/worklist`
(`server/src/routes/dashboard.js:106-175`), which applies no per-person filter.
My Today is the first screen scoped to one person's own work. Today stays as
the company-wide view.

## What goes on the list

Every item has a **due date**. The same rule then sorts every kind into Due
today or Late (next section).

| Kind | Source | It is mine when | Due date | It leaves the list when |
|---|---|---|---|---|
| **Task** | `tasks` where `status <> 'done'` | `assignee` is me, or it has no assignee and sits on a record of mine | `due_at` | It is ticked done |
| **Follow-up** | `enquiries` in New, Contacted, Qualified or Nurture | `sales_person` is me | `next_follow_up_at` | A new follow-up date is set, or the enquiry closes |
| **Invoice to raise** | `v_payment_stages` where `stage_status = 'To Invoice'` | The project's `sales_person` is me | The day it became ready to raise (below) | An invoice number is recorded |
| **Payment to chase** | `v_payment_stages` with an invoice raised, unpaid, and more than 7 days past due | The project's `sales_person` is me | Payment rule (below) | A chase is logged, a promise to pay is recorded, the stage is put on hold, or it is paid |

**Who "me" is.** A record is mine when its `sales_person` matches my username
or the name on my account, compared as trimmed lowercase text. This is the
same identity rule the rest of the app scopes by (`identities()` and `mine()`
in `server/src/lib/scope.js:18-27`). My Today uses only the direct match. It
does not use the wider "visible to me" rule, under which a company counts as
mine through any of my deals.

**When an invoice became ready to raise.** `v_payment_stages` does not say.
The Invoice Run already works it out from the stage's trigger
(`billableSince()`, `web/src/pages/InvoiceRun.jsx:45-50`):

- **On PO Registration:** the PO date.
- **On Delivery:** the delivery date.
- **On Milestone:** the date the milestone was reached.
- **Manual:** no date exists. Use the date the stage was entered
  (`payment_stages.created_at`).

Move this rule to the server, so the page and the Invoice Run agree.

Sales users may raise invoices themselves. The `payment-stages` resource says
so: "Sales users raise and record against stages as usual"
(`server/src/lib/resources.js:392`).

## Due today or Late

The rule uses:

- `today`: the business date in India time (`businessToday()`).
- `late_by`: the number of working days after the due date, up to and
  including today (`workingDaysBetween(due, today, holidays)` in
  `server/src/lib/businessDate.ts:82`). Weekends and the holidays table are
  skipped.
- `grace`: 2 working days. This is a setting.

| Condition | Section |
|---|---|
| due date is after today | Not shown |
| `late_by` from 0 to `grace` | **Due today**. Items 1 or 2 days late carry a "1 day late" or "2 days late" label. |
| `late_by` greater than `grace` | **Late**, oldest first |

Example: today is Tuesday 29 September 2026, with no holidays that week.

| Due | Working days late | Calendar days late | Section |
|---|---|---|---|
| Tue 29 Sep | 0 | 0 | Due today |
| Mon 28 Sep | 1 | 1 | Due today, "1 day late" |
| Fri 25 Sep | 2 | 4 | Due today, "2 days late" |
| Thu 24 Sep | 3 | 5 | Late |

Items 1 or 2 days late stay under Due today, with a label, so that nothing
drops off the page. Otherwise a follow-up that slipped by one day would appear
in neither section until its third day. **This is decision 1 below.**

### Payment rule

"Pending more than 7 days past due" means `today - invoice_due_date > 7`
calendar days. Calendar days match how `days_overdue` is counted in the view
(`server/db/views.sql:120`) and how the reminder levels count.

A payment's due date for My Today is the first of these that applies:

1. **Promise to pay.** If `promise_to_pay_date` is today or later, it is not
   shown. After the promise passes, it is due the day after the promise.
2. **Chase logged by a person.** It is due on that entry's `next_action_on`.
   If the entry has none, it is due 7 days after the chase.
3. **Otherwise.** It is due on `invoice_due_date + 8`, the first day it is
   more than 7 days overdue.

Stages that are `on_hold` (in dispute) are never shown, as the reminder run
already does.

**Automatic reminder emails do not count as a chase.** The reminder run
writes to `collection_log` too (`server/src/lib/reminders.js:109-112`). If
those rows counted, an automatic email would clear the item before anybody
had called. Today the only way to tell those rows apart is their summary text
("Reminder level N emailed to …"). Give them a stable marker as part of this
work.

Example: an invoice due on Tue 15 September has its first day on the list
on Wed 23 September, under Due today. If nobody logs a chase, it moves to Late
on Mon 28 September, its third working day.

## Server

### 0. Reuse the ownership rule, do not rewrite it

"Mine" — assigned to me, or unassigned on a record I can see — is already
written twice on the server:

- `onRecordVisibleSql(req, table, params, { ownColumns })` in
  `server/src/lib/scope.js`, which the tasks, notes and attachments resources
  use through `visibleTo`.
- `mine(scope, params)` in `server/src/lib/mcp/data.js`, which `list_tasks`
  and `complete_task` use.

Take one of them rather than writing a third. A rule stated in three places
is a rule that will be applied in two: the MCP copy drifted from the web one
within a day of being written — it matched `assignee` and `created_by` but
not the record, so a task somebody raised on their own quotation and handed
to a colleague vanished from their list (#136).

`mine()` also strips the "(via MCP)" stamp before comparing. My Today does
not need that, but it is the kind of detail a rewrite loses.

### 1. The rules as pure functions: `server/src/lib/myToday.js`

Rows go in, and bucketed items come out: `dueOn(item)`, `bucket(dueOn, today,
holidays, grace)`, and the payment rule. There is no database access, so the
rules can be tested exactly. This is how `planReminders()` in
`server/src/lib/reminders.js` is built and tested.

### 2. The route: `GET /api/dashboard/my-today`

This goes in `server/src/routes/dashboard.js`, next to `/worklist`. It runs
four queries in parallel, one per kind. Each is filtered by
`lower(btrim(<owner column>)) = ANY($1)` using `identities(req)`, then passed
through the rules above.

```jsonc
{
  "data": {
    "today": "2026-09-29",
    "person": "Ravi Kumar",
    "rules": { "grace_working_days": 2, "chase_after_days": 7 },
    "counts": { "late": 4, "due_today": 6 },
    "late": [ /* items, oldest first */ ],
    "due_today": [ /* items, most late first, then by amount */ ]
  }
}
```

Each item has this shape:

```jsonc
{
  "kind": "payment",               // task | follow_up | invoice | payment
  "entity": "payment_stage", "entity_id": "412",
  "title": "Chase INV/2026-27/031 — Advance",
  "client_name": "Hetero", "company_id": 17,
  "due_on": "2026-09-23", "working_days_late": 4, "days_late": 6,
  "amount": 420000, "currency": "INR",
  "context": { "days_overdue": 14, "last_chase": "2026-09-16", "promise_to_pay_date": null },
  "link": "/collections?company_id=17"
}
```

`?summary=1` returns only `counts`, for the sidebar badge.

**Whose day it shows:**

- **Sales users:** always their own. A `person` parameter from them is
  ignored.
- **Admins:** their own by default. `?person=<name>` shows a sales person's
  day, for cover and one-to-ones.
- **Shared-login mode** (`AUTH_MODE=shared`): there is no named user, so the
  page asks for a person.

### 3. Pitfalls to avoid

- **Use one clock.** Pass `businessToday()` into every query as a parameter.
  Never use `CURRENT_DATE`, which is UTC in the containers.
  - Between 00:00 and 05:30 India time the two are a day apart. The comment
    at `server/src/routes/dashboard.js:148-158` explains the bug this caused
    on the worklist.
  - Places that still use UTC or browser time:
    - `v_payment_stages` decides "Overdue" and `days_overdue` with
      `CURRENT_DATE` (`server/db/views.sql:113`, `:120`).
    - `/api/tasks/summary` counts with `CURRENT_DATE`
      (`server/src/routes/timeline.js:139-142`).
    - The Tasks page uses the browser's date.
  - So work out "more than 7 days past due" from `invoice_due_date` and the
    passed-in date, not from the view's `days_overdue`.
- **Do not read the `stage_status = 'Overdue'` label for the payment rule.**
  Select unpaid, invoiced stages and compare dates. A partly paid stage past
  its due date is still one to chase.
- **Tasks with no assignee** count as mine only when they sit on one of my
  records. Otherwise every unassigned task appears on everybody's list.

### 4. Settings

These are rows in `settings`, editable by an admin like the others. They are
inserted with `ON CONFLICT DO NOTHING` in `server/db/schema.sql` and in the
next free migration.

| Key | Default | Meaning |
|---|---|---|
| `my_today_grace_working_days` | `2` | Working days an item may be late and still sit under Due today |
| `my_today_chase_after_days` | `7` | Calendar days past due before a payment needs a chase |
| `my_today_rechase_days` | `7` | Days until a chase logged without a next date comes back |

## Web

### Sidebar button

Add a first entry to `NAV_TOP` in `web/src/App.jsx:124-128`:

```js
{ to: '/my-today', icon: ListChecks, label: 'My Today', badge: 'mine' },
```

- **Badge.** It shows `late + due_today` from `?summary=1`. It is fetched
  like the inbox count, on each change of page (`App.jsx:416-418`), and added
  to `counts` (`App.jsx:436-440`). It turns red through `alerts.mine` when
  `late > 0`, as the inbox badge does for overdue threads.
- **Route.** Add `<Route path="/my-today" element={<MyToday />} />` beside the
  others (`App.jsx:479`).
- **Command palette.** Add a "My Today" command in
  `web/src/lib/commands.js`, next to `go-today` (`:207`).

The nav's own comment (`App.jsx:115-123`) argues for keeping the top of the
sidebar short. This adds one line to it, which is the point of the request.
Whether a sales user should *land* on My Today after sign-in is decision 5.

### The page: `web/src/pages/MyToday.jsx`

Build it on the patterns Today already set:

- The date as the title.
- A skeleton with the same geometry as the loaded page.
- 44px rows, each with one action.
- A list that empties as you work down it.

Layout:

```
My Today · Tuesday, 29 September                    [Person ▾] (admins only)
4 late · 6 due today

LATE — MORE THAN 2 WORKING DAYS
  ₹  Chase Hetero — ₹4.2L, 14 days past due, last chased 16 Sep     [Log chase]
  ☐  Send revised scope to Midal (task, due 22 Sep)                  [Done]
  ↻  Follow up NewCo — enquiry CTZ/ENQ/2026/031, due 24 Sep          [Log & reschedule]
  ₹  Raise Advance invoice — PRJ-2026-012, ready since 21 Sep        [Raise]

DUE TODAY
  ↻  Follow up Aurobindo — CTZ/ENQ/2026/044                  1 day late  [Log & reschedule]
  ☐  Call back Ravi at Hetero                                            [Done]
  …

✓ Nothing is waiting on you today.        ← empty state
```

Each row's action uses an endpoint or dialog that already exists:

| Kind | Action | How |
|---|---|---|
| Task | **Done** | `PATCH /api/tasks/:id { status: 'done' }`, as the Tasks page does |
| Follow-up | **Log & reschedule** | A small dialog with a note and the next date. It logs a touch (`POST /api/communications`), then sets `next_follow_up_at`. The next date is required. |
| Invoice | **Raise** | Opens the existing `RecordInvoiceDialog` (`web/src/components/actions.jsx:60`) |
| Payment | **Log chase** | Channel, what was said, and an optional promise date and next date. Posts to `POST /api/collections/log`. It also offers one-click call, email and WhatsApp through the contact bar. |

The follow-up date must be set. Logging a touch on an enquiry moves
`last_contacted_at` but not `next_follow_up_at`
(`server/db/schema.sql:1411-1413`). Without a new date, the follow-up would
stay on the list after the call.

After any action, refetch the list and the sidebar count.

## Tests

- **`server/test/myToday.test.js`** (pure rules, no database):
  - The worked example table above.
  - A weekend and a holiday inside the grace period.
  - Each branch of the payment rule: promise in the future, promise passed,
    chase with and without a next date, on hold, and an automatic reminder
    that must not count.
  - Manual-trigger invoice stages.
- **Route test** (real Postgres via `TEST_DATABASE_URL`, like
  `server/test/worklist.test.js`):
  - Sales user A never sees B's items.
  - An unassigned task shows only to the record's sales person.
  - An admin's `?person=` works, and a sales user's is ignored.
  - `?summary=1` agrees with the full list's counts.
- **Clock test:** at 00:30 India time, the route's "today" is the India date.
- **End-to-end** (`web/e2e/flows.spec.js`): the sidebar shows My Today with a
  count; ticking a task removes its row and lowers the count.

## Order of work

1. `lib/myToday.js` and its tests. This settles the rules before any UI.
2. The route, the settings rows and the marker on automatic reminder rows.
3. The page, the sidebar button, the badge and the palette command.
4. **Data check before launch.** Records whose `sales_person` matches no
   account appear on nobody's list. Add a Data Quality check for them, and
   fix the names before telling the team.
5. **Later:**
   - Put the My Today counts in each person's 08:30 digest (`lib/notify.js`).
   - Add "deals gone quiet" as a fifth kind: open quotations with no touch
     for `no_contact_days`, already worked out per owner at
     `server/src/routes/communications.js:124`.
   - Consider a follow-up date on quotations, which today only have tasks.

## Decisions needed

1. **Where do items 1 or 2 days late go?** Recommended: under Due today, with
   a "late" label. The alternative is that they appear in neither section
   until day 3.
2. **Working days or calendar days for the 2-day rule?** Recommended: working
   days, so Friday's work is not "late" on Monday morning. The 7-day payment
   rule stays in calendar days, matching the reminders.
3. **Does an automatic reminder email count as a chase?** Recommended: no.
   The point is a person talking to the client.
4. **Do unassigned tasks on my records count as mine?** Recommended: yes.
5. **Where should a sales user land after sign-in?** Recommended: keep Today
   as the landing page at first, and revisit once My Today has been in use
   for a few weeks.

## Risks

- **Name matching.** Ownership is a free-text name compared with the
  account. "Ravi" on a deal and "Ravi Kumar" on the account do not match, and
  that deal's work shows on nobody's list. Step 4 above addresses this.

  This is not hypothetical. `list_inbox` shipped comparing a token's person
  against `inboxes.members` with `&&`, which is case-sensitive, while that
  field holds names as somebody typed them — so a member of an inbox was
  told it was empty, and the failure looked like a quiet day rather than a
  bug (fixed in #136). Fold both sides the same way, and test with a
  capitalised name: a fixture that stores `{asha}` against a person `asha`
  is the one spelling where this class of bug is invisible.
- **A flooded first day.** Imported and older data can put hundreds of rows
  under Late on day one:
  - Enquiries get a follow-up date automatically when created
    (`server/db/schema.sql:1084-1085`, `lead_follow_up_default_days`).
  - The importer turns "next follow-up" columns into tasks.
  Fold anything more than 30 days late into one "older" row with a count and
  a link to the full list, so the page stays usable while the backlog is
  cleared.
- **The same thing in two places.** The bell also raises "task due",
  "overdue task" and "follow-up" alerts per person (`lib/notify.js:59-72`).
  Once My Today is in use, consider turning those kinds off in the bell by
  default, so a person is not told the same thing twice.
