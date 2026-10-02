# New enquiries from email, automatically: implementation plan (phase 1)

Every **active connected mailbox** is read. An email from a client asking for
new work becomes an **enquiry** in the tracker with no one pressing a button.
This includes the **past year of mail**, not only what arrives from now on.

Phase 1 is **new enquiries only**. It does not cover quotations, POs,
invoices or replies on deals that already exist.

This file is written for the person (or Claude Code session) who builds it.
Read [PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md) first. It follows the two
design rules there: nothing derived is stored, and each fact is typed in one
place. It was written against commit `24af059`.

---

## 0. Decisions already made by the product owner

| Question | Decision |
| --- | --- |
| Which mailboxes may be read to find enquiries? | **All connected mailboxes**, including personal ones set to "metadata only". The email is read in memory to decide. Only the enquiry's own fields are saved: company, contact, service and a one-line summary. The mailbox's privacy setting still controls whether the email itself is stored. |
| How is an email judged to be a new enquiry? | **AI, after rules.** Cheap rules discard obvious non-enquiries first. The rest go to the AI the bulk importer already uses (OpenRouter, routed only to providers that keep no data), which also extracts the company, contact and service. With no AI key configured, rules alone decide, with a stricter bar. |
| How far back? | **365 days** for every mailbox. |
| Manual or automatic? | **Fully automatic.** It is on by default, and admins have one switch to turn it off. |

---

## 1. What already exists, and why it is not this

| Existing piece | File | What it does | Why it is not this feature |
| --- | --- | --- | --- |
| Mailbox sync | `server/src/lib/mailbox/sync.js` `syncAll`/`syncAccount`/`ingest` | Every 5 minutes (`mail.sync` in `jobs.js`), pulls Inbox and Sent Items by Graph delta. It matches the sender to a company and contact, links the thread to a record, and stores messages. | It never creates an enquiry. A **personal** mailbox throws away mail from senders it cannot match (`skip('no matching client')`), and new leads are exactly those senders. |
| Shared inbox | `server/src/lib/inbox.js`, `routes/inbox.js` | Each thread in a shared mailbox becomes a conversation with an owner and a reply clock. `suggestionFor()` says "this looks like a new enquiry". `POST /api/inbox/:id/convert` creates the enquiry. | A person must open the thread and press **Create the enquiry**. Personal mailboxes have no inbox at all. |
| Thread linking | `sync.js` `linkRecord()` | Links a thread to the record numbered in the subject, otherwise to the client's latest **open quotation or enquiry**. | That fallback hides a repeat client's *new* request under their old deal. Detection must tell a strong link (a number in the subject) from a weak one (the same company). |
| Visibility | `rules.js` `applyVisibility()` | `metadata` (the default) stores no subject or body, and `subject` stores no body. | Detection needs the text. It must read it before visibility is applied and keep nothing of it beyond the enquiry fields. |
| First sync window | `connected_accounts.import_days` (default 30, max 365) | How far back the *first* delta sync reaches. | Mailboxes already synced will never look back again. The delta cursor only moves forward. |
| AI helper | `server/src/import/ai.js` `chatJSON` | OpenRouter, `temperature 0`, JSON output, `data_collection: 'deny'` + `zdr`. | It is private to the importer and counts usage against the import batch. |
| Body re-read | `sync.js` `refreshBodies()` | Re-reads a window of mail without touching the delta cursor. | This is the right *shape* for the backfill sweep, but it only updates rows we already hold. |

**Summary:** the tracker already receives the mail and can already turn a
thread into an enquiry. Three things are missing:

- **(a)** deciding, without a person, that an email *is* a new enquiry;
- **(b)** keeping new-lead mail that personal mailboxes currently drop;
- **(c)** reading back through the past year once per mailbox.

---

## 2. Scope

### In scope

1. A **detector** that judges each inbound email as either a new enquiry or
   not. It has rules first and AI second, and it returns structured fields.
2. **Automatic enquiry creation**, inside the 5-minute sync, for every active
   mailbox, shared or personal.
