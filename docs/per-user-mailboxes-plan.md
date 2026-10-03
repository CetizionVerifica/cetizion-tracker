# Each salesperson's own mailbox: implementation plan

When a company has more than one person with the **sales** role, each of
them connects **their own email address** in Settings. The tracker fetches
that mailbox's mail, and the salesperson sees **only the data that belongs
to them or was generated from their mailbox**. An **admin** sees every
mailbox configured in Settings, and everything those mailboxes produced.

This file is written for the person (or Claude Code session) who builds it.
Read [PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md), the row-scoping rule in
[issue-18-row-scoping.md](issue-18-row-scoping.md) and
[email-enquiries-plan.md](email-enquiries-plan.md) first. It follows the two
design rules there: nothing derived is stored, and each fact is typed in one
place. It was written against commit `ced2701`. **No code is written in this
step; this is the plan only.**

---

## 0. Decisions for the product owner

Recommended answers are in bold. Confirm or change them before building.

| Question | Recommendation |
| --- | --- |
| Who connects a salesperson's mailbox? | **The salesperson, from Settings → My mailbox.** Microsoft's sign-in proves they own the address; an admin cannot sign in as them. An admin can still connect shared mailboxes and reassign who owns any mailbox. |
| May one person connect more than one mailbox (e.g. a personal one and an alias)? | **Yes.** Every mailbox they connect is theirs. |
| Shared mailboxes (sales@, info@) | **Unchanged**: visible to the team through the Inbox, as today. Only *personal* mailboxes become private to their owner. |
| A salesperson's own mail with the visibility setting "metadata only" | **The owner chooses the level for their own mailbox; the default for a new personal mailbox becomes `subject`.** Today the default `metadata` hides subjects even from the owner, which makes "see my own email" pointless. |
| A mailbox is reassigned to another person | **Future records go to the new owner. Existing records stay where they are**; an admin moves them with the existing ownership-transfer screen if wanted (that keeps the ownership history honest). |
| A salesperson is deactivated | **Their mailbox stops syncing** (status `disconnected`, tokens removed), and it stays listed for the admin. Records already created keep their owner until an admin reassigns them. |
| Records generated from a mailbox whose owner is not a salesperson (e.g. an admin's own mailbox) | **Unowned**, as today (`ownerFor` rule): visible to admins, who assign them. |

---

## 1. What already exists

Most of the plumbing is in place. The feature is mainly about tying a
mailbox to a **user row** instead of a typed name, and making every reader
use that link.

| Existing piece | Where | What it does today | Gap |
| --- | --- | --- | --- |
| Connected mailboxes | `connected_accounts` (migration 031), `routes/mailboxes.js` | Any signed-in user can connect a Microsoft 365 mailbox via OAuth. Sync runs every 60 s and reads every folder (`lib/mailbox/sync.js`, `autoSync.js`; #173, #181). | Ownership is `username text` — whoever was signed in when it was connected — not a `users.id`. Matching is by lower-cased name or email strings. |
| Mailbox list / settings API | `GET/PATCH /api/mailboxes`, `readable()`, `mayAdminister()` | Admin sees all. Sales sees shared mailboxes plus ones whose `username` matches their email or name. | String matching breaks when a name changes, and an admin connecting on someone's behalf makes the admin the owner. |
| Settings UI | `web/src/pages/SettingsArea.jsx:104`, `web/src/pages/Mailboxes.jsx` | Settings → Mailboxes. | **`adminOnly: true`** — a salesperson cannot reach the page to connect their own mailbox at all. |
| Owner of auto-created records | `lib/mailbox/autoEnquiry.js` `ownerFor()` / `salesUser()` | A personal mailbox's enquiries/quotations go to the salesperson matched by `account.username`, then `account.email`. | Same string matching; fails when the mailbox address differs from the login address. |
| Row scoping | `server/src/auth/ownership.js` (Phase 2C) | Sales users see rows with `owner_user_id = me`; admins see everything. | Already right for enquiries, quotations, projects, POs. Email threads are not covered by it. |
| Thread visibility | `routes/mailboxes.js` `readableThread()` | Own mailboxes + shared + threads on records the user owns. | "Records the user owns" is matched on `sales_person` text, **not** `owner_user_id` — out of step with Phase 2C. |
| Record timeline | `routes/timeline.js:130` | Lists email threads for a company or record. | **No mailbox scoping at all**: a salesperson opening a company sees subjects of threads from colleagues' personal mailboxes. This is a leak to fix in this work. |
| Inbox | `routes/inbox.js` `inboxScope()` | Shared inbox queues by members / assignee. | Members and assignees are typed names. Out of scope here except where noted (§6). |

---

## 2. The rule

```
admin, or the legacy shared login   every mailbox, every thread, every record
a sales user                        mailboxes where user_id = me
                                    + shared mailboxes (through the Inbox, as today)
                                    threads in those mailboxes
                                    + threads attached to a record they own (owner_user_id = me)
                                    records: owner_user_id = me (unchanged, Phase 2C)
```

"Data generated by their emails" is covered because every record the email
reader creates from a personal mailbox is given `owner_user_id` = that
mailbox's `user_id`. Once owned, the existing Phase 2C scoping shows it to
them and hides it from colleagues — no second visibility system.

Refusals follow Phase 2C: **404** for a specific mailbox or thread that is
not yours (same as one that does not exist), **403** only for actions
forbidden by role.

The rule lives in **one** helper, next to the other ownership helpers, and
nowhere else (see §4.2).

---

## 3. Schema — migration `074_mailbox_owner.sql`

Migrations 067–073 are taken on `main` (phase 2 and the readers); `074` is the next free number. Mirror the change
in `server/db/schema.sql`, and keep `scripts/ci/check-migrations.sh` green.
Safe on a live database; running it twice changes nothing.

1. `connected_accounts.user_id int REFERENCES users(id) ON DELETE SET NULL`
   — **the owner**. Null for a shared mailbox, and for a personal one whose
   owner could not be determined.
2. `connected_accounts.connected_by int REFERENCES users(id) ON DELETE SET NULL`
   — who pressed Connect (audit only; may differ from the owner).
3. Keep `username` for now (read by nothing new; drop in a later clean-up
   once nothing reads it).
4. Index `connected_accounts (user_id) WHERE status <> 'disconnected'`.
5. Check constraint: a shared mailbox has no personal owner
   (`NOT (is_shared AND user_id IS NOT NULL)`).
6. **Backfill**, deterministic and logged:
   - personal mailboxes: `user_id` = the active user whose `lower(email)`
     equals `lower(username)`, else `lower(email)` of the mailbox, else the
     unique user whose `lower(name)` equals `lower(username)`;
   - more than one candidate, or none → leave null and list it in a
     diagnostics query (`server/db/diagnostics/mailbox-owner-backfill.sql`)
     for the admin to assign by hand, the same approach as
     `ownership-backfill.sql`.
7. Setting `personal_mailbox_default_visibility`, default `subject`
   (see §0). Existing mailboxes keep their current value.

No other table changes: threads and messages already hang off
`account_id`, and records already carry `owner_user_id`.

---

## 4. Server

### 4.1 Connecting a mailbox

`routes/mailboxes.js`:

- `GET /connect/microsoft` and the OAuth callback set `user_id` = the
  signed-in user for a personal mailbox, `connected_by` = the same, and
  `user_id = NULL` for `?shared=1` (shared stays admin-only to create —
  enforce `requireAdmin` when `shared=1`).
- The `ON CONFLICT` upsert must **not silently change the owner**. If the
  address is already connected and owned by someone else, return to
  Settings with "That mailbox is already connected by <name>. Ask an admin
  to reassign it." Reconnecting your own mailbox (expired tokens) keeps
  working as now.
- New mailbox: visibility from `personal_mailbox_default_visibility`.

### 4.2 One access helper

Add `mailboxScope(scope, params, { accountAlias, threadAlias })` to
`server/src/auth/ownership.js` (or `lib/mailbox/access.js` re-exported from
there), returning parameterised SQL like the other helpers:

- `readableMailbox` — admin: `TRUE`; sales: `a.user_id = $n OR a.is_shared`.
- `administrableMailbox` — admin: `TRUE`; sales: `a.user_id = $n`
  (shared ones are admin-only to change).
- `readableThread` — `readableMailbox` OR the thread's entity is an
  enquiry / quotation / project / PO with `owner_user_id = $n`
  (reuse `ownerClause` / `purchaseOrderClause`, not `sales_person` text).

Replace `readable()`, `readableThread()`, `mayAdminister()` and
`identities()` in `routes/mailboxes.js` with it. No string matching of
names remains for mailboxes.

### 4.3 Every reader of mail uses it

| Route | Change |
| --- | --- |
| `GET /api/mailboxes` | `readableMailbox`. Response adds `owner: {id, name}` and `connected_by`. |
| `PATCH /api/mailboxes/:id`, `/sync`, `/refresh-bodies`, `/disconnect` | `administrableMailbox`; 404 when not yours. A sales user may change only `visibility`, `import_days`, `exclude_internal`, `auto_create_contacts` — **not** `is_shared`. |
| **New** `PATCH /api/mailboxes/:id/owner` (admin) | Body `{ user_id }` (an active sales/admin user, or null). Records an activity-log entry. Does not move existing records (§0). |
| `GET /api/threads`, `/threads/:id`, `/origin` | `readableThread`. |
| `PATCH /threads/:id`, `POST /threads/:id/reply` | `readableMailbox` (unchanged meaning: you may only speak from a mailbox you are entitled to). |
| `GET /api/timeline/...` (`routes/timeline.js:130`) | **Add `readableThread`** — fixes the current leak. |
| `routes/portal.js` | Audit its `connected_accounts` read; it is client-facing and must not expose mailbox owners. |
| `GET /api/mailboxes/auto-enquiries` | Stays admin-only. Optionally add `?mine=1` for a sales user's own counts (nice-to-have). |
| Search (`routes/search.js`), MCP tools (`routes/mcp.js`), exports | Grep for `email_threads` / `email_messages`; any that return mail must use `readableThread`. |

### 4.4 Records generated from a mailbox

`lib/mailbox/autoEnquiry.js` `ownerFor()`:

1. Personal mailbox → `account.user_id`, if that user is active with role
   `sales`. Remove the `salesUser(account.username)` / `account.email`
   string lookups (the backfill has already turned those into `user_id`).
2. Shared mailbox → unchanged (conversation assignee, then fallback).

The same owner flows into quotations created from a PDF
(`autoQuotation.js`). Phase 2 is now built, and it works differently (see
§10): a PO takes **its quotation's** owner, and `ownerFor` is used only for
a quotation created from a PO.

Sync itself (`sync.js`) reads per account, but since #181 it reads
**every folder** of a personal mailbox. See §10 for the decision this
needs.

### 4.5 Lifecycle

- User deactivated (`routes/users.js`): disconnect their personal
  mailboxes (status `disconnected`, tokens cleared, subscriptions removed
  via existing `disconnect()`), in the same transaction as the
  deactivation. Show the admin a notice listing them.
- User deleted: `ON DELETE SET NULL` leaves the mailbox ownerless and
  visible to admins only.

### 4.6 Authorization inventory

Update `server/src/lib/authz/policy.js` (mailbox and thread rows, the new
`/owner` route, timeline restriction) and regenerate the docs with
`npm run authz:docs`. `authzPolicy.test.js` / `authzRoleMatrix.test.js` must
stay green.

---

## 5. Web

### 5.1 Salesperson: Settings → My mailbox

- `SettingsArea.jsx`: make the Mailboxes entry visible to every role. A
  sales user sees it labelled **My mailbox**; an admin sees **Mailboxes**.
- For a sales user, `Mailboxes.jsx` shows only their own mailboxes:
  address, status, last synced, last error, a **Connect my Microsoft 365
  mailbox** button, **Reconnect** when tokens expired, **Sync now**,
  **Disconnect**, and the privacy level with plain wording of what each
  level stores.
- Hidden for sales: "Connect shared mailbox", the auto-enquiry stats panel,
  test mailboxes, blocklist editing, the shared toggle.
- Empty state: "Connect your work email so enquiries and replies from your
  clients appear on your records automatically."

### 5.2 Admin: Settings → Mailboxes

- Every configured mailbox, with an **Owner** column (or "Shared" /
  "Unassigned"), connected-by, status, last synced, thread count.
- Filter by owner and by status; "Needs attention" chip for
  `needs_reconnect` and unassigned personal mailboxes.
- **Change owner** action (calls `PATCH /:id/owner`), with the note that
  existing records do not move and a link to the ownership-transfer screen.
- Everything admins have today stays.

### 5.3 Elsewhere

- Thread panels on records, the timeline and the inbox already call the
  scoped APIs; no UI change beyond showing "from <owner>'s mailbox" on a
  thread when the viewer is an admin.
- Users & roles: show each user's connected mailbox(es) and status.

---

## 6. Out of scope (note, do not build)

- Converting inbox `members` / `assignee` from names to user ids. Worth a
  follow-up issue; the shared inbox keeps working with names.
- Gmail / IMAP providers (`provider` already allows `imap`).
- A salesperson delegating their mailbox to a colleague (cover leave).
- Dropping `connected_accounts.username`.

---

## 7. Tests (server, `node --test`)

New `server/test/mailboxOwnership.test.js`, plus additions to existing files:

1. Migration: backfill matches by email, then mailbox email, then unique
   name; ambiguous and unmatched rows stay null; re-running changes nothing.
2. Two sales users A and B, each with a personal mailbox, plus one shared
   mailbox and an admin:
   - A lists only A's mailbox + the shared one; B likewise; admin all three.
   - A gets 404 for B's mailbox on GET thread, PATCH, sync, disconnect.
   - A cannot set `is_shared`, cannot call `/owner`.
   - A sees a thread from B's mailbox **only** when it is attached to a
     record A owns (`owner_user_id`, not `sales_person`).
   - Timeline for a shared client company: A does not see B's thread
     subjects (regression test for the current leak).
3. Auto-created enquiry and quotation from A's mailbox get
   `owner_user_id = A`; B cannot list or open them; admin can.
4. Mailbox address differs from A's login email: ownership still A.
5. Reconnecting an address owned by B while signed in as A → refused, owner
   unchanged.
6. Reassigning a mailbox: new mail → new owner; old records unchanged.
7. Deactivating A disconnects A's mailbox and stops sync.
8. Authz inventory tests updated for the new/changed routes.

Manual check with the `test-app` skill: two sales logins in separate
browsers, test mailboxes via `POST /api/mailboxes/test` (non-production),
confirm each sees only their own mail and records, and the admin sees all.

---

## 8. Build order

Each step is one reviewable PR (or one commit on a single branch), tests
green at each step:

1. Migration 074 + `schema.sql` + backfill diagnostics. No behaviour change.
2. `mailboxScope` helper and switch `routes/mailboxes.js` to it; connect
   flow writes `user_id`; owner-conflict refusal. Tests 2, 4, 5.
3. Close the leaks: timeline, search, MCP, portal audit. Test 2 (timeline).
4. `ownerFor` on `user_id`. Test 3.
5. Admin `/owner` route, deactivation hook, authz inventory + docs. Tests 6–8.
6. Web: My mailbox for sales, owner column and reassign for admin, users page.
7. Update `docs/security.md`, `docs/email-enquiries.md` and `PROGRESS.md`.

## 9. Files touched (expected)

- `server/db/migrations/074_mailbox_owner.sql`, `server/db/schema.sql`,
  `server/db/diagnostics/mailbox-owner-backfill.sql`
- `server/src/auth/ownership.js`
- `server/src/routes/mailboxes.js`, `timeline.js`, `search.js`, `mcp.js`,
  `portal.js`, `users.js`
- `server/src/lib/mailbox/autoEnquiry.js`, `autoQuotation.js`
- `server/src/lib/authz/policy.js` (+ regenerated authz docs)
- `server/test/mailboxOwnership.test.js` and existing authz tests
- `web/src/pages/SettingsArea.jsx`, `web/src/pages/Mailboxes.jsx`, users admin page
- `docs/security.md`, `docs/email-enquiries.md`, `PROGRESS.md`

---

## 10. Changes needed now that phase 2 and #173–#181 are on `main`

This plan was written against `ced2701`. Since then, phase 2 (POs and
invoices from email) and the reader changes (#173, #175–#177, #179–#181)
have merged. Check these before building:

1. **Migration number.** 067–073 are taken; this plan now uses **074**.
2. **Every folder and every email of a personal mailbox go to the AI.**
   With `email_read_everything` (073) on, a salesperson's own mailbox has
   every folder read (Archive and personal subfolders included). Every
   email in it, including colleague and robot mail, is sent to the AI
   provider, often twice (enquiry and PO readers). The visibility default
   proposed in §0 (`subject`) limits what is **stored**, not what is
   **read**.
   - **Decision needed:** should personal mailboxes read Inbox and Sent
     Items only, with "read everything" applying to shared mailboxes?
     Recommended: **yes**, with a per-mailbox switch the owner controls.
     This needs a `read_scope` column on `connected_accounts` in 074, and
     a check in `sync.js` `foldersOf()` and the readers' `forReaders`.
3. **AI cost when several people connect.** Each new mailbox starts a
   365-day backfill of all its folders, sharing one 5,000-a-day ceiling.
   Several salespeople connecting in one week could hold every mailbox's
   backfill back for days.
   - Add a per-mailbox share of the ceiling, or a queue that backfills one
     new mailbox at a time.
   - Show "N days left to read" on Settings → My mailbox.
4. **Who owns a record read from two mailboxes.** When the same email is
   in A's and B's mailboxes, the second copy is only `linked`
   (`joinElsewhere` in `autoEnquiry.js` and `autoPurchaseOrder.js`). The
   record belongs to whoever's mailbox was read first, not to "the owner
   of the mailbox it came from". Rule to add: if exactly one of the
   mailboxes holding the email belongs to a salesperson, that person owns
   the record; otherwise keep the first reader's owner.
5. **PO and invoice owners.** §4.4 assumed phase 2 would call `ownerFor`.
   As built, a PO takes its quotation's owner, and invoice decisions have
   no owner. Keep that: a PO belongs to the deal. Scope the review queues
   by the **mailbox owner** as well as the quotation owner. Today
   `routes/poReview.js` and `routes/invoiceReview.js` scope sales users
   by quotation owner only, so a review item from a salesperson's own
   mailbox with no suggested quotation is visible to admins only.
6. **Routes to add to §4.6's inventory:**
   - `poReview`, `invoiceReview`;
   - `POST /api/mailboxes/:id/auto-enquiries/rerun` (with its `kind`);
   - the reader-queue failure notices to admins.
7. **Lifecycle (§4.5).** `disconnect()` clears the enquiry backfill row
   and the reader queue, but not `mailbox_po_backfills` or
   `mailbox_invoice_backfills`, and does not reset the `past_*_read_at`
   markers. Clear those too, or a reconnected mailbox never re-reads its
   past POs and invoices.
8. **No conflict with #173.** Keep-all applies only to mailboxes that feed
   an Inbox, which matches "shared mailboxes unchanged". Thread scoping
   must still allow for `filtered_as` (internal or robot) threads in
   shared mailboxes.
9. **The Outlook-style Inbox**
   ([inbox-outlook-plan.md](inbox-outlook-plan.md)) shows each person's
   own mailbox in the Inbox. It depends on this plan's `user_id` ownership
   and access helper (§4.2), so build this plan first.

