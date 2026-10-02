# New enquiries from email, automatically: implementation plan (phase 1)

Every **active connected mailbox** is read. An email from a client asking for
new work becomes an **enquiry** in the tracker with no one pressing a button.
This includes the **past year of mail**, not only what arrives from now on.

Phase 1 is **new enquiries**, plus one exception. When the first email is
a quotation we sent, and that quotation was made outside the tracker, the
attached PDF is read and the quotation is created as well (§3.8, §3.9).
Phase 1 does not read POs or invoices, and does not handle replies on
deals that already exist.

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
| The enquiry never reached us by email: the first email is **our quotation** to the client (the request came by phone, a meeting, WhatsApp or a colleague) | **An enquiry is still created**, from the quotation email we sent. See §3.8. |
| That quotation was made outside the tracker (Word or Excel, sent as a PDF) | **In this phase**, the attached PDF is read and **the quotation is created in the tracker too**, with its lines, totals and the PDF itself. See §3.9. |

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
   It also judges each **outbound** email that sends a quotation to a client
   in a conversation that has no enquiry yet (§3.8).
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
7. **Reading the quotation PDF** we sent, when the quotation is not in the
   tracker, and creating that quotation with its lines, totals and document
   (§3.9).
8. Tests and documentation.

### Out of scope (say so in the PR)

- Quotations, POs, invoices or payments read from email. Those are later
  phases.
- Attachments on **inbound** mail. A client's RFQ PDF is not opened; only
  the subject and body are read. The one attachment that is read is the
  quotation PDF **we** sent (§3.9).
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
| It is the **first message we know of in its conversation**, and the conversation was started by the client | Phase 1 is *new* enquiries. A reply in a thread that already exists is not one. Outbound quotations follow their own rules in §3.8. |
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
  "kind": "new_enquiry | quotation_sent | reply_or_followup | billing | vendor_or_sales_pitch | marketing | job_application | spam | other",
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
- **Folders:** Inbox first, then Sent Items. Reading all of the Inbox
  before any sent mail means every client-started enquiry already exists
  when the outbound quotations are judged (§3.8), so a quotation that
  answers an emailed enquiry links to it instead of making a second one.
- **Order:** oldest first within each folder, so "first message in the
  conversation" is decided correctly and the same-sender rule links later
  emails to the earlier enquiry.
- **AI pacing:** at most 2 AI calls in flight per run, and a daily ceiling
  on AI calls (setting, default 1,500) so a large backfill cannot run up an
  unbounded bill. When the ceiling is reached, the run stops and resumes
  the next day.
- **Done:** set `finished_at` and send one notification: "Read 365 days of
  sales@…: 42 enquiries created, 9 linked to existing ones."

### 3.7 Live sync changes (`sync.js`)

- `ingest()` gains a return value, `candidates`. It lists messages that
  passed `classify()` and either:
  - are inbound and started a new thread in this call,
  - are outbound and look like a quotation (§3.8), or
  - were dropped as `no matching client`. A personal mailbox drops sent
    mail to an unknown client as well as received mail.
  Each item carries the raw message **in memory** (subject and text) plus
  the stored thread and message ids if they were stored. Nothing extra is
  written by `ingest`.
- `syncAccount()` hands the candidates from both folders to
  `processCandidates(account, candidates)` **after** the ingest transaction.
  Inbox is processed before Sent Items, which is the order `FOLDERS`
  already has.
  AI calls are never made inside a database transaction or while holding a
  thread lock.
- When `auto_enquiries_enabled` is `false`, `processCandidates` returns
  immediately, and sync behaves exactly as it does today.

### 3.8 Edge case: the conversation starts with our quotation

Not every enquiry arrives by email. A client may ask by phone, at a meeting,
on WhatsApp or through a colleague, and the first email anyone sends is the
salesperson's **quotation**. These enquiries must still be in the tracker,
or the reports will undercount enquiries and conversion.

**Which outbound emails are candidates** (pure rules, in `prefilter()`):

