# Client data gaps

What the tracker cannot record about a client today, what that breaks, and how
to fill each gap. Written against commit `1b24e66`; reviewed and extended against `077710a`.

## The short answer

The question that started this: *there is no field to store the client
contact's email.*

There is one: `contacts.email` (`server/db/schema.sql:331`). Quotation emails,
acceptance links, payment reminders, visit reminders, the client portal and
mailbox matching all read it. What is missing is a way to fill it from the
screens people actually work in.

The enquiry and quotation forms take the contact's **name** only. The trigger
that turns that name into a contact stores the name and nothing else. So every
contact created the ordinary way has no email and no phone, and every feature
that needs one quietly does less than it should.

That is the largest gap. There are several related ones:

- The address typed when sending a quotation is thrown away after the send.
- The importer drops email and phone columns.
- Projects and purchase orders have no client contact at all.
- The company record has no state, PIN code, country or PAN, and holds only
  one GSTIN.

## Summary

| # | Gap | What it breaks | Fix | Priority |
|---|---|---|---|---|
| 1 | Enquiry and quotation forms take a contact name, not an email or phone | Send quotation, send for acceptance, reminders and the portal have no address | Email and phone on both forms, saved to the contact | P1 |
| 2 | Contacts created from a typed name never get an email, and Data Quality counts them as fine | The missing emails are invisible; the same person can end up as two contacts | Data Quality checks; attach inbox emails to the linked contact | P1 |
| 3 | An address typed in the Send dialog is used once and discarded | It has to be retyped every time; reminders still have no address | "Save to contact" on both send dialogs | P1 |
| 4 | The importer drops Email, Phone, Designation, GSTIN and Address columns | Contact data in old sheets is lost on import | New importer fields that fill blanks only | P2 |
| 5 | Reminders go to *any* contact with an email when none is marked billing, and to one contact per company | Chasers can reach the wrong person; a client unit's accounts team can't be addressed per PO | A billing contact on the PO; no fallback to arbitrary contacts | P1 |
| 6 | Projects have no client contact | Visit notices to the client are skipped silently; the project has no default client person | `projects.client_contact_id` | P2 |
| 7 | Companies have no state, PIN code, country or PAN | No place of supply without a GSTIN; no PAN for TDS on unregistered clients | Structured address and tax fields | P2 |
| 8 | A company holds one GSTIN | A client with units in several states is invoiced against the wrong registration | GST registrations per company, chosen on the PO | P3 |
| 9 | The company page's People list hides email and phone | Nobody sees which contacts are missing an email | Show them, and mark the missing ones | P3 |
| 10 | Nothing records that one company belongs to another | A client's plants are either merged destructively or unrelated; no group view | `companies.parent_company_id`, offered from the duplicates group | P2 |
| 11 | Payment terms live on the PO only | A client's standing terms are retyped on every PO | `companies.payment_terms_days`, defaulted into the PO | P3 |

## Where client contact data comes from today

| Entry point | Name | Email | Phone | Code |
|---|---|---|---|---|
| Enquiry form | free text | — | — | `web/src/pages/Enquiries.jsx:54` |
| Quotation form | free text | — | — | `web/src/pages/Quotations.jsx:18` |
| Bulk import | yes | dropped | dropped | `server/src/import/fields.js:47-49` |
| Inbox → Create the enquiry | yes | sender's address | — | `server/src/routes/inbox.js:393-401` |
| Mailbox sync (auto-create on) | yes | yes | — | `server/src/lib/mailbox/sync.js:99-106` |
| Website webhook | yes | yes | yes | `server/src/routes/webhooks.js:158-159`, `:184-186` |
| Company page → Add contact | yes | yes | yes | `web/src/pages/CompanyDetail.jsx:98-113` |

People use two paths most: typing an enquiry after a call, and entering a
quotation. Neither can hold an email. The only screen that can is the company
page, and nothing on the enquiry or quotation form points there. The one hint
is on the timeline, and it only appears when a client has no contacts at all
(`web/src/components/Timeline.jsx:265`).

## The gaps

### 1. Contact email and phone on the enquiry and quotation forms

**Now.** `contact_person` is a plain text input (`Enquiries.jsx:54`,
`Quotations.jsx:18`), and the server accepts it as `str(120)`
(`server/src/lib/resources.js:184`, `:228`). On save, the `b_link_contact`
trigger calls `contact_for()` (`schema.sql:1128-1141`). That function finds the
contact by normalised name, or inserts one with only `company_id` and `name`.