3. **Backfill**: a resumable sweep of the last 365 days for every active
   mailbox. It starts by itself, once per mailbox, including mailboxes
   connected later.
4. **No duplicates.** The same email in two mailboxes, a re-run, or a client
   writing twice within a few weeks gives one enquiry.
5. A **decision log**, so admins can see what was created, what was skipped
   and why, without the email's text.
6. Admin **switch and status** in Settings → Mailboxes.
7. Tests and documentation.

### Out of scope (say so in the PR)

- Quotations, POs, invoices or payments read from email. Those are later
  phases.
- Attachments. Only the subject and body are read; RFQ PDFs are not opened.
- Auto-replying to the client.
- IMAP or Gmail. Microsoft 365 only, as today.
- Re-judging old decisions when the rules change. Decisions are final. An
  admin can clear them for one mailbox to re-run (§6.3).

---

## 3. How it works

### 3.1 Flow for one email

```
mail.sync (every 5 min)            auto-enquiry backfill (job)
        │                                   │
        ▼                                   ▼
 provider.delta(inbox)          provider.page(inbox, since 365d, cursor)
        │                                   │
        └──────────────► candidates ◄───────┘
                             │
                 1. already decided? (account+provider_id,
                    or same internet_message_id elsewhere) ──yes──► stop (or link)
                             │ no
                 2. prefilter (rules, free)  ──skip──► stop (not logged)
                             │ candidate
                 3. classify: AI if configured, else rules
                             │
                 4. confidence ≥ threshold and kind = new_enquiry?
                       │ no ──► log not_enquiry
                       │ yes
                 5. same sender has an open enquiry < 30 days? ──yes──► link thread, log linked
                       │ no
                 6. create enquiry + company + contact (one transaction),
                    store the email/thread if it was dropped, link thread
                    (and inbox conversation), log created, notify owner
```

### 3.2 Which emails are candidates (prefilter, pure rules)

An email goes on to be classified only if **all** of these hold:

| Rule | Why |
| --- | --- |
| Inbound, from an external address, not blocked (`classify()` already does this) | Our own mail, colleague mail and robots are never enquiries. |
| It is the **first message we know of in its conversation**, and the conversation was started by the client | Phase 1 is *new* enquiries. A reply in a thread that already exists is not one. |
| The subject carries **no record number** (`referencesIn()`: QT/ENQ/PO) | It is about a record we already have. |
| The thread is not linked to a record by a number, and is not already converted (`inbox_conversations.enquiry_no`) | Already handled. A *weak* company-fallback link does **not** exclude it (see §1). |
| It does not look like bulk or automated mail: `unsubscribe`, `view in browser`, `this is an automated message`, or a sender like `newsletter@`/`marketing@` | Newsletters and notifications. |
| It is not obviously billing or HR: subject or body only about invoice, remittance, payment advice, statement of account, resume, CV, job application or internship, **and** it has none of the enquiry words in §3.3 | Cheap discard before paying for AI. |

Prefilter skips are **not** logged. They are cheap to repeat, and logging
every email would make the log mostly noise.

### 3.3 Classification

**With AI** (`OPENROUTER_API_KEY` set): one call per candidate, at
`temperature 0`, returning JSON:

```jsonc
{
  "kind": "new_enquiry | reply_or_followup | billing | vendor_or_sales_pitch | marketing | job_application | spam | other",
  "confidence": 0.0-1.0,
  "company_name": "…", "contact_name": "…", "contact_phone": "…",
  "service": "one of the service lines, or the client's words",
  "sector": "…", "country": "…",
  "summary": "one sentence, no personal data beyond names"
}
```

- **Input:** sender name and address, sender domain, subject, and the new
  part of the body only. Use `splitQuoted().main`, flattened to text and
  capped at about 4,000 characters. Also send whether the company is known
  and whether it has open deals, but no deal values. List the service lines
  from `lib/serviceLines.js` so the answer maps to them.
- **Privacy:** route with `provider: { data_collection: 'deny', zdr: true }`,
  as the importer does. A request that fails to route falls back to rules;
  it never falls back to a provider that keeps data.