| Rule | Why |
| --- | --- |
| Outbound, sent from the mailbox (Sent Items), to at least one external, non-blocked address | Our quotation to a client. |
| **Looks like a quotation:** the subject or body carries one of our quotation numbers (`referencesIn().quotations`), **or** it has an attachment **and** quotation words in the subject or new body text: quotation, quote, proposal, offer, techno-commercial, fee proposal, commercial offer, price | A quotation goes out as a PDF with a covering note. Words alone, with no attachment and no number, are not enough. |
| The conversation has **no enquiry yet**: no `created`/`linked` decision for it, the thread is not linked to an enquiry, and the quotation it names is not already on an enquiry (`enquiries.quotation_no`) | If the client emailed the enquiry first, §3.1 already made it. |
| No more than 5 external recipients | A mail-merge or campaign is not a quotation to one client. |
| Not a forward or reply carrying someone else's quotation to us, and not sent to a vendor (a `travel_vendors` address or a domain that only ever sends us invoices) | A quotation we *received* or forwarded is not one we sent. |

Unlike inbound mail, this does **not** have to be the first message in the
conversation. If our outreach started the thread, the client answered "yes,
please quote", and the quotation went in the same thread, the first
*quotation* in a conversation with no enquiry is the candidate.

**Classification:** the same AI call with `kind = quotation_sent`. It also
extracts the client company (from the recipient and the letter, not from
our signature), the contact (the addressee), the service and, if stated,
the quoted amount and currency. Without AI, the rules above decide on their
own: a quotation number in the subject, or an attachment plus quotation
words, is enough.

**What is created:**

| Case | Enquiry created |
| --- | --- |
| The quotation **is in the tracker** (its number is in the email and matches `quotations.quotation_no`) and no enquiry points at it | An enquiry with `status = 'Converted'`, `quotation_no` set to that quotation and `converted_at` the email date. Client, contact, sector, service and value come from the quotation. Inserting with `quotation_no` already set means `quoteWonEnquiry` creates no second quotation. `enquiry_date` is the quotation's `quotation_date`, or the email date if earlier. |
| The quotation **is not in the tracker** (made in Word or Excel and emailed) | The attached PDF is read and **the quotation is created** (§3.9). The enquiry is then created exactly as in the row above: `Converted`, linked to the new quotation. `enquiry_date` is the email date. The note reads "Quotation sent by email on *date* by *mailbox*; the enquiry itself did not come by email." If the PDF cannot be read well enough (§3.9.5), the enquiry is created as `Contacted` with no quotation, and the owner gets a task to add the quotation. |

In both cases:

- `source_id` is **Other**, not "Inbound email or call". The request
  reached us some other way, and the source says so; the salesperson can
  correct it.
- `first_responded_at` is the email date: the quotation is our response.
- The owner is the person who sent it: the mailbox's user if a salesperson.
  For a shared mailbox, it is the tracker quotation's owner when there is
  one.
- Any client reply later in the thread is linked to the enquiry as normal.

**No duplicates** (in addition to §3.5):

- If the company has an enquiry in `New`/`Contacted`/`Qualified`/`Nurture`
  with **no quotation**, created within `auto_enquiry_same_sender_days`, the
  quotation email is linked to it instead.
  - If the quotation is a tracker quotation, that enquiry's `quotation_no`
    is filled.
  - Its status is not changed automatically; a person moves it on.
- The same quotation sent again, or revised (`…/R1`), gives no second
  enquiry. The conversation, or the quotation number, already has one.

**Decision log:** these rows have `kind = 'quotation_sent'`, so admins can
see how many enquiries came this way.

### 3.9 Reading the quotation PDF and creating the quotation

This applies to the second row of the table in §3.8: we sent a quotation
by email, and it is **not** in the tracker.

#### 3.9.1 Getting the PDF

- **Fetch:** add `attachments(providerId)` to the provider. It calls
  `GET /users/{mailbox}/messages/{id}/attachments`. A file larger than
  about 3 MB is fetched through `/attachments/{id}/$value`. No new Graph
  permission is needed; `Mail.ReadWrite` already covers it. The test
  provider returns attachments pushed with the message.