**What it breaks.**

- **Sending a quotation.** Send quotation and Send for acceptance fall back to
  the contact's email. With none, they refuse with "No email address: add one
  on the contact, or type one" (`server/src/routes/quotations.js:119-120`,
  `server/src/routes/acceptance.js:62-63`).
- **Payment reminders.** The client is skipped with "no billing contact with an
  email" (`server/src/lib/reminders.js:58`).
- **Visit reminders.** The client's visit reminder is skipped, and nobody is
  told (`server/src/lib/visits.js:107`).
- **The portal.** Only contacts with an email can sign in
  (`server/src/routes/portal.js:72-74`).
- **Mailbox matching.** Incoming mail is matched to a client by contact email,
  or by an email domain one of its contacts uses
  (`server/src/lib/mailbox/sync.js:81-97`). A client whose contacts have no
  email can only be matched through its website field.

**Fix.** Keep the email on the contact, so the fact lives in one place as the
README promises, and let the forms write it there.

- **Accept two new inputs.** Add `contact_email` (checked as an email, 160
  characters) and `contact_phone` (40 characters) to the enquiry and quotation
  schemas in `resources.js`. Leave them out of `columns`, because they are not
  columns of either table. Projects already do this for `quotation_no` and
  `actual_delivery_date` (`resources.js:285-291`) and handle them in `onSave`.
- **Write them to the contact.** In `onSave`, write them to the contact the
  trigger linked (`after.contact_id`). Enquiries already have `saveEnquiry`;
  quotations need an `onSave`.
  - A value that is sent replaces the stored one. The person sees the current
    value in the form, unlike the webhook, which only fills blanks because its
    sender is not trusted.
  - A blank field leaves the stored value alone. Clearing an email belongs on
    the contact form.
- **Show current values on edit.** The quotation and enquiry reads need to
  return the linked contact's email and phone, for example as `contact_email`
  and `contact_phone` joined into `v_quotations`.
- **Offer existing contacts.** Make `contact_person` a `combo` whose options are
  the chosen company's contacts. Use `fills` (`web/src/components/RecordForm.jsx:22`,
  `:79-80`) to copy the picked contact's email and phone into the two new
  fields.
- **Warn on a shared email.** If the email already belongs to a contact at
  another company, show a warning rather than an error.
- **Webhooks need no change.** `server/src/lib/webhooks.js:25` already strips
  any key ending in `email` or `phone` from outgoing events, so the new fields
  stay out of n8n payloads.

**Done when:**

- A new enquiry for Hetero with contact "Ravi Kumar" and email
  `ravi@hetero.example` leaves Ravi on the Hetero company page with that email.
- The quotation made from it pre-fills `ravi@hetero.example` in Send.
- Changing the email on the quotation changes it on the company page.

### 2. Name-only contacts, and Data Quality

**Now.** The only contact check on the Data Quality page is "Companies with no
contact" (`server/src/lib/dataQuality.js:68-74`). A contact created from a typed
name passes it. A company whose only contact has no email and no phone
therefore reads as healthy.

A second problem: contacts are unique by name within a company
(`schema.sql:350-351`). The inbox conversion can produce the same person twice
(`server/src/routes/inbox.js:387-401`). Suppose someone corrects the
prefilled name to "Ravi Kumar" while the sender's display name is "Ravi K":

1. The trigger creates a "Ravi Kumar" contact with no email, and the enquiry
   links to it.
2. The route then adds "Ravi K" with the email.

The enquiry and every quotation made from it point at the contact without the
email.

**Fix.**

- **New checks on the Data Quality page.** Each check must link to a list
  filtered to the same rows (the rule at `dataQuality.js:8-10`). So each check
  needs a count on the view and a filter on its list page.
  - Companies that have contacts but none with an email (a
    `contacts_with_email` count on `v_companies`).
  - Companies with a purchase order but no billing contact with an email (a
    `billing_contacts` count on `v_companies`).
  - Open quotations whose contact has no email (`contact_email` on
    `v_quotations`).
- **Fix the inbox duplicate.** In the inbox conversion, attach the sender's
  email to the contact the enquiry linked (`e.contact_id`), filling it only
  if blank, instead of inserting a second contact under the display name.