- **Validation in code:** the model proposes and code decides. Clamp
  confidence to 0–1, trim every field, and reject a `company_name` that is
  our own company or a free-mail domain. **Code** checks that the kind is
  `new_enquiry` and that confidence meets the threshold
  (`auto_enquiry_min_confidence`, default 0.7).

**Without AI** (rules only):

- **Score** the subject and body:
  - Enquiry words count for it: quote, quotation, proposal, RFQ, enquiry,
    inquiry, requirement, "interested in", "request for", pricing, cost,
    fee, "please share", scope, audit, certification, assessment.
  - A match on a service-line regex counts for it.
  - Billing and bulk words count against it.
- **Bar:** create only at a high score (equivalent to 0.85), so rules-only
  errs towards missing an enquiry rather than inventing one.
- **Fields:** company from the matched company, otherwise from the sender's
  domain (`acme-steel.co.in` → "Acme Steel"). Contact from the From name.
  Service from the first matching service line.

Prompt and parsing live in a **pure** module so they can be tested without a
network.

### 3.4 Creating the enquiry

Extract the body of `POST /api/inbox/:id/convert` into one library function,
`createEnquiryFromEmail(db, { thread, message, fields, owner, by })`. Both
the route and the automation call it, so a manual conversion and an
automatic one produce the same record.

| Enquiry column | Value |
| --- | --- |
| `enquiry_no` | `claimNextId('enquiry', db)` |
| `enquiry_date` | Date the email was sent, in IST. A 2025 email gives a 2025 enquiry, so reports count it in the right month. |
| `client_name` | Matched company's name, otherwise the AI/rules company name. The `link_company` trigger finds or creates the company. |
| `contact_person` / `contact_id` | From name; the contact gets the sender's email. This reuses the contact logic already in the convert route. |
| `service`, `sector`, `country` | From classification, when given. |
| `status` | `New`. The rules in `enquiryRuleErrors` allow it with only a company. |
| `source_id` | `Inbound email or call` |
| `notes` | "Created automatically from an email to *mailbox* on *date*: *summary*". The summary is one line; the body is never copied. |
| `first_responded_at` | Date of our first reply in the thread, if one exists. Backfilled enquiries are often already answered. |
| `owner_user_id` | **Personal mailbox:** the mailbox's user, if that user is a salesperson (same rule as `ownerForNewRecord`). **Shared mailbox:** the inbox conversation's assignee, if that maps to a salesperson. Otherwise unowned, so it appears as unassigned and nobody is wrongly given it. |

In the same transaction:

- **Personal mailbox, sender unmatched:** the email was never stored. Store
  it now, through `ingest`, with the new company. The thread then exists,
  and later replies match by contact as normal. Visibility still applies, so
  a metadata-only mailbox stores no subject or body.
- **Link the thread:** `email_threads.entity = 'enquiry'`. If the mailbox is
  shared, also set `inbox_conversations.enquiry_no`. This is exactly what
  the convert route does.
- **Log the decision:** write a row with outcome `created`.

After commit, **notify** the owner, or admins if it is unowned:
"New enquiry ENQ/… from Acme Steel, created from email". Use the existing
`notify()`. For backfill there is **one summary notification per mailbox**,
not one per enquiry.

### 3.5 No duplicates

1. **Same email, any mailbox.** Before classifying, look up
   `internet_message_id` in the decision log across all mailboxes. If it is
   already `created` or `linked`, only link this mailbox's thread to that
   enquiry and log `linked`. No second AI call is made.
2. **Same email, same mailbox, again.** This happens on re-sync or a
   backfill overlapping live sync. The unique key `(account_id, provider_id)`
   on the log stops it.
3. **Same sender, new thread, within `auto_enquiry_same_sender_days`**
   (default 30). If that sender, or their company, has an enquiry still
   `New`/`Contacted`/`Qualified`/`Nurture` created in that window, link the
   new thread to it instead of creating another. Log `linked`.