- **Which file:** only `application/pdf` or `*.pdf`, at most 15 MB. With
  several PDFs, rank them:
  1. a file name with quotation, quote, proposal, offer or our QT pattern;
  2. then the first page's text containing those words;
  3. then the largest.
  Brochures and company profiles are passed over this way.
- **Held in memory only** while being read. The file is stored once, as
  the quotation's document (§3.9.4), and only if a quotation is created.
- **No PDF at all:** the quotation is in the email body. The same
  extraction runs on the body text.

#### 3.9.2 Text out of the PDF

- **Text PDFs** (what Word and Excel export): add `unpdf` (pdf.js, MIT,
  pure JavaScript, no native build) to `server/package.json`. Extract the
  text page by page, at most 10 pages, keeping the reading order.
- **Scanned PDFs** (fewer than about 200 characters of text): send the PDF
  itself to OpenRouter as a `file` content part with the PDF OCR engine.
  This uses the same zero-retention routing. It is counted against the
  daily AI ceiling at the higher per-page cost.
- **Password-protected or unreadable:** go to the fallback in §3.9.5.

#### 3.9.3 Extracting the quotation (AI, validated in code)

One AI call with the PDF text and the covering email returns:

```jsonc
{
  "quotation_no_printed": "CV/Q/2025/045",   // as written on the document, or null
  "revision": 0,                                // "Rev 1", "R2" → 1, 2
  "quotation_date": "2025-11-04", "valid_until": "2025-12-04",
  "client": { "company_name": "…", "gstin": "…", "state": "…", "country": "…", "contact_name": "…" },
  "currency": "INR",
  "lines": [ { "description": "…", "qty": 1, "unit": "lot", "rate": 250000, "discount_percent": 0, "gst_rate": 18, "service": "EcoVadis" } ],
  "subtotal": 250000, "tax_total": 45000, "total": 295000,
  "terms": "payment and validity terms, as written",
  "confidence": 0.0-1.0
}
```

The model proposes and **code decides**. These checks all live in a pure
module:

| Check | Rule |
| --- | --- |
| **The client is not us** | `company_name` is not Cetizion and not an internal domain. The client is the addressee, never the letterhead. |
| **Numbers are numbers** | qty is above 0, rate is 0 or more, discount is 0–100, GST is 0–100, and the currency is a known code. Indian-format amounts are parsed by code from the text the model quotes back ("2,50,000"), not trusted as given. |
| **Lines add up** | The sum of line amounts must equal `subtotal`, and subtotal + tax must equal `total`, each within ₹1 or 0.5%. |
| **Dates** | `quotation_date` is on or before the email date, and no more than 60 days earlier. `valid_until` is after `quotation_date`. If either fails, the email date is used and validity is left blank. |
| **Service** | Each line's `service` is mapped to the `services` catalogue by name and code. `service_id` is set only on an exact or alias match, never guessed. |

#### 3.9.4 What is created

The quotation, in the same transaction as the enquiry:

| Quotation column | Value |
| --- | --- |
| `quotation_no` | The **printed number**, if there is one and it is not already used in the tracker. The client's later emails quote that number, so keeping it is what lets `referencesIn()` link them. If there is no number, or it clashes, a new one is taken with `claimNextId('quotation', db, year)` and the printed one is kept in `remarks`. A printed number in the tracker's own pattern (`CTZ/QT/{year}/{n}`) must also move that series' counter past it, so the tracker never issues the same number later. Check how `claimNextId` keeps its counter and do this in the same transaction. |
| `quotation_date`, `valid_until`, `revision`, `currency`, `terms`, `place_of_supply_state` | From the extraction, after the checks. |
| `client_name`, `contact_person`, `sector`, `country` | Same company and contact as the enquiry, so both link to the same `company_id`/`contact_id` through the triggers. |
| `status` / stage | `Submitted`, stage **Sent**, `sent_at` the email's sent time. This is the same state a tracker quotation reaches when it is sent. |
| `service_quoted` | The line services joined, or the extracted service. |
| `owner_user_id`, `sales_person` | The sender (§3.8), with the same rule as the enquiry. |
| **Lines** | If the lines **add up**, insert `quotation_lines`. The `quotation_totals()` trigger then sets `subtotal`, `tax_total`, `total` and `quotation_value` from the lines, exactly as for a quotation built in the tracker. |
| **No lines** | If they **do not add up**, insert no lines. Set `subtotal`, `tax_total`, `total` and `quotation_value` from the printed totals. **These totals must never be overwritten with zero or blank** while the quotation has no lines (confirmed by the product owner; see §3.9.7). The quotation page then says "Lines could not be read; totals are from the PDF". |
| `document_id` | The PDF, stored through `lib/documents.js` under owner `quotations`, so it opens from the quotation page like any uploaded document. If document storage (Cloudinary) is not configured, the quotation is still created, without a document. |
| `remarks` | "Read from the PDF emailed to *client* on *date* by *mailbox*." Plus the printed number, if it was replaced. |

**Revisions:** a later email can carry a PDF with the **same printed
number** and a higher revision, or a "Rev"/"R1" suffix. That is not a new
quotation:

- the existing quotation goes through the tracker's normal revision path,
  so the previous version is kept as a revision snapshot;
- then its lines, totals, date and document are replaced;
- `revision` is bumped.

Nothing new is created, and the decision is logged as `linked`.

**Repeat sends:** the same PDF sent again, with the same number and
revision, creates nothing. The message is logged as `linked` to the
existing quotation.

The decision log gets a `quotation_no` column (§4.1), so every quotation
read from email can be found and checked.

#### 3.9.5 When the PDF cannot be trusted

The quotation is **not** created when any of these hold:

- the extraction confidence is below `auto_quotation_min_confidence`
  (default 0.8);
- there is no client company, or it resolves to us;
- there is no total, and no lines that add up.

In that case:

- the enquiry is still created, as `Contacted`, with the estimated value
  from the email if one was found;
- the owner gets a **task**, due the next working day: "Add the quotation
  sent to *client* on *date*: the PDF could not be read". It links to the
  email thread.
- the decision row records `quotation_extraction = 'failed'` and the
  reason code (`no_pdf`, `encrypted`, `low_confidence`, `no_client`,
  `no_total`). No text from the PDF is stored.

#### 3.9.6 Review

- **Quotations list:** a filter "Read from email", derived from the
  decision log.
- **Quotation page:** a banner, "Read automatically from the PDF sent on
  *date*. Check the lines and totals.", with a link to the document and to
  the email. **Mark checked** writes an activity log entry and hides the
  banner. That is an event, so it is stored, the same way the activity log
  already is.

#### 3.9.7 Keeping the PDF's totals when there are no lines (requirement)

**Confirmed requirement:** a quotation created from a PDF with **no lines**
keeps the subtotal, tax and total read from the PDF. Nothing may overwrite
them with zero or blank while it has no lines.

**Why this needs a change.** `quotation_totals()` (`server/db/schema.sql`,
"quotation totals") handles a quotation with no lines like this:

```sql
IF n = 0 THEN
  UPDATE quotations SET subtotal = NULL, tax_total = NULL, total = NULL, discount_percent = NULL, …
```

It keeps `quotation_value` but **blanks the other three totals**. It runs:

- from the `quotation_lines_changed` trigger, when any line is inserted,
  updated or deleted. For example, someone adds a line on the quotation
  page and then removes it.
- directly from `POST /api/quotations/:key/revise`
  (`server/src/routes/quotations.js`), on **every** revision, including a
  revision of a PDF quotation that still has no lines.

A plain insert with no lines never fires it, so the totals survive
creation. They would be lost on the first revision, or the first time a
line is added and removed.