### 3. The Send dialog forgets the address

**Now.** `SendDialog` pre-fills To from `quotation.contact?.email`
(`web/src/pages/QuotationDetail.jsx:507-508`). An address typed there is used
for that one email and in the saved PDF's label
(`routes/quotations.js:119`, `:140`), and stored nowhere else. Send for
acceptance keeps it only as `quotation_acceptances.sent_to`
(`routes/acceptance.js:62`, `:71-74`). The next send, the next reminder, the
portal and the mailbox matcher still see a contact with no email.

**Fix.**

- **A checkbox in both dialogs.** Add "Save as *contact name*'s email" under
  To. Tick it by default when the contact has no email, and leave it unticked
  when the contact already has a different one.
- **Server.** Accept `save_to_contact` in both send schemas. When it is set and
  the quotation has a contact, update that contact in the same transaction
  that stamps `sent_at`.

### 4. The importer drops contact columns

**Now.** The importer knows one contact column, the name
(`server/src/import/fields.js:47-49`), and writes it to
`quotations.contact_person` (`server/src/import/rules.js:528`). Some columns
never reach the database:

- **Ignored.** "Contact Email", "Email ID", "Phone", "Mobile No",
  "Designation", "GSTIN", "Address" and "Place of Supply" match no field.
  Several fields reject such headers on purpose (`fields.js:41`, `:49`), and
  unmapped columns are ignored (`docs/bulk-import.md:95`).
- **Removed at upload.** "Pin Code" never reaches the mapper. `SECRET_HEADER`
  matches `\bpin\b` and removes the column as if it held a password
  (`fields.js:179`). Only the spaced spelling is affected — `\bpin\b` needs a
  word boundary and "Pincode" has none, so that one comes through:

  ```
  "Pin Code" -> dropped as a secret: true
  "Pincode"  -> dropped as a secret: false
  ```

**Fix.**

- **New fields.** Add `contact_email`, `contact_phone`, `contact_role`,
  `gstin`, `address` and `city` to `FIELDS`. The `avoid` pattern on
  `contact_email` must keep it off "Sales person email" and "PM email".
- **Fill blanks only.** On commit, write these to the contact and company the
  quotation linked to, as the webhook does (`COALESCE(existing, imported)`).
  An import never overwrites something a person typed.
- **Stop removing PIN code columns.** Narrow `SECRET_HEADER` so "Pin code" is
  not treated as a PIN, for example `\bpin\b(?!\s*code)`. A bank PIN on its
  own still matches, which is the case the rule is for.
- **Docs.** Update the field list in `docs/bulk-import.md`.

### 5. Who gets the payment reminder

**Now.** For each company, the reminder run picks the first contact with an
email, billing contacts first (`server/src/lib/reminders.js:69-78`).

- **No billing contact marked.** The reminder goes to whichever contact with
  an email was created first. That can be someone mailbox sync added, or the
  client's technical lead.
- **Invoice run.** Its "Bill to" uses the same rule
  (`web/src/pages/InvoiceRun.jsx:178`).
- **One recipient per company.** A client whose units each have their own
  accounts-payable team cannot be chased per PO.

**Fix.**

- **Billing contact on the PO.** Add `purchase_orders.billing_contact_id`. Set
  it in Register PO and the PO forms, defaulting to the company's billing
  contact.
- **Reminder recipient.** Send to the PO's billing contact, or else the
  company's billing contact.
  - With neither, skip the client and give the reason "no billing contact"
    instead of writing to whichever contact came first.
  - Group reminders by company and recipient, so one email still covers every
    overdue invoice going to the same person.
- **CC the other billing contacts.** Copy every other billing contact at the
  company that has an email. `sendMail` takes `cc`, but reminders use it only
  for the finance address today (`reminders.js:101`).

**Decision needed.** Dropping the fallback means some reminders that go out
today will stop until someone marks a billing contact. Work through the
"no billing contact" check from gap 2 before switching it on.

### 6. A client contact on the project

**Now.** A project has `project_manager` and `project_manager_email`, which
are Cetizion's own manager (`schema.sql:365-366`). It has no link to anybody
at the client. Only quotations and enquiries get the contact trigger
(`schema.sql:1205-1209`).

