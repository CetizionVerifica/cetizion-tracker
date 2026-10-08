# Inbox attachments: see them, open them in the tracker

**Ask (Shyam, 8 Oct 2026):** in a user's mailbox, in the Inbox, the
attachments should be visible and can be viewed *there only*. Plan first,
no code.

**Default taken until answered (§8):** "viewed there only" means an
**in-app viewer** inside the Inbox's reading pane: no Download button, no
new browser tab, no browser PDF toolbar (which has its own Download and
Print). The file still comes from Outlook on demand and is never stored by
the tracker.

**Status (8 Oct 2026):** step 1 is built on `claude/project-thread-5doj9b`:
the view route (`GET /api/mail/messages/:id/attachments/:attId/view`, which
answers only the viewer's `X-Tracker-View` header), the download route
removed, shared-mailbox readers allowed (`rules.js` `mayViewAttachments`),
each view in the activity log (`mail.attachment_viewed`), the viewer
(`web/src/components/mail/AttachmentViewer.jsx`: PDF through pdf.js,
pictures, spreadsheets and CSV as a grid, text), and file names in both
Inbox lists (merged in #224). **Step 2 is built** on the same branch:
Word documents as cleaned HTML (`mammoth`), emails forwarded as
attachments read from Graph as the message they are, OneDrive/SharePoint
links listed and explained (migration `095`: `email_attachments.kind`,
and messages listed with no attachments read again), and the viewer in
the email dialog on records. Step 3 (PowerPoint, old Office files)
follows.

---

## Summary

Most of the plumbing already exists (Inbox step 2, PR #187): the sync lists
each message's attachments, the reading pane shows an attachment strip, and
the server streams a file from Outlook on request. What is missing is the
*viewing*: today a PDF or image opens in a **new browser tab**, and every
other file (Word, Excel, PowerPoint, CSV, email) can only be **downloaded**.
There is no way to look at a file without leaving the Inbox, and nothing
stops it being saved.

The plan adds an **attachment viewer** that opens over the reading pane,
renders the file inside the app (PDF, images, Excel/CSV, Word, plain text,
forwarded emails), removes the Download and new-tab links from the Inbox,
and shows attachment names in the message list so they are visible before
a message is opened. Three phases, each its own PR; no migration in phase 1.

---

## 1. What exists today (checked in the code, `main` at `78cdf00`)

| Piece | Where | What it does |
| --- | --- | --- |
| Attachment list | `server/db/migrations/076_inbox_outlook.sql` `email_attachments`; filled by `sync.js` `storeAttachmentList` (retried by `retryAttachmentLists`) | Metadata only (name, type, size, inline, cid). The file stays in Outlook. In a **metadata-only** mailbox the name is withheld (NULL) and read live for the owner. |
| What Graph lists | `microsoft.js` `attachmentList` | Only `fileAttachment`. **Forwarded emails (`itemAttachment`) and OneDrive/SharePoint links (`referenceAttachment`) are dropped**, so they never show. |
| Message list | `web/src/components/mail/MessageList.jsx:74`, `pages/Inbox.jsx:136` | A paperclip icon only; no names. |
| Reading pane | `components/mail/MessageView.jsx:287` → `AttachmentStrip.jsx` | One chip per file: icon, name, size, an **Open in new tab** link (PDF and images only) and a **Download** link (every file). A chip is greyed out ("Only the mailbox owner can open this attachment") when the viewer may not read content. |
| File route | `server/src/routes/mail.js:296` `streamAttachment`, `GET /api/mail/messages/:id/attachments/:attId[?inline=1]` | Streams from Graph's `$value`, 25 MB cap, `nosniff`, strict sandbox CSP. `inline=1` only for PDF/images; everything else is `Content-Disposition: attachment`. |
| Who may open | `lib/mailbox/rules.js:89` `mayReadContent` | The mailbox **owner**, or anyone allowed to read the mailbox when it is set to `share_everything`. Same rule on `/api/mail/threads/:id` (`routes/mailboxes.js:576`). |
| Record dialogs | `components/EmailThread.jsx:41` (email thread on a deal, quotation…) | A text badge "attachments"; no list, no viewing. |
| Framing | `server/src/app.js:94` helmet `frameguard: deny` | Every response carries `X-Frame-Options: DENY`, so the file route **cannot** simply be put in an `<iframe>` in the app today. |
| Libraries already present | `server`: `xlsx` (SheetJS), `sanitize-html`, `unpdf`; `web`: `pdfjs-dist` (dev dependency, used by e2e only), `dompurify` | Enough to render PDF, Excel/CSV and sanitised HTML without new heavy dependencies. |

So: attachments are **listed** and **downloadable**, not **viewable in the
app**.

---

## 2. What the user will see

**Message list (Inbox and personal folders).** A message with attachments
keeps the paperclip and gains up to two small name chips under the snippet
(`Quotation_Rev2.pdf`, `BOQ.xlsx`, `+3`), like Outlook. Clicking a chip
opens the message with that attachment already in the viewer. Inline
pictures the body draws are not counted.

**Reading pane.** The attachment strip stays where it is. Each chip
becomes one button: click to **View**. The Download and new-tab icons are
removed (§8 Q1). A file that cannot be shown in the app (§3, "other") says
so in the viewer and offers **Open in Outlook** (the message's existing
`web_link`), which is where the owner already has the file anyway.

**Viewer.** A large panel over the reading pane (full screen on a phone):

- header: file name, type, size, "1 of 3" with ← → to move between the
  message's attachments, Close (Esc);
- body: the rendered file (see §3);
- footer for PDFs: page count, zoom in/out, fit width;
- no Download, no Print, no "open in new tab"; right-click "Save image" is
  turned off on the rendered surface.

The same viewer is used in the shared inbox's conversation view
(`Inbox.jsx` `Conversation`) and, in phase 2, in the email dialog on
records (`EmailThread.jsx`) so a PO or quotation PDF sent by a client can
be read from the deal itself.

---

## 3. How each kind of file is shown

The browser fetches the bytes with `fetch()` (not a link the user can
open) and renders them inside the page. Nothing is written to the
tracker's disk or database.

| Kind | Types | How it is rendered | Phase |
| --- | --- | --- | --- |
| PDF | `application/pdf` | **pdf.js** (`pdfjs-dist`, moved to a runtime dependency and lazy-loaded so the Inbox bundle does not grow) draws pages to `<canvas>`; scripts in the PDF never run; text layer on for selecting/searching. | 1 |
| Images | png, jpg, gif, webp, bmp | `<img>` from a `blob:` URL; zoom and fit. | 1 |
| SVG | `image/svg+xml` | `<img>` from a `blob:` URL (an SVG in `<img>` cannot run script). | 1 |
| Plain text | `text/plain`, `.csv` (as a table), `.log`, `.json`, `.xml` | Server returns text (first 1 MB); CSV goes through the table renderer below. | 1 |
| Excel | `.xlsx`, `.xls`, `.ods` | **Server** converts with SheetJS (already a dependency) to a JSON grid, one tab per sheet, capped (e.g. 2,000 rows × 60 columns per sheet, with a note when cut); the viewer draws a read-only grid. No formulas or macros run. | 1 |
| Word | `.docx` | **Server** converts to HTML with `mammoth` (small, pure JS; new dependency), cleaned with the existing `sanitize-html` rules, shown in the same sandboxed frame the message body uses (`mailFrame.js`). Layout is approximate (no headers/footers, simple tables). | 2 |
| Forwarded email | `itemAttachment` (`.msg` / `message/rfc822`, `.eml`) | Sync starts listing item attachments; the viewer shows From/To/Subject/Date and the body through the existing `cleanHtml` + sandboxed frame. Its own attachments are listed, not opened (one level). | 2 |
| PowerPoint, legacy `.doc`/`.ppt`, `.rtf`, other | — | Phase 3 option (§7): convert to PDF with LibreOffice in a separate container, then show as a PDF. Until then: "This file can't be shown here" + **Open in Outlook**. | 3 (optional) |
| Archives, executables | zip, rar, exe, … | Never rendered. Name and size only. | — |
| OneDrive/SharePoint link | `referenceAttachment` | Listed with a link that opens the file in SharePoint (the user's own Microsoft permissions apply). | 2 |

---

## 4. Server changes

1. **A view route next to the download route**
   `GET /api/mail/messages/:id/attachments/:attId/view`
   - same access check as today (`readableMessage` + `mayReadContent`);
   - same 25 MB cap and Graph stream (`streamAttachment` refactored so the
     two routes share it);
   - answers only `fetch()` from the app: requires a custom header
     (`X-Tracker-View: 1`) and `Sec-Fetch-Mode: cors|same-origin`, so
     pasting the URL into the address bar gets a 403 instead of a file;
   - returns by kind: raw bytes for PDF/image/SVG (`Content-Disposition:
     inline`, `Cache-Control: no-store`); `{ sheets: [...] }` JSON for
     spreadsheets/CSV; `{ html }` for Word and forwarded mail (sanitised);
     `{ text }` for text; `415 { reason: 'not_viewable', web_link }` for
     everything else.
2. **Remove downloads from the Inbox** (§8 Q1): the existing download route
   either stays for admins only, or is switched off by a setting
   `mail_attachment_download` (`off` by default). `publicMessage` and the
   thread route stop returning a download `url` when off, and return a
   `view_url` plus a `viewable` kind instead.
3. **List more attachment kinds** (phase 2): `microsoft.js attachmentList`
   keeps `itemAttachment` and `referenceAttachment` with a `kind` column
   (`file` / `item` / `reference`) and, for references, the `sourceUrl`.
   One small migration (`ALTER TABLE email_attachments ADD COLUMN kind
   text NOT NULL DEFAULT 'file', ADD COLUMN source_url text`). Existing rows
   are left as they are; the next sync of a message re-lists it.
4. **Names in the list**: the folder and inbox list queries
   (`routes/mail.js:143`, `routes/inbox.js:198`) return up to three
   non-inline attachment names per row (`array_agg … LIMIT 3` + a count),
   following the same visibility rule as subjects (no names from a
   metadata-only mailbox unless the viewer is its owner).
5. **Optional view log** (§8 Q4): one row in `activity_log` per view
   (who, message, file name), so an admin can see who opened what.

No change to sync timing, Graph scopes or consent: `Mail.ReadWrite(.Shared)`
already covers reading item attachments.

## 5. Front-end changes

- `components/mail/AttachmentViewer.jsx` (new): the panel, keyboard
  (← → Esc), and one renderer per kind (`PdfView`, `ImageView`,
  `SheetView`, `HtmlView`, `TextView`, `NotViewable`). pdf.js and its
  worker are dynamic imports, served from the app's own origin.
- `AttachmentStrip.jsx`: chips become View buttons; download/new-tab links
  go (or show only when the server says downloads are on).
- `MessageList.jsx` and `Inbox.jsx` `ThreadRow`: the name chips.
- `EmailThread.jsx` (phase 2): the strip and viewer replace the
  "attachments" badge.
- Blob URLs are revoked on close; nothing is cached beyond the open viewer.

## 6. Security and privacy

- **Same people as today.** Only someone who may already download a
  file (`mayReadContent`) may view it. A colleague looking at a
  metadata-only personal mailbox still sees a greyed-out chip.
- **Nothing runs.** PDFs through pdf.js (no PDF JavaScript), images via
  `<img>`, Office files converted on the server to data or sanitised
  HTML; the HTML goes into the same sandboxed, script-free frame as mail
  bodies. The raw-bytes response keeps the strict
  `default-src 'none'; sandbox` CSP and `nosniff`.
- **Conversion is bounded.** SheetJS and mammoth run with the 25 MB cap,
  a row/cell cap and a time limit, in the API process for phase 1–2
  (they are pure JS). If a crafted file is a concern, they move into the
  existing `pg-boss` worker. LibreOffice (phase 3) would run only in its
  own container with no network.
- **"There only" is a deterrent, not DRM.** The app shows no download,
  print or open-in-tab controls, and the view URL refuses direct
  navigation, but anyone who can see a file on screen can still screenshot
  it or pull it from the browser's developer tools, and the mailbox owner
  has the original in Outlook. If a hard guarantee is needed, the only
  real option is a watermark per viewer (§8 Q5), not a technical block.

## 7. Phases

| Phase | Scope | Size |
| --- | --- | --- |
| **1. Viewer** | View route; viewer with PDF, images, SVG, text/CSV, Excel; strip without Download; download setting; names in the message list; Playwright test opening a PDF and an xlsx; unit tests for the view route's access and the header check. No migration. | One PR |
| **2. More files and more places** | Word (`mammoth`), forwarded emails and OneDrive links (sync change + small migration); viewer in the record email dialog; optional view log. | One PR |
| **3. Everything else** | PowerPoint, `.doc`, `.ppt`, `.rtf` via a LibreOffice converter container (`unoserver` or `gotenberg`), shown as PDF; cached for the open session only. Adds ~400 MB image and a service to the Dokploy stack. | One PR + infra |

## 8. Decisions (Shyam, 8 Oct 2026)

1. **Download: nobody.** No user, admin included, can download an
   attachment from the tracker. The download route and its `url` are
   removed outright (not a setting); §4 step 2 becomes "delete the
   download path". Viewing only.
2. **PowerPoint and old Office files: yes.** Phase 3 (LibreOffice
   converter container) is in scope, not optional.
3. **Shared inbox members: yes.** Members of a shared mailbox's inbox
   (`inboxScope`) may view its attachments whatever its visibility
   setting. `mayReadContent` stays as is for personal mailboxes; a new
   `mayViewAttachments(user, account)` = `mayReadContent` OR (shared
   mailbox AND the user is a member of its inbox). Names in a
   metadata-only shared mailbox are then stored for members too.

Defaults taken for the questions not answered (say if any is wrong):

4. **View log: yes**, one `activity_log` row per view, visible to admins.
5. **Watermark: no** for now.
6. **Records: yes**, the same viewer in the email dialog on deals,
   quotations and POs (phase 2).
