# Inbox like Outlook on the web: implementation plan

The tracker's Inbox today is a **triage queue for the shared sales
mailbox**. It has a list, a reading pane, assign, snooze and close, and a
plain-text reply that is always reply-all. It cannot:

- write a new email, forward, or choose between reply and reply all;
- edit To or Cc, or send or download attachments;
- show your own mailbox;
- reflect anything done in Outlook (read, flagged, moved, deleted), or
  push its own actions back to Outlook.

This plan makes the Inbox work like **Outlook on the web** in three ways
the product owner chose:

1. **Full compose:** new email, reply, reply all and forward; editable
   To, Cc and Bcc; rich text; attachments in and out; signatures; drafts.
2. **Two-way sync with Outlook:** read and unread, flags, delete, move and
   archive, done in either place, show in both.
3. **Personal mailboxes in the Inbox:** each person sees their own
   connected mailbox, with all its folders, as well as the shared inbox.

The full **3-pane layout with a command bar** was not chosen. The current
two-column layout (list and reading pane) stays. It gains a **mailbox and
folder switcher** above the list, and **action buttons** in the reading
pane, which personal mailboxes and two-way sync need. A full folder pane
and command bar can follow later (§9).

This file is written for the person (or Claude Code session) who builds it.
Read [PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md),
[per-user-mailboxes-plan.md](per-user-mailboxes-plan.md) (**build that
first**: personal mailboxes need its ownership and access rules) and
[docs/security.md](security.md). It was written against commit `d764c56`.
**Plan only; no code in this step.**

---

## 1. What exists today

| Piece | Where | Notes |
| --- | --- | --- |
| Page | `web/src/pages/Inbox.jsx` | Two columns (`lg:grid-cols-[400px_1fr]`): list (`ThreadRow`, search, Open / Mine / Done, `Pager` of 50) and reading pane (`Conversation`). Polls sync every 60 s and refreshes every 20 s. Arrow keys move through the list. |
| Message view | `Inbox.jsx` `Message`, `MailBody` | Sandboxed iframe, images blocked until asked, quoted history collapsed. **Does not show To, Cc or attachments.** |
| Reply | `POST /api/inbox/:id/reply` → `sync.js` `replyToThread` | Plain-text textarea, canned responses, signature, **always reply-all**, to the latest message. |
| Other mail views | `components/EmailThread.jsx` (dialog on records) | Shows To and Cc and an "attachments" badge; reply-all only. |
| Data | `email_threads`, `email_messages`, `inbox_conversations` (shared-inbox triage) | `email_messages` has **no** folder, read state, flag, importance, Bcc, web link or attachment list (only `has_attachments`). |
| Sync | `sync.js` (every 60 s, every folder since #181), `microsoft.js` | Delta per folder. **A known message is skipped**, so later read, flag or move changes are lost. `@removed` (delete or move) is ignored. Push subscriptions cover Inbox and Sent Items only. Junk, Deleted, Drafts and Outbox are skipped. |
| Graph | `microsoft.js` | `reply` and `replyAll` (comment only), `send` (no attachments, unused), `attachments` (readers only). Scopes `Mail.ReadWrite(.Shared)` and `Mail.Send(.Shared)` **already allow everything this plan needs**, so there is no new consent. |
| Privacy | `connected_accounts.visibility` (`metadata`, `subject`, `share_everything`), `readable` / `readableThread` / `mayAdminister`, `inboxScope` | Visibility is applied at ingest and on read. |

**Gaps already found that this plan fixes on the way:**

- `PATCH /api/inbox/:id` updates **without** `inboxScope`, so a user can
  change a conversation they cannot see.
- `/api/mail/threads/:id` lets any user read any shared-mailbox thread,
  ignoring inbox membership.
- `inboxScope` matches members case-sensitively, while MCP's `listInbox`
  is case-insensitive.

---

## 2. Scope

### In scope

1. **Mailbox and folder switcher**, with unread counts:
   - the shared inbox (triage view, as today);
   - **My mailbox:** Inbox, Sent Items, Drafts, Archive, Deleted Items, and
     the person's own folders;
   - admins also see other people's mailboxes, but only within the access
     rules of the per-user mailbox plan.
2. **Reading pane:**
   - From, To and Cc;
   - an attachments strip with download and preview;
   - inline images that resolve (`cid:`);
   - importance and flag;
   - **Open in Outlook**.
3. **Actions, mirrored to Outlook:** Reply, Reply all, Forward, Mark read
   or unread, Flag, Move to folder, Archive, Delete (to Deleted Items),
   Delete permanently (from Deleted Items only).
4. **Full compose:**
   - new email, reply, reply all, forward;
   - To, Cc and Bcc with address suggestions;
   - subject, a rich-text body, importance, signature;
   - attachments up to 25 MB;
   - drafts saved to Outlook's Drafts folder;
   - canned responses kept.
5. **Two-way sync:** changes made in Outlook (read, flag, move, delete,
   new folders) show in the tracker within a minute, and actions in the
   tracker go to Outlook first.
6. **Personal mailboxes:** each person's own mailbox in the Inbox. The
   owner can read their mail in full even when the mailbox stores only
   metadata (§3.4).
7. Small keyboard set: `r` reply, `a` reply all, `f` forward, `n` new,
   `u` unread, `Del` delete, `Ctrl+Enter` send.
8. The three access gaps in §1.

### Out of scope (later, see §9)

- The full 3-pane layout and command bar, conversation-versus-message
  view toggle, Focused/Other, categories, rules, calendar invites
  (shown as plain mail), read receipts.
- Search inside message bodies across all mailboxes (§9).
- Virus scanning of attachments (Exchange Online already scans mail; the
  tracker never opens attachments in the browser, §3.3).

---

## 3. How it works

### 3.1 Data (migration `075_inbox_outlook.sql`, after `074`)

New columns on `email_messages`. All of them are **facts from the
provider**, overwritten on each sync and never computed:

| Column | From Graph | Use |
| --- | --- | --- |
| `folder_id` | `parentFolderId` | Which folder the message is in now. |
| `is_read` | `isRead` | The mailbox's own read state (Outlook's, per mailbox). |
| `flag_status` | `flag.flagStatus` (`notFlagged`, `flagged`, `complete`) | Flag. |
| `importance` | `importance` | `low`, `normal`, `high`. |
| `web_link` | `webLink` | **Open in Outlook** (also used by the MIS plan). |
| `bcc_emails` | `bccRecipients` | Only present on mail we sent. |
| `removed_at` | `@removed` with no reappearance elsewhere | Deleted in Outlook (§3.5). |