Visits carry a `contact_id` (`schema.sql:1987`). But `visit_defaults()` fills
in the visit's company from the project and never its contact
(`schema.sql:2027-2035`), even though its comment says "the client, contact
and stamps follow the project". So "notify client" on a visit does nothing
unless someone picks a contact by hand, and nothing tells them
(`server/src/lib/visits.js:107`).

**Fix.**

- **Add the column.** Add `projects.client_contact_id`, defaulted from the won
  quotation's `contact_id` when a project is registered, and editable on the
  project.
- **Use it for visits.** `visit_defaults()` takes the project's client contact
  when a visit has none.
- **Warn in the visit dialog.** Warn when "notify client" is ticked and the
  contact has no email.

### 7. Company address and tax fields

**Now.** A company has `name`, `sector`, `gstin`, `website`, `address` (one
text box), `city` and `notes` (`schema.sql:310-325`; form at
`web/src/pages/CompanyDetail.jsx:114-122`).

| Missing | Why it is needed | Today |
|---|---|---|
| State (GST state code) | Decides CGST + SGST or IGST when the client has no valid GSTIN; place of supply on the invoice | Typed free-hand on each quotation (`Quotations.jsx:27`). The invoice run notes it too: "companies hold a city, not a state" (`InvoiceRun.jsx:274-277`) |
| PIN code | The postal address on the quotation PDF and the invoice | Inside the address text, if anywhere |
| Country | Export of services (no GST, under a Letter of Undertaking (LUT)); defaults for foreign clients | On enquiries and quotations only |
| PAN | Matching TDS against the client's deductions (Form 26AS) | Derived from the GSTIN only (`server/src/lib/accounting/gst.js:44`, used at `server/src/routes/accounting.js:203`), so blank for clients without a GSTIN |

**Fix.**

- **New columns.** Add `state_code` (two digits, checked against `STATES` in
  `gst.js`), `pincode`, `country` (default India) and `pan`. Check PAN against
  characters 3–12 of the GSTIN when both are present.
- **Prefill the state.** Take `state_code` from a valid GSTIN.
- **Where they are read:**
  - The place-of-supply fallback (`routes/quotations.js:49-53`,
    `lib/accounting/providers.js:33-35`).
  - The invoice run's Tax column.
  - The address block on the quotation PDF (`lib/quotationPdf.js:68`).
  - The TDS report (`routes/accounting.js:203`).

A shared accounts or reception inbox does not need a company column. Record
it as a contact, for example "Accounts payable" marked as billing, which is
what reminders need anyway. Say so in the contact form's hint.

### 8. One GSTIN per company

**Now.** A business in India registers separately in each state it operates
from, but `companies.gstin` holds one registration. The draft invoice and the
quotation take the client's state from that GSTIN first. They fall back to the
quotation's place of supply only when the GSTIN is missing or invalid
(`lib/accounting/providers.js:33-35`, `routes/quotations.js:49-53`). The
GSTR-1 export reads the same single GSTIN (`routes/accounting.js:208`).

Take a PO from a client's Gujarat unit, where the company record holds its
Maharashtra GSTIN. It drafts against the Maharashtra registration: the wrong
recipient GSTIN, and possibly the wrong choice between CGST + SGST and IGST.

**Fix.**

- **A registrations table.** Add `company_gst_registrations` with
  `company_id`, `gstin` (unique), `state_code`, `legal_name`,
  `billing_address` and `is_default`. Keep `companies.gstin` as the default
  until everything reads the new table.
- **Choose it on the PO.** Add `purchase_orders.bill_to_registration_id`. The
  draft invoice and GSTR-1 read the PO's registration first, then the default.

This is the largest change here, and it only matters for clients with more than
one registration. Count them before building it.

### 9. The People list hides the gaps

**Now.** The company page lists each contact's name, role, and billing and
do-not-contact flags (`CompanyDetail.jsx:196-203`). Email and phone show only
after opening the contact.

**Fix.** Show email and phone on each row, and mark "no email" where it is
missing, so the gaps are visible where they are fixed.

### 10. A client group has no place to live

**Now.** `companies` has `name`, `sector`, `gstin`, `website`, `address`,
`city` and `notes` (`schema.sql:310-325`). There is no parent, no group, no
`parent_company_id` — nothing anywhere in the schema records that one company
belongs to another.

