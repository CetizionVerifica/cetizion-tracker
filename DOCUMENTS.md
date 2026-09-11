# Documents on quotations and purchase orders

A quotation or PO can carry one uploaded document. It is **optional**.

## What users see

- **Quotation form** and **PO forms** (Purchase orders page, Edit PO, New PO on a project)
  have an optional **document** field. Any file type is accepted, up to **10 MB**.
- **Replacing:** pick a new file and save. The old file is deleted from Cloudinary.
  Leaving the field empty keeps the current document.
- **Viewing:** the Quotations and Purchase orders tables have a **Document** column.
  **View** opens the file in a new tab; **—** means the record has no document. The PO
  detail page shows it too. PDFs, images and text files open in the browser; anything
  else downloads.
- **Deleting** a quotation or PO also deletes its file from Cloudinary.
- **CSV export** does not include anything about documents.

## How it is stored

- The **file lives in Cloudinary** as a private file. It only opens through the app,
  after sign-in, and a direct Cloudinary link returns 401.
- **Postgres keeps only the reference**, in a new `documents` table (Cloudinary ID, file
  name, type, size, upload date). `quotations` and `purchase_orders` link to it through
  a `document_id` column.
- Files go into `<CLOUDINARY_FOLDER>/quotations` and `<CLOUDINARY_FOLDER>/purchase-orders`.
- If someone uploads a file but never saves the form, the upload is cleaned up after a day.

## Files changed

| Area | Files |
|---|---|
| Database | `server/db/migrations/002_documents.sql` (**new**), `schema.sql`, `views.sql` |
| Server | `server/src/lib/documents.js` (**new**: Cloudinary), `server/src/routes/documents.js` (**new**: upload / view), `lib/crud.js`, `lib/resources.js`, `routes/lookups.js`, `routes/export.js` (keeps documents out of CSV), `config.js`, `app.js` |
| Screens | `components/RecordForm.jsx` (file field), `components/ui.jsx` (View link), `pages/Quotations.jsx`, `pages/PurchaseOrders.jsx`, `pages/PurchaseOrderDetail.jsx`, `pages/ProjectDetail.jsx`, `lib/api.js`, `lib/format.js` |
| Setup | `server/package.json` + lock (**new library:** `cloudinary`), `server/.env.example`, `README.md` |
| Tests | `server/test/documents.test.js` (**new**) |
| Copied unchanged from `analyze` | `scripts/dev.js`, root `package.json` (Windows `npm run dev` fix), `server/scripts/db.js` (`npm run db:upgrade`) |

## Deploying to production

1. **Back up the production database.**
2. In **Dokploy → Environment**, add:
   ```
   CLOUDINARY_CLOUD_NAME=...
   CLOUDINARY_API_KEY=...
   CLOUDINARY_API_SECRET=...
   CLOUDINARY_FOLDER=cetizion-tracker
   ```
   Without these, everything works except uploading a document.
3. Deploy the new version.
4. **Straight away**, in the container terminal, run:
   ```bash
   cd server && npm run db:upgrade
   ```
   It only **adds** the `documents` table and the two `document_id` columns, then
   rebuilds the views. No data is dropped. Until it runs, editing a quotation or PO
   fails. **Never run `npm run migrate` on production.**

Locally, `server/.env` has `CLOUDINARY_FOLDER=cetizion-tracker-dev`, so test uploads stay
apart from production files.

## How it was tested

- 23 server tests pass, 5 of them new.
- End to end against the local database and real Cloudinary (dev folder):
  - saving with or without a document works
  - a document can be added later
  - upload and view work: the PDF opens inline with identical bytes
  - a direct Cloudinary link is refused (private)
  - replacing deletes the old file
  - an HTML upload downloads instead of rendering
  - a blank value keeps the document
  - one document can't be attached to two records
  - deleting a record deletes its file
  - abandoned uploads are cleaned up
  - everything the test created was removed afterwards
- Existing features, checked on a throwaway copy of the real data after `db:upgrade`
  (28 checks): all lists and CSV exports, the dashboards, the action list, settings,
  the project page, edits and deletes, and quotation → project registration.
- The web app builds. The screens themselves have not been clicked through in a browser yet.