New tables:

```sql
-- The folders of each mailbox, as Outlook has them.
CREATE TABLE mail_folder_list (
  account_id     int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  folder_id      text NOT NULL,           -- Graph id (immutable id, §3.5)
  parent_id      text,
  display_name   text NOT NULL,
  well_known     text,                    -- inbox, sentitems, drafts, archive, deleteditems, junkemail
  unread_count   int NOT NULL DEFAULT 0,  -- Outlook's own count
  total_count    int NOT NULL DEFAULT 0,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, folder_id)
);

-- What is attached to a message. Metadata only: the file stays in Outlook
-- and is fetched when someone downloads it.
CREATE TABLE email_attachments (
  id            serial PRIMARY KEY,
  message_id    int NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  provider_id   text NOT NULL,          -- Graph attachment id
  name          text NOT NULL,
  content_type  text,
  size_bytes    int,
  is_inline     boolean NOT NULL DEFAULT false,
  content_id    text,                   -- for cid: images
  UNIQUE (message_id, provider_id)
);
```

The folder and attachment metadata follow the mailbox's visibility:

- `metadata`: folder names are kept (they are the mailbox's structure, not
  its content), but attachment **names** are not stored;
- `subject` and `share_everything`: names are stored.

### 3.2 Who sees which mailbox

This uses the access helper from
[per-user-mailboxes-plan.md](per-user-mailboxes-plan.md) §4.2.