**What it breaks.** A client with several plants is several companies with no
relationship between them. The duplicate detection added in #140 makes this
visible rather than causing it: the Companies page groups "Hindalco",
"Hindalco - Belur", "Hindalco FRP", "Hindalco - Kuppam" and "Aditya Birla -
Hindalco" as sharing a brand, and then has to ask a person which of them are
one client, because it cannot tell. Both answers available today are wrong:

- **Merge them.** Every quotation, enquiry and project moves onto one name and
  the others are deleted. But Belur and FRP are different plants that raise
  their own POs, so this destroys a real distinction and cannot be undone.
- **Leave them separate.** Correct per record, and there is then no way to ask
  what Hindalco as a whole is worth, who owns the relationship, or how much
  it owes.

Gap 8 is the adjacent problem and not the same one: GST registrations answer
*which entity do we invoice*, not *are these one client*.

**Fix.**

- **A parent.** Add `companies.parent_company_id` referencing `companies(id)`,
  with a check that it is not itself, and a depth of one — a parent may not
  have a parent, because a chain nobody asked for is a reporting problem
  nobody can read.
- **Offer it from the duplicates group.** The review dialog already lists the
  spellings side by side. Beside "Merge", offer "These are one group" — which
  sets the parent instead of destroying the rows.
- **Roll up where it is asked for.** The company page shows its units and
  their totals; Collections and the sales report can group by parent.

Count the clients with more than one unit before building the roll-up. The
column and the group action are worth having on their own.

### 11. No standing payment terms for a client

**Now.** `payment_terms_days` exists on `purchase_orders` (`schema.sql:560`)
and on `travel_vendor_invoices` (`:827`). A company has none.

**What it breaks.** A client whose terms are always 45 days has them typed on
every PO, and a wrong one is only noticed when the invoice falls due on the
wrong date. Gap 5 settles *who* gets chased; this is *when*.

**Fix.** Add `companies.payment_terms_days`, default it into Register PO and
the PO form, and leave the PO free to differ — the PO is still the contract.

### 12. Worth asking, not yet a finding

The schema has no client-issued vendor or supplier code
(`grep -c vendor_code db/schema.sql` is 0). Several Indian clients require
theirs on the invoice or it is not paid. Whether that matters here depends on
how Cetizion actually invoices, which this document cannot tell from the code.
Ask finance before adding a column.

## Suggested order

1. **No new columns.** Gaps 1, 2, 3 and 9: the forms, the send dialogs, the
   checks and the People list. This alone lets people type the email where
   they work, and shows how many clients are missing one.
2. **One migration.** Gaps 5 and 6, the company fields from gap 7, and the
   importer (gap 4).
3. **GST registrations** (gap 8), after counting the clients who need it.

## Migration sketch for step 2

This is illustrative, not final. As with every migration, it is mirrored in
`server/db/schema.sql` and `server/db/views.sql`, and
`scripts/ci/check-migrations.sh` proves that an upgraded database matches a
fresh one. Every column is new and starts empty, so nothing in existing data
can make it fail.

```sql
-- 059_client_contacts.sql

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS billing_contact_id int REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE projects        ADD COLUMN IF NOT EXISTS client_contact_id  int REFERENCES contacts(id) ON DELETE SET NULL;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS state_code text CHECK (state_code ~ '^[0-9]{2}$');
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pincode    text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country    text NOT NULL DEFAULT 'India';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pan        text CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

-- A project's client contact starts as its latest quotation's.
UPDATE projects p
   SET client_contact_id = (
     SELECT q.contact_id FROM quotations q
      WHERE q.project_id = p.project_id AND q.contact_id IS NOT NULL
      ORDER BY q.quotation_date DESC NULLS LAST, q.id DESC
      LIMIT 1)
 WHERE p.client_contact_id IS NULL;

-- A company's state starts as its GSTIN's. The app checks the GSTIN properly;
-- this only takes the two leading digits of one that looks like a GSTIN.
UPDATE companies
   SET state_code = substr(gstin, 1, 2)
 WHERE state_code IS NULL AND gstin ~ '^[0-9]{2}[A-Z0-9]{13}$';
```

The same change also touches:

- `server/db/scrub.sql:60`: blank `pan` and `pincode` along with the other
  company fields, so staging holds no real client data.
- `server/src/lib/resources.js`: the company and PO schemas and `columns`.
- `v_companies`, `v_purchase_orders` and `v_projects`: return the new fields.
- The company, project and PO forms, and `RegisterPoDialog.jsx`.