**The change.** In the `n = 0` branch, leave `subtotal`, `tax_total`,
`total` and `quotation_value` **untouched** when the quotation's totals
came from a document. Every other quotation behaves exactly as today.

**"Came from a document" is derived, not stored.** It is true when the
decision log has a row for that quotation with
`quotation_extraction IN ('created','revised')`. No new column goes on
`quotations`:

```sql
IF n = 0 THEN
  IF EXISTS (SELECT 1 FROM email_enquiry_decisions d
              JOIN quotations q ON q.quotation_no = d.quotation_no
             WHERE q.id = p_quotation AND d.quotation_extraction IN ('created','revised')) THEN
    -- totals were read from the PDF: they stand until real lines replace them
    UPDATE quotations SET discount_percent = NULL, approval_status = … WHERE id = p_quotation;
    RETURN;
  END IF;
  … existing behaviour …
```

The function is redefined in migration 065 and in `schema.sql`. It is
plpgsql, so referring to `email_enquiry_decisions` (which is created later
in the file) resolves when it runs.

**When lines are added later** (someone types them in from the PDF), the
lines take over, as for any quotation: totals and `quotation_value` follow
the lines. If all of those lines are then deleted, the quotation goes back
to **the PDF's totals**, not to blank. To make that possible:

- keep the PDF's figures in the quotation's first revision snapshot. The
  revision path already stores `subtotal`, `tax_total`, `total` and
  `quotation_value` in `quotation_revisions.snapshot`.
- have `createQuotationFromEmail` write that snapshot (revision 0, note
  "Read from PDF") at creation.
- in the `n = 0` branch, restore the four values from the latest snapshot
  noted "Read from PDF".

**Revising a PDF quotation with no lines** keeps the totals: the new
version starts with the same figures until a new PDF or real lines change
them.

**A newer PDF revision** (§3.9.4, "Revisions") replaces the totals with the
new PDF's figures, and writes a new "Read from PDF" snapshot.

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
  -- §3.9: the quotation read from the PDF we sent, and how that went.
  quotation_no        text REFERENCES quotations(quotation_no) ON UPDATE CASCADE ON DELETE SET NULL,
  quotation_extraction text CHECK (quotation_extraction IN ('created','revised','failed')),
  extraction_reason   text,
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
  ('auto_enquiry_daily_ai_limit', '1500', '…'),
  ('auto_quotation_min_confidence', '0.8', '…')