4. **Race.** Live sync and backfill can meet on one email. Take a Postgres
   advisory lock on `hashtext(internet_message_id or provider_id)` for the
   create step, then check again under the lock.

### 3.6 Backfill of past mail

- **Trigger:** a new pg-boss job, `enquiries.backfill`, every 10 minutes. On
  each run it takes the active mailboxes whose backfill is unfinished, which
  includes mailboxes with no backfill row yet. That covers mailboxes
  connected after release with no extra step.
- **Reading:** add a `page(folder, { sinceIso, cursor })` method to the
  provider. It is a plain list of
  `/mailFolders/inbox/messages?$filter=receivedDateTime ge …&$orderby=receivedDateTime asc&$top=50`,
  following `@odata.nextLink`. Delta is not used, so the live sync cursor
  is never touched; `refreshBodies` makes the same choice.
- **Resumable:** after each page, store `next_link`, the counts and
  `updated_at` in `mailbox_enquiry_backfills`. Each run has a time budget of
  about 4 minutes, then stops and the next run continues. A 365-day mailbox
  may take several runs, and a restart loses nothing.
- **Same pipeline:** each page goes through §3.1 exactly as live mail does.
  Messages already stored use their stored thread; messages that were
  dropped are judged from the raw message.
- **Order:** oldest first, so "first message in the conversation" is
  decided correctly and the same-sender rule links later emails to the
  earlier enquiry.
- **AI pacing:** at most 2 AI calls in flight per run, and a daily ceiling
  on AI calls (setting, default 1,500) so a large backfill cannot run up an
  unbounded bill. When the ceiling is reached, the run stops and resumes
  the next day.
- **Done:** set `finished_at` and send one notification: "Read 365 days of
  sales@…: 42 enquiries created, 9 linked to existing ones."

### 3.7 Live sync changes (`sync.js`)

- `ingest()` gains a return value, `candidates`. It lists inbound messages
  that passed `classify()` and either:
  - started a new thread in this call, or
  - were dropped as `no matching client`.
  Each item carries the raw message **in memory** (subject and text) plus
  the stored thread and message ids if they were stored. Nothing extra is
  written by `ingest`.
- `syncAccount()` hands the Inbox folder's candidates to
  `processCandidates(account, candidates)` **after** the ingest transaction.
  AI calls are never made inside a database transaction or while holding a
  thread lock.
- When `auto_enquiries_enabled` is `false`, `processCandidates` returns
  immediately, and sync behaves exactly as it does today.

---

## 4. Data

### 4.1 Migration `065_email_enquiries.sql` (mirror it in `schema.sql`)

```sql
-- What was decided about one inbound email. An event (the email was read
-- and judged), not a derived value, so it is stored. Holds none of the
-- email's text.
CREATE TABLE IF NOT EXISTS email_enquiry_decisions (
  id                  serial PRIMARY KEY,
  account_id          int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id         text NOT NULL,
  internet_message_id text,
  conversation_id     text,
  thread_id           int REFERENCES email_threads(id) ON DELETE SET NULL,
  from_email          text,
  received_at         timestamptz,
  outcome             text NOT NULL CHECK (outcome IN ('created','linked','not_enquiry')),
  kind                text NOT NULL,
  confidence          numeric(4,3),
  method              text NOT NULL CHECK (method IN ('ai','rules')),
  enquiry_no          text REFERENCES enquiries(enquiry_no) ON UPDATE CASCADE ON DELETE SET NULL,
  decided_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);
CREATE INDEX ON email_enquiry_decisions (lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
CREATE INDEX ON email_enquiry_decisions (enquiry_no) WHERE enquiry_no IS NOT NULL;

-- How far the sweep of past mail has got, per mailbox.
CREATE TABLE IF NOT EXISTS mailbox_enquiry_backfills (
  account_id  int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since       timestamptz NOT NULL,
  next_link   text,
  scanned     int NOT NULL DEFAULT 0,
  created     int NOT NULL DEFAULT 0,
  linked      int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, notes) VALUES
  ('auto_enquiries_enabled', 'true', '…'),
  ('auto_enquiry_min_confidence', '0.7', '…'),
  ('auto_enquiry_backfill_days', '365', '…'),
  ('auto_enquiry_same_sender_days', '30', '…'),
  ('auto_enquiry_daily_ai_limit', '1500', '…')
ON CONFLICT (key) DO NOTHING;
```