| Mailbox | Who sees it in the Inbox |
| --- | --- |
| Shared mailbox with an inbox (sales@) | The inbox members, as today (`inboxScope`, made case-insensitive). The triage view (owner, snooze, close, the enquiry suggestion) stays exactly as it is. |
| Shared mailbox without an inbox | Admins, plus users the admin adds as delegates (the per-user plan's delegate rule). |
| A person's own mailbox | **The owner only.** Admins can open it only if the per-user plan's rule allows (default: admins see the folder list and metadata, not bodies, unless the owner set `share_everything`). |

Every new route goes through that helper, and it is listed in
`lib/authz/policy.js` with the `mailbox-owner` or `mailbox-delegate`
restriction. The authz e2e checks each one.

### 3.3 Reading

**List:** `GET /api/mail/folders/:accountId/:folderId/messages?q&unread&flagged&page`.

- One row per **conversation**, newest first, as Outlook groups by default.
  The newest message in the folder represents the conversation.
- Each row shows:
  - unread (bold, with a dot);
  - a flag toggle on hover;
  - a paperclip;
  - importance;
  - from or to (in Sent Items);
  - subject and snippet (subject to visibility);
  - time.
- `q` searches subject, sender, recipients and company, as today. Body
  search is out of scope (§9).
- The shared inbox keeps its own `GET /api/inbox` (triage view) and gains
  the same row details.

**Message:** `GET /api/mail/messages/:id` returns:

- From, To, Cc (and Bcc on our own sent mail);
- importance, flag, `web_link`;
- the attachment list;
- the body.

The body comes from storage when the mailbox stores it. Otherwise:

- **Live read for the owner:** if the viewer **owns** the mailbox and the
  mailbox stores only metadata or subjects, the body is fetched **live
  from Graph** for that request. It is sanitised with `cleanHtml` and
  returned, **never stored**. This is how Outlook shows the owner their
  own mail, and it keeps the stored data within the visibility the owner
  chose.
- Anyone else sees only what is stored.

**Opening marks it read**, as Outlook does: after the message has been
open for 2 seconds, the client calls `PATCH … { is_read: true }`. The
behaviour is the same in a shared mailbox (Outlook's shared read state).
The inbox's team-wide `first_opened_at` stays as the "has anybody looked"
marker for triage.

**Attachments:**

- `GET /api/mail/messages/:id/attachments/:attId` streams the file from
  Graph (`/messages/{id}/attachments/{att}/$value`), with
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`
  and a 25 MB cap.
- PDFs and images can be previewed in a new tab with
  `Content-Disposition: inline`. The page serves them with a strict CSP
  and sandbox, so nothing runs in the app's origin.
- **Inline images:** `GET /api/mail/messages/:id/inline/:contentId`
  returns the `cid:` image. `mailFrame.js` rewrites `cid:` sources to that
  URL, and `framePolicy` allows that one path in `img-src`. Remote images
  stay blocked until "Show images", as today.

### 3.4 Actions (tracker → Outlook)

Every action calls **Graph first**. Only on success is the stored message
updated. A failure shows an error toast and changes nothing. There is no
tracker-only mail state, apart from the shared inbox's triage fields
(owner, snooze, status), which are the tracker's own.

| Action | Route | Graph |
| --- | --- | --- |
| Mark read or unread | `PATCH /api/mail/messages/:id { is_read }` | `PATCH /messages/{id} { isRead }` |
| Flag, complete, clear | `PATCH … { flag_status }` | `PATCH … { flag: { flagStatus } }` |
| Move to folder | `POST /api/mail/messages/:id/move { folder_id }` | `POST /messages/{id}/move { destinationId }` |
| Archive | `… /move { folder_id: 'archive' }` | Same, to the well-known `archive` folder. |
| Delete | `… /move { folder_id: 'deleteditems' }` | Same, to Deleted Items. |
| Delete permanently | `DELETE /api/mail/messages/:id` (only when in Deleted Items, with a confirmation) | `DELETE /messages/{id}` |
| Whole conversation | The same routes with `?conversation=1` | One call per message, through the same helper. |

What a record keeps when mail is moved or deleted:

- A **move** does not change the record links: the thread stays linked to
  its enquiry, quotation or PO.
- A **delete** hides the message from the Inbox. The record timeline still
  shows that the email existed ("deleted in Outlook", with no body).
- Deleting mail **never deletes a record**.

### 3.5 Outlook → tracker (sync changes in `sync.js` and `microsoft.js`)

1. **Immutable ids.**
   - Send `Prefer: IdType="ImmutableId"` on every Graph call, so a
     message keeps its id when moved.
   - Translate the stored `provider_id`s once with Graph's
     `translateExchangeIds` (a one-off script, batched 1,000 at a time,
     run per mailbox).
   - Until a mailbox is translated, keep today's Internet-Message-ID
     matching.
2. **Known messages are updated, not skipped.**
   - When delta returns a message already stored, update `folder_id`,
     `is_read`, `flag_status` and `importance` (and the body, if
     visibility allows and it changed).
   - Today `ingestOne` treats it as "already synced" and drops the
     change.
   - Updates do **not** go to the email readers again: only new messages
     are queued for them.
3. **`@removed`.** When delta reports a message removed from a folder, do
   not act at once. Wait for the same immutable id to appear in another
   folder; that is a move, so update `folder_id`. If it does not appear
   within 10 minutes, set `removed_at`.
4. **Folders.**
   - Refresh `mail_folder_list` with each sync (`provider.folders()`,
     already cached for 15 minutes), including counts.
   - A new folder created in Outlook appears in the switcher at the next
     sync.
   - A folder deleted in Outlook disappears; its messages arrive as
     `@removed` and move to Deleted Items.
5. **Deleted Items, Drafts and Junk.**
   - Sync them **for display only**: they appear in the switcher, and a
     user can restore from Deleted Items.
   - Keep them **out of the email readers**, which is today's
     `SKIPPED_FOLDERS` rule, now applied to the readers rather than to
     sync.
   - Drafts are listed live from Graph (§3.6), not stored.
6. **Push.**
   - Subscribe to `created,updated,deleted` on Inbox, Sent Items and
     Archive (today it is `created` on Inbox and Sent Items only), so read
     and flag changes made in Outlook show in seconds.
   - The 60-second delta sweep covers every other folder.
7. **Counts.** The switcher's unread counts are Outlook's own
   (`unreadItemCount`), so the tracker and Outlook always agree.

### 3.6 Compose

**Where it opens:**

- in the reading pane, for a reply or forward;
- as a full-pane composer, for a new email;
- full screen on a phone.

**Fields:**

- **From:** the mailbox being viewed. A person can send only from a
  mailbox they may **reply** from (`readable` today, the per-user helper
  later). In the shared inbox this is sales@.
- **To, Cc, Bcc:** chips with suggestions from `contacts` (name and
  email) and recent recipients in that mailbox. Addresses are validated.
  Bcc is behind a "Bcc" link, as in Outlook.
- **Subject:** "RE:" or "FW:" is filled in on replies and forwards.
- **Body:** a rich-text editor (Tiptap, MIT licence; or an equivalent
  already in the build). It supports bold, italic, underline, lists, links
  and pasted tables. On reply or forward, the original is quoted below in
  Outlook's own format, built by Graph (§ below), not by the tracker.
- **Signature:** the shared inbox's signature (`inboxes.signature`), or
  the person's own (a new user setting, `mail_signature`). It is added
  once and can be edited.
- **Attachments:** drag and drop or pick, up to 25 MB per message.
  - Files of 3 MB or less are sent inline.
  - Larger files use Graph's upload session (`createUploadSession`).
  - Forward keeps the original's attachments (Graph includes them).
  - A tracker document (a quotation PDF, an invoice) can be attached from
    the record. This is a picker over `documents` the user can reach.
- **Importance**, and **canned responses** (kept from today).
- **Do not contact:** if any recipient is a contact marked do-not-contact,
  sending is refused, as replies are today.

**Drafts in Outlook, not in the tracker:**

| Step | Graph |
| --- | --- |
| New email | `POST /messages` (creates a draft in Drafts) |
| Reply, Reply all, Forward | `POST /messages/{id}/createReply` / `createReplyAll` / `createForward`. Graph builds Outlook's own quoted header and threading. |
| Autosave every 10 s and on blur | `PATCH /messages/{draftId}` (recipients, subject, body, importance) |
| Attachments | `POST /messages/{draftId}/attachments` or an upload session |
| Send | `POST /messages/{draftId}/send` |
| Discard | `DELETE /messages/{draftId}` |

So a draft started in the tracker is in Outlook's Drafts, and can be
finished in either place. The Drafts folder in the switcher lists drafts
live from Graph.

**After sending:**

- the message is pulled back from Sent Items, as `replyToThread` does
  today, and stored with `sent_from_tracker_by`;
- the shared inbox clock and owner rules apply as before;
- the HTML body is sanitised on the server (`cleanHtml`) **before** it is
  sent, so the editor cannot send script or forms.

**Routes:**

- `POST /api/mail/drafts { account_id, kind: 'new'|'reply'|'replyAll'|'forward', source_message_id? }`
- `PATCH /api/mail/drafts/:id`
- `POST /api/mail/drafts/:id/attachments`
- `POST /api/mail/drafts/:id/send`
- `DELETE /api/mail/drafts/:id`
- `GET /api/mail/drafts?account_id`

`POST /api/inbox/:id/reply` stays for the quick reply box and canned
responses. Internally it becomes "create reply, fill, send".

### 3.7 The page

The existing two columns stay. Above the list is a **mailbox and folder
switcher**, a dropdown on the list header:

```
[ Sales inbox (team) ▾ ]   ← shared inbox: Open / Mine / Done, as today
  ─────────────
  Sales inbox (team)          12
  My mailbox
    Inbox                      5
    Sent Items
    Drafts                     2
    Archive
    Deleted Items
    Clients ▸ Hindalco         1   ← the person's own folders, nested
```

- **List rows** show unread, flag, paperclip and importance (§3.3).
  Selecting several rows (Shift or Ctrl click, and a checkbox on hover)
  allows Mark read, Flag, Move and Delete together.
- **Reading pane header:** subject; **Reply · Reply all · Forward** (the
  primary group); **Mark unread · Flag · Move ▾ · Archive · Delete**;
  **Open in Outlook**. In the shared inbox, Owner, Snooze and Close stay
  next to them.
- **Messages** show From, To and Cc (expandable), time, importance, flag
  and the attachments strip.
- **Compose** opens in the reading pane, with a **New email** button at
  the top of the list.
- **URL state:** `?mb=<accountId>&f=<folderId>&m=<messageId>`, so a link
  opens the same mailbox, folder and message. The search `q` moves into
  the URL too.
- **Phone:** list, then message, then compose, each full screen with
  Back.

Each piece is its own component in `web/src/components/mail/`:
`MailboxSwitcher`, `MessageList`, `MessageRow`, `ReadingPane`,
`MessageHeader`, `AttachmentStrip`, `Composer`, `RecipientInput`,
`RichTextEditor`, `MoveMenu`. That keeps `Inbox.jsx`, now 900 lines, from
growing further.

---

## 4. Files

| File | Change |
| --- | --- |
| `server/db/migrations/075_inbox_outlook.sql`, `schema.sql`, `scrub.sql` | §3.1. `scrub.sql` nulls attachment names and `web_link`. |
| `server/src/lib/mailbox/microsoft.js` | Immutable-id header; `$select` adds `parentFolderId,isRead,flag,importance,webLink,bccRecipients`; new `update(id, patch)`, `move(id, dest)`, `remove(id)`, `createDraft`, `createReply(All)`, `createForward`, `updateDraft`, `addAttachment` (inline or upload session), `sendDraft`, `deleteDraft`, `listDrafts`, `attachmentList`, `attachmentStream`, `messageLive(id)`, `translateIds`; folder counts; subscriptions for `created,updated,deleted`. |
| `server/src/lib/mailbox/sync.js` | Store the new columns; **update** known messages; the `@removed` and move rule; `mail_folder_list`; Deleted Items, Drafts and Junk synced for display but excluded from the readers; attachment metadata at ingest. |
| `server/src/lib/mailbox/mailActions.js` | **New.** Graph-first actions with local update, and the conversation-wide variant. |
| `server/src/lib/mailbox/compose.js` | **New.** Drafts, recipients validation, signature, do-not-contact check, `cleanHtml` on send, and the pull-back after sending. |
| `server/src/routes/mail.js` | **New** (or extend `mailThreadRouter`): folders, list, message, live read, attachments, inline, actions, drafts. |
| `server/src/routes/inbox.js` | Scope the `PATCH` update with `inboxScope`; case-insensitive members; row details. |
| `server/src/routes/mailboxes.js` | `/mail/threads/:id` respects inbox membership. |
| `server/src/lib/authz/policy.js` | Every new route. |
| `scripts/translate-mail-ids.js` | **New.** A one-off per mailbox (§3.5). |
| `web/src/pages/Inbox.jsx` | Uses the new components. URL state. |
| `web/src/components/mail/*` | **New** components (§3.7). |
| `web/src/lib/mailFrame.js` | Rewrites `cid:` to the inline route; that path is allowed in the CSP. |
| `web/package.json` | Add the rich-text editor (e.g. `@tiptap/react`, `@tiptap/starter-kit`, link extension). |
| `docs/inbox.md` | **New** user doc. Add a `docs/security.md` row for attachment download and preview, and the owner's live read. |

---

## 5. Safety

- **One source of truth for mail state: Outlook.** The tracker never keeps
  a read, flag or folder state that Outlook does not have.
- **Access:** every route checks the mailbox access helper. A person can
  act only on mailboxes they may read, and send only from mailboxes they
  may reply from. Permanent delete needs the message to be in Deleted
  Items, plus a confirmation.
- **Content:**
  - outgoing HTML is sanitised on the server;
  - incoming mail stays in the sandboxed iframe with the strict CSP;
  - attachments are downloaded with `nosniff`, previewed in a separate
    sandboxed page, and never rendered in the app's origin.
- **Visibility:** what is stored still follows each mailbox's setting. The
  live read (§3.3) is for the **owner only** and stores nothing.
- **Rate limits:** Graph allows about 10,000 requests per 10 minutes per
  mailbox. Bulk actions are batched with Graph's `$batch` (20 per call),
  and a whole-conversation delete of 50 messages is 3 calls.

---

## 6. Build order (one PR each, each shippable)

0. **The per-user mailbox plan** (ownership and the access helper). This
   is a prerequisite.
1. **Sync foundations:**
   - immutable ids and the translate script;
   - the new columns;
   - updating known messages;
   - `@removed` and moves;
   - folders with counts;
   - attachment metadata;
   - Deleted, Drafts and Junk for display only.

   Plus the three access fixes from §1. The current UI is unchanged.
2. **Reading:**
   - the folder and message routes;
   - the owner's live read;
   - attachments download and preview;
   - inline images.

   The UI gets the mailbox and folder switcher, To and Cc, the attachment
   strip and Open in Outlook.
3. **Two-way actions:** read and unread, flag, move, archive, delete, with
   multi-select, the reading-pane buttons and the keyboard set.
4. **Compose:** drafts in Outlook, reply, reply all, forward, new email,
   recipients, rich text, signature, attachments out, tracker documents as
   attachments. The quick reply moves onto the drafts path.
5. **Push and polish:** subscriptions for `created,updated,deleted`, phone
   layout, user docs.

---

## 7. Tests

- **Pure:**
  - `@removed`-then-reappear decides "move";
  - no reappearance decides "deleted";
  - recipient parsing and validation;
  - `cid:` rewrite;
  - signature insertion (only once).
- **Database-backed** (test provider extended with folders, read and flag
  state, moves, removes, drafts and attachments):
  - a message read in "Outlook" shows as read in the list after sync, and
    marking it unread in the tracker calls `update` and changes the stored
    state;
  - a move in either direction keeps the record link;
  - a delete in Outlook hides the message after 10 minutes, and the record
    timeline shows "deleted in Outlook";
  - a draft created, autosaved, given an attachment and sent lands in
    Sent Items, stored with `sent_from_tracker_by`;
  - reply all versus reply sends to the right people;
  - forward keeps the attachments;
  - sending to a do-not-contact contact is refused;
  - the owner's live read of a metadata-only mailbox returns the body and
    stores nothing;
  - another user gets 404.
- **Authz:**
  - each route for owner, inbox member, other sales user and admin;
  - the fixed `PATCH /api/inbox/:id` scope;
  - `/mail/threads/:id` membership.
- **E2E (Playwright):**
  - switch to My mailbox, then Sent Items;
  - open a message and see it marked read;
  - flag it;
  - move it to a folder;
  - reply all with an attachment;
  - start a new email, see the draft in Drafts, send it.

---

## 8. Decisions for the product owner (defaults given; the build can start with them)

1. **Opening a message marks it read in Outlook**, including in the shared
   sales@ mailbox. Default **yes, after 2 seconds**, as Outlook does.
2. **Delete** moves the message to Deleted Items, and permanent delete is
   allowed only from there. Default **yes**.
3. **The owner's live read** of their own mailbox when it stores only
   metadata. Default **yes**: the owner sees the full mail and nothing is
   stored.
4. **Admins and personal mailboxes:** admins see the folder list and
   metadata, but not the bodies, unless the owner shares them. Default
   **yes**.
5. **Rich-text editor:** Tiptap (MIT). Default **yes**.

---

## 9. Later

- The full 3-pane layout (folder pane always visible) and a command bar
  across the top.
- A choice between conversation and single-message views.
- Search inside message bodies (Graph `$search` per mailbox, live, so
  nothing extra is stored).
- Categories, Focused/Other, rules, calendar invites.