ON CONFLICT (key) DO NOTHING;
```

- **`quotation_totals()` is redefined** in this migration, as in §3.9.7.
  A quotation with no lines whose totals came from a PDF keeps them.
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
| `server/package.json` | Add `unpdf` (§3.9.2). |
| `server/src/lib/mailbox/quotationPdf.js` | **New.** Pick the PDF, extract its text, call the AI, and run the pure checks in §3.9.3 (`checkExtraction()`, `parseAmount()`, `linesAddUp()`). |
| `server/src/lib/mailbox/autoQuotation.js` | **New.** `createQuotationFromEmail(db, …)`: the number rule, insert, lines or printed totals plus the "Read from PDF" snapshot (§3.9.7), document, the revision path, and the fallback task. |
| `server/db/schema.sql` + migration 065 | Redefine `quotation_totals()` so that a PDF quotation with no lines keeps its totals (§3.9.7). |
| `server/src/lib/mailbox/microsoft.js` | `attachments(providerId)`, as well as `page()`. |
| `web/src/pages/Quotations.jsx`, `QuotationDetail.jsx` | The "Read from email" filter, and the review banner with **Mark checked**. |
| `docs/email-enquiries.md` | **New.** What it does, what is read, what is kept, the settings, and how to switch it off. Add a row to `docs/security.md` for the new data flow to the AI provider. |

---

## 6. Operations and safety

### 6.1 Turning it off

`auto_enquiries_enabled = false` stops both live detection and backfill at
the next run. Nothing already created is removed.

### 6.2 What leaves the server

For a candidate email only: the sender's name, address and domain, the
subject, and the new part of the body (at most about 4,000 characters). It
goes to OpenRouter with zero-retention routing.

For a quotation we sent that is not in the tracker, the **quotation PDF's
text** also goes, at most 10 pages. For a scanned PDF, the file itself
goes, for OCR. This is our own commercial document, with the client's name
and the prices.

Nothing goes to the AI provider for:

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
5. **Quotations from PDFs** (§3.9): `attachments()`, `unpdf`,
   `quotationPdf.js`, `autoQuotation.js`, revisions, the fallback task. The
   checks are tested first, with no network.
6. **Admin and review screens:** status endpoint, policy, Mailboxes card,
   enquiries and quotations filters, the enquiry-page line, the
   quotation-page banner, docs.

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
  11. **Quotation first, tracker quotation:** an outbound email naming an
      existing QT number, with no enquiry, creates a `Converted` enquiry
      linked to that quotation. No second quotation is made, and the client's
      reply joins it.
  12. **Quotation first, outside the tracker:** an outbound email with a PDF
      and "please find our quotation" creates a `Contacted` enquiry with
      source Other. A plain outbound email with no attachment and no number
      creates nothing.
  13. **Inbound enquiry, then quotation in a new thread:** this gives one
      enquiry. The quotation email links to the open enquiry, and its
      `quotation_no` is filled.
  14. **Backfill order:** with both folders in history, the Inbox enquiry is
      created first and the later quotation links to it.
  15. A campaign to 20 recipients with "offer" in the subject creates
      nothing.
  16. **PDF read, lines add up:** an outbound email with a text PDF, using
      a fake AI that returns lines matching the totals, creates a
      `Submitted` quotation on the Sent stage. It keeps the printed number,
      the totals come from the lines, the document is attached, and a
      `Converted` enquiry points at it.
  17. **Lines do not add up:** no lines are inserted, the totals are the
      printed ones, and the banner says so.
  17a. **The PDF's totals survive** (§3.9.7). On a PDF quotation with no
      lines:
      - `POST /api/quotations/:key/revise` leaves `subtotal`, `tax_total`,
        `total` and `quotation_value` exactly as printed, never 0 or NULL;
      - adding a line makes the totals follow that line;
      - deleting it brings back the PDF's figures.
  17b. **Nothing else changes.** A tracker-built quotation with no lines
      still gets blank totals from `quotation_totals()`, as today. The
      existing quotation and revision tests pass unchanged.
  18. **Clashing printed number:** a new tracker number is used, the
      printed one goes in `remarks`, and a printed number in the CTZ
      pattern moves the counter past it.
  19. **Revision:** the same printed number with "Rev 1" revises the
      existing quotation (a snapshot is kept and `revision` is 1). Nothing
      new is created.
  20. **Unreadable:** an encrypted PDF, or low confidence, gives a
      `Contacted` enquiry, no quotation, a task for the owner, and the
      decision is logged `failed` with its reason.
  21. **Two PDFs:** a brochure and a quotation; the quotation is chosen.
- **Pure** (`server/test/quotationPdf.test.js`): `parseAmount("2,50,000.00")`,
  `linesAddUp` tolerances, the date checks, the client-is-us check, and PDF
  ranking by name and first page.
- **AI path:** inject a fake `chat` function into `decide()` and assert the
  threshold and kind handling. No network calls in CI.
- **Authz:** the new admin routes are refused for sales users.

---

## 9. Still open (defaults given; the build can start with them)

1. **Number for a quotation read from a PDF.** Default: keep the printed
   number when it is free, so the client's replies link to it, and
   otherwise take a tracker number. The alternative is to always give it
   a tracker number and keep the printed one in remarks.
2. **Existing clients with an open deal.** Default: a new request from them
   still becomes a new enquiry, unless the subject names a record. This
   keeps repeat business visible in the reports. The alternative is to
   attach it to their open deal, as thread linking does today.
3. **Notification on backfill.** Default: one summary per mailbox. The
   alternative is one notification per enquiry.