- **"Created automatically" is derived, not stored:** an enquiry has a
  decision row with outcome `created`. No new column goes on `enquiries`,
  which matters because `v_enquiries` is `SELECT e.*`; see the column-order
  note in `schema.sql`.
- **`scripts/ci/check-migrations.sh`** must pass: the fresh schema and the
  upgraded schema must be identical.
- **`server/db/scrub.sql`:** null `from_email` in the decision log for
  staging copies.

### 4.2 Disconnecting a mailbox

`disconnect()` leaves enquiries alone; they are business records. It deletes
that mailbox's backfill row. Decision rows stay, for the audit trail.

---

## 5. Files

| File | Change |
| --- | --- |
| `server/src/lib/ai.js` | **New.** Move `chatJSON` out of `import/ai.js`, with options `{ title, usage }` so each caller counts its own usage. `import/ai.js` imports it, and its behaviour is unchanged. |
| `server/src/lib/mailbox/enquiryDetect.js` | **New, pure.** `prefilter()`, `ruleScore()`, `buildPrompt()`, `parseVerdict()`, `companyNameFromEmail()`. No database, no network. |
| `server/src/lib/mailbox/autoEnquiry.js` | **New.** `processCandidates()`, `decide()`, `backfillAccount()`, `runBackfills()`, `createEnquiryFromEmail()`, `ownerFor()`. |
| `server/src/lib/mailbox/sync.js` | `ingest()` returns candidates; `syncAccount()` calls `processCandidates()`; add a `forceKeep` option for storing a dropped email once it is an enquiry. |
| `server/src/lib/mailbox/microsoft.js` | Add `page()`. Add the same to the test provider in `sync.js` (messages pushed with `history: true`). |
| `server/src/routes/inbox.js` | `/convert` calls `createEnquiryFromEmail()`. The response stays the same. |
| `server/src/jobs.js` | Register `enquiries.backfill` (`*/10 * * * *`, `quiet` unless something was created). |
| `server/src/routes/mailboxes.js` | `GET /api/mailboxes/auto-enquiries` (admin): per-mailbox backfill progress and counts by outcome and kind. `POST /api/mailboxes/:id/auto-enquiries/rerun` (admin): clear that mailbox's `not_enquiry` decisions and backfill row. |
| `server/src/lib/authz/policy.js` | Declare both routes as `mustBeAdmin`. `authzPolicy.test.js` and `authzDocs.test.js` fail otherwise. |
| `web/src/pages/Mailboxes.jsx` | An "Automatic enquiries" card: the on/off switch (writes `auto_enquiries_enabled`), and per mailbox "Past mail: 212 of 365 days read · 42 created · 9 linked", the last error, and **Re-run**. |
| `web/src/pages/Enquiries.jsx` + `resources.js` | A list filter, `from_email=1` ("Created from email"), derived via `EXISTS` on the decision log, so the team can review them in one view. |
| Enquiry page | One line under the title: "Created automatically from an email on 12 Mar 2026 · open thread". It links to the stored thread when the mailbox shares it. |
| `docs/email-enquiries.md` | **New.** What it does, what is read, what is kept, the settings, and how to switch it off. Add a row to `docs/security.md` for the new data flow to the AI provider. |

---

## 6. Operations and safety

### 6.1 Turning it off

`auto_enquiries_enabled = false` stops both live detection and backfill at
the next run. Nothing already created is removed.

### 6.2 What leaves the server

For a candidate email only: the sender's name, address and domain, the
subject, and the new part of the body (at most about 4,000 characters). It
goes to OpenRouter with zero-retention routing. Nothing goes to the AI
provider for:

- prefiltered mail;
- internal mail;
- blocked senders;
- replies in known threads.

Record this in `docs/security.md`.

### 6.3 Re-running

An admin's **Re-run** on one mailbox clears that mailbox's `not_enquiry`
decisions and backfill progress. Use it after the rules improve or the AI
key is added. `created` and `linked` decisions stay, so nothing duplicates.

### 6.4 Failure handling

- **AI error or timeout:** fall back to rules for that email, recorded as
  `method = 'rules'`.
- **Graph error during backfill:** store `last_error`; the next run resumes
  from `next_link`.
- **Token expiry:** the existing `needs_reconnect` path applies.
- **Staging:** `assertNotStaging` already blocks Microsoft sync, so staging
  never creates enquiries from real mail.

### 6.5 Volume

The live path adds AI calls only for **new conversations started by an
external sender**, which is a handful a day. Backfill is bounded by the
daily AI ceiling.

---

## 7. Build order (one PR each, each shippable)

1. **Groundwork:**
   - extract `lib/ai.js`;
   - extract `createEnquiryFromEmail()` from the convert route (behaviour
     unchanged; the existing `inbox.test.js` passes as is);
   - migration 065.
2. **Detector:** `enquiryDetect.js` with pure tests: prefilter cases, rule
   scores, AI-verdict parsing and clamping, and company names from domains.
3. **Live automation:** candidates from `ingest`, `processCandidates`,
   dedupe, owner, notification. The feature is live for new mail from this
   PR.
4. **Backfill:** `page()`, `mailbox_enquiry_backfills`, the
   `enquiries.backfill` job, time budget, AI ceiling, summary notification.
5. **Admin and review screens:** status endpoint, policy, Mailboxes card,
   enquiries filter, enquiry-page line, docs.

---

## 8. Tests

- **Pure** (`server/test/emailEnquiryRules.test.js`):
  - prefilter: a reply in a known thread, a subject with QT/ENQ/PO, a
    newsletter, an invoice email, a CV, and a genuine RFQ;
  - `ruleScore` with and without enquiry words;
  - `parseVerdict` with bad JSON, out-of-range confidence, our own company
    as `company_name`, and a free-mail domain;
  - `companyNameFromEmail`.
- **Database-backed** (`server/test/emailEnquiries.test.js`, using the
  `test` provider and no AI key, so rules decide):
  1. Personal mailbox, unknown sender, RFQ creates one enquiry. Its company,
     contact (with email) and source are set, the thread is now stored and
     linked, and the decision is logged as `created`.
  2. The same email, also in a shared mailbox, gives one enquiry. The
     second mailbox's thread is linked and logged `linked`, and its inbox
     conversation gets `enquiry_no`.
  3. The client's reply in that thread creates nothing new.
  4. A newsletter, an invoice email and internal mail create nothing.
  5. Backfill reads `history` messages oldest first and creates enquiries
     with the email's date. A second run creates nothing, and an
     interrupted run resumes from `next_link`.
  6. The same sender within 30 days is linked, not duplicated.
  7. With `auto_enquiries_enabled = false`, nothing is created and sync
     results are unchanged.
  8. A metadata-only mailbox still stores no subject or body, but the
     enquiry exists.
  9. A personal mailbox of a sales user makes them the owner; a shared
     mailbox leaves it unowned.
  10. The manual convert route still produces the same enquiry as before.
- **AI path:** inject a fake `chat` function into `decide()` and assert the
  threshold and kind handling. No network calls in CI.
- **Authz:** the new admin routes are refused for sales users.

---

## 9. Still open (defaults given; the build can start with them)

1. **Conversations we started.** Default: phase 1 creates enquiries only
   from conversations the **client** started. A client answering our
   outreach with "yes, please quote" is left to a person. The alternative is
   to let the AI judge replies in threads that we started and that are
   linked to nothing.
2. **Existing clients with an open deal.** Default: a new request from them
   still becomes a new enquiry, unless the subject names a record. This
   keeps repeat business visible in the reports. The alternative is to
   attach it to their open deal, as thread linking does today.
3. **Notification on backfill.** Default: one summary per mailbox. The
   alternative is one notification per enquiry.
