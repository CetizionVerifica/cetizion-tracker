# Who may do what

The access rules the API enforces, and why each one is where it is (#18
Phase 1C).

Two roles exist: **admin** and **sales**. Everything below is enforced on
the server. The front end hides what a sales user may not do, but hiding is
a courtesy — the gate is the route.

In `AUTH_MODE=shared` there is one account and it is treated as an admin, so
that the real accounts can be prepared before the cutover. In
`AUTH_MODE=database` the role comes from the user's row and is re-read on
every request, so a change of role is in force on the very next one.

---

## The two mechanisms

There is no separate permission system. Everything is `requireAdmin` from
`auth/middleware.js`, applied in one of two places:

**On a route**, where the rule belongs to that route alone:

```js
jobRouter.post('/:name/run', requireAdmin, handler);
```

**On a resource**, by a flag the generic CRUD factory reads:

| Flag | Gates | Leaves open |
| --- | --- | --- |
| `adminOnlyWrites` | POST, PATCH, DELETE | GET |
| `adminOnlyDeletes` | DELETE | GET, POST, PATCH |
| `protectedFields` | the named columns, on POST, PATCH and the MCP record import, **for everybody** | every other column |

`adminOnlyWrites` implies `adminOnlyDeletes`: a resource only an admin may
write is one only an admin may delete.

Adding a rule means adding a flag in `lib/resources.js` or a middleware
argument in a router — not a new abstraction.

---

## Routes

| Action | Admin | Sales |
| --- | :--: | :--: |
| `GET /api/health`, `GET /api/auth/config` | public | public |
| `POST /api/auth/login`, `/logout`, `GET /me` | ✅ | ✅ |
| `GET/POST/PATCH /api/users`, `POST /api/users/:id/password` | ✅ | **403** |
| `GET /api/settings` | ✅ | ✅ |
| `PATCH /api/settings/:key` | ✅ | **403** |
| `GET /api/emails`, `GET /api/emails/:id` | ✅ | ✅ |
| `POST /api/emails/test` | ✅ | **403** |
| `GET /api/jobs` | ✅ | ✅ |
| `POST /api/jobs/:name/run` | ✅ | **403** |
| `GET /api/companies/duplicates`, `/:id/full` | ✅ | ✅ |
| `POST /api/companies/:id/merge` | ✅ | **403** |
| everything under `/api/import` | ✅ | **403** |
| `POST /api/quotations/:key/approval/request` | ✅ | ✅ |
| `POST /api/quotations/:key/approval/decide` | ✅ | **403** |
| `POST /api/expense-claims/:id/decide` | ✅ | **403** |
| `POST /api/expense-claims/:id/reimburse` | ✅ | **403** |
| `POST /api/expense-claims/:id/correct` | ✅ | **403** |
| `POST /api/vendor-invoices/:id/pay` | ✅ | ✅ |
| `GET /api/lookups`, `/api/dashboard`, `/api/export`, `/api/documents` | ✅ | ✅ |

Anything under `/api` with no session is **401**, before any of the above is
considered.

Reading is open in every row where writing is not. The lists, rates and logs
fill the forms and answer the questions a sales user needs to do the job;
the gate is on making something happen, not on looking.

---

## The rest of the workflow routes (#85)

The routes above are the ones where the **role** decides. These are the
remaining registered workflow routes — the ones that move a quotation into a
project, schedule a PO's billing, and raise and receive against it. Listed
here because "not admin-only" is a decision, and an undocumented route reads
like an oversight rather than a choice.

Every one of them is open to **any authenticated user**. None carries
`requireAdmin`; all sit behind the app-wide `requireAuth`, so signed out is
still 401.

| Action | Route | Admin | Sales | The check that does apply |
| --- | --- | :--: | :--: | --- |
| Quotation conversion | `POST /api/quotations/:id/convert` | ✅ | ✅ | Row locked `FOR UPDATE`; 422 if the quotation is already registered as a project. State, not role. |
| Purchase-order stages | `POST /api/purchase-orders/:poNumber/stages` | ✅ | ✅ | The split must account for exactly what is left of the PO. A stage already invoiced or paid is never deleted by `replace`, so 150% cannot be scheduled. |
| Invoice operations | `POST /api/payment-stages/:id/invoice` | ✅ | ✅ | Invoice number and date required; the attached document is claimed under lock and the replaced file purged only after commit. |
| Payment operations | `POST /api/payment-stages/:id/payment` | ✅ | ✅ | See the note below — this route writes the `payments` ledger, which the generic form does not. |
| Onboarding template | `POST /api/projects/:projectId/onboarding/apply-template` | ✅ | ✅ | — |
| Register a PO | `POST /api/quotations/:key/register` | ✅ | ✅ | — |
| Revise / send / accept a quotation | `POST /api/quotations/:key/revise`, `/send`, `/accept` | ✅ | ✅ | `send` is refused while an approval is pending. |

### Two of these are worth saying out loud

**Approving a discount is not the same as asking for one.**
`POST /api/quotations/:key/approval/request` is open — it is the
salesperson's own request, and #46 exists so that somebody else says yes.
`POST /api/quotations/:key/approval/decide` carries `requireAdmin`, and like
the claim routes it takes the decider from the session
(`req.user.username` → `quotations.approved_by`), not from the body. The
neighbouring route in the same router has the opposite rule; the pairing is
the point, not an inconsistency.

**Recording a receipt is ordinary work; editing the ledger is not.**
`POST /api/payment-stages/:id/payment` inserts into `payments` and is open to
both roles, while the `payments` **resource** is `adminOnlyWrites` — so
`POST`/`PATCH /api/payments` is admin-only. That is deliberate and is the
same shape as `protectedFields` below: one recorded door in, and the raw
ledger closed to the form. Since #27 every receipt is its own row and the
stage total follows by trigger, so lowering a total books a **negative row**
rather than overwriting the figure. (An expense claim has no such ledger —
see the limitation noted under `/correct`.)

---

## Resources

| Resource | GET | POST / PATCH | DELETE |
| --- | :--: | :--: | :--: |
| enquiries | any | any | **any** |
| quotations | any | any | **any** |
| projects | any | any | **any** |
| onboarding | any | any | **any** |
| travel-logs | any | any | **any** |
| vendor-invoices | any | any, **except the paid columns** | **any** |
| expense-claims | any | any, **except the four below** | **any** |
| companies | any | any | **admin** |
| contacts | any | any | **admin** |
| purchase-orders | any | any | **admin** |
| po-services | any | any | **admin** |
| payment-stages | any | any | **admin** |
| services | any | **admin** | **admin** |
| travel-vendors | any | **admin** | **admin** |
| expense-categories | any | **admin** | **admin** |
| exchange-rates | any | **admin** | **admin** |

"any" means any authenticated user, of either role.

---

## Money: the four columns and the routes that own them (#85)

Two resources carry columns that are not the form's to set. Each has a
route of its own that checks who is asking, checks the record is in a state
where the change makes sense, and writes an audit row in the same
transaction. `protectedFields` on the resource closes the generic form
against exactly those columns, so there is one way in rather than two.

The check runs in `validate()` in `server/src/lib/crud.js`, which is the one
place every generic write passes through: `POST` and `PATCH` on the resource,
and the MCP `import_records` tool, which reaches the same tables through
`insertRecord` / `updateRecordRow` without going near a route. It reads the
request body rather than the parsed record, because zod fills `approval_status`
and `amount_reimbursed` from their defaults whether or not anybody sent them —
so the test is "was this field in what the caller sent", and an explicit `null`
counts.

| Resource | Columns closed on the form | The route that owns them | Who |
| --- | --- | --- | :--: |
| expense-claims | `approval_status`, `approved_by`, `amount_reimbursed`, `reimbursement_date` | `POST /:id/decide`, `POST /:id/reimburse`, `POST /:id/correct` | **admin** |
| vendor-invoices | `amount_paid`, `payment_date` | `POST /:id/pay` | any |

Three things are worth saying plainly about the claim routes, because any
one of them left alone still lets money out:

- **Only an admin decides or pays.** Before #85 neither route carried a role
  check, so any signed-in person could approve a claim and then reimburse
  it.
- **`approved_by` comes from the session.** It used to be a free-text field
  in the request body, which meant the name on the record was whatever the
  caller typed.
- **The same columns are closed on the form.** Guarding the routes alone
  would have left `POST`/`PATCH /api/expense-claims` as a second, unguarded
  way to the same four columns — including creating a claim that was already
  marked Approved.

Administrators are held to `protectedFields` too. Being allowed to make a
change is not the same as being allowed to make it without the check, the
cumulative arithmetic and the audit row; `POST /:id/correct` is the
deliberate, recorded way to put a wrong figure right, and it is the only
route that can move a reimbursement total back down.

**A claim still has no owner.** The table records the employee as a name
copied from the trip, not as a user, so "an admin may not approve their own
claim" is not a rule this can enforce yet — it needs a column the table does
not have. What is enforced is that only an admin decides, and that whoever
did is recorded in `activity_log` where it cannot be edited.

**Vendor payments are not admin-only**, on purpose. Arranging travel and
settling the vendor's invoice is ordinary work and there is no finance role
for it to belong to. What changed is the door, not the permission: the
figure now arrives through a route that records who entered it.

### Correcting a figure, and what the tracker cannot tell you

`POST /:id/correct` is the only route that can move a reimbursement total
**down**; the reimbursement dialog only ever adds to it. It is
administrator-only, refuses to run without a reason, caps the figure at what
was claimed, and records the before and after.

It also enforces the same rule `/decide` does, judged on the state the
correction would arrive at rather than on the field that happened to be
sent: **a claim may not end up outside `Approved` while a reimbursement is
still recorded against it.** Money recorded against a claim that is not
approved is money the tracker has stopped counting — the claim's status is
read from `approval_status` first, so the reimbursement disappears from
every figure while the payment does not. Both fields may be sent in one
call, so rejecting a part-reimbursed claim is a single correction that says
what happened to the money as well as to the claim:

```
POST /expense-claims/12/correct
{ "amount_reimbursed": 0, "approval_status": "Rejected",
  "reason": "keyed against the wrong claim" }
```

**An accounting limitation worth stating plainly.** `amount_reimbursed` is a
single column, not a ledger — unlike a payment stage, which since #27 keeps
every receipt as its own row and books a negative row when a total comes down.
Lowering a claim's total therefore **overwrites** the previous figure rather
than booking a reversal against it, and the `claim.corrected` activity row
is the only surviving record that the larger figure was ever there. Those
rows carry `lowers_recorded_total: true` so the case can be found.

What this means: the endpoint can correct a **mistaken entry**. It cannot
represent an actual **refund** — money that genuinely left and came back —
because there is nowhere to put the second movement. Whether a given
correction was a typo or a repayment is only knowable from its `reason`.
Handling real refunds would need a reimbursement ledger on claims, which is
a schema change and its own piece of work, not part of #85.

### What is audited

| Action key | Written by |
| --- | --- |
| `claim.decided` | `POST /api/expense-claims/:id/decide` |
| `claim.reimbursed` | `POST /api/expense-claims/:id/reimburse` |
| `claim.corrected` | `POST /api/expense-claims/:id/correct` |
| `vendor_invoice.paid` | `POST /api/vendor-invoices/:id/pay` |

Each row carries the account that acted, the figures before and after, and
commits in the same transaction as the change — so the trail cannot
disagree with the record.

---

## The delete inventory

### Admin only — shared and financial data

| Endpoint | Why |
| --- | --- |
| `DELETE /api/companies/:id` | Shared master data. Every quotation, enquiry and project that ever named this client points at it, and the row is created by the link trigger the first time somebody types a new name. |
| `DELETE /api/contacts/:id` | Shared master data, created the same way and referenced the same way. |
| `DELETE /api/purchase-orders/:id` | A financial record. The PO value is what Due now, To bill and project profitability are computed against, and deleting one takes its service lines and payment stages with it. |
| `DELETE /api/po-services/:id` | The lines a PO's value is made of, so removing one silently changes what the project is worth. |
| `DELETE /api/payment-stages/:id` | The invoicing schedule — what has been raised, what is due, what has been paid. A deleted stage is an invoice the tracker stops accounting for. |

**Only the delete moved.** Creating and correcting these stays open to
everybody, on purpose: companies and contacts appear on their own from a
record's client name, and purchase orders, their lines and their stages are
entered by sales as ordinary work. An admin in front of any of that would
stop the job rather than protect anything.

### Admin only — reference data

`DELETE` on services, travel-vendors, expense-categories and exchange-rates,
via `adminOnlyWrites`. These are the Settings lists: one edit re-labels or
re-values every record that used the old value. Exchange rates reach
furthest — a rate is what every report converts at.

`DELETE /api/import/batches/:id` is admin-only because the whole import
router is.

### Open to any authenticated user — pending Phase 2

| Endpoint | Status |
| --- | --- |
| `DELETE /api/enquiries/:id` | unchanged |
| `DELETE /api/quotations/:id` | unchanged |
| `DELETE /api/projects/:id` | unchanged |
| `DELETE /api/onboarding/:id` | unchanged |
| `DELETE /api/travel-logs/:id` | unchanged |
| `DELETE /api/vendor-invoices/:id` | unchanged |
| `DELETE /api/expense-claims/:id` | unchanged |

These are a salesperson's own working records, and they stay deletable by
any authenticated user **until Phase 2 introduces ownership and row-scoping**.

That is the reason they are still open, and it is a real one rather than an
oversight. Right now the tracker cannot answer "whose record is this?" —
there is no owner column and no scoping. The only rules available are "any
authenticated user" and "admin only", and admin-only would mean a
salesperson cannot remove a quotation they mistyped ten seconds ago. So the
conservative rule went where the data is shared or financial, and the
permissive one stayed where the record belongs to the person working on it.

**Phase 2 is what settles this.** When records have an owner, the rule these
want is neither of the two above — it is "the person whose record it is, or
an admin". Until that exists, narrowing them would trade a real cost for no
gain.

There is a test asserting each of these is still open, so narrowing one
later is a deliberate change with a failing test behind it rather than
silent drift.

### Not an endpoint

Documents are never deleted directly. They go with the record that holds
them, through `hasDocument` / `cascadeDocuments` on the resource, so they
inherit whatever that resource's delete rule is — and the files leave
Cloudinary only once the delete has committed.

---

## Tests

`server/test/authorization.test.js` covers all of the above in database
mode, where there are two kinds of user to tell apart:

- every admin-only route: sales **403**, admin allowed, signed out **401**
- every admin-only delete: sales **403** *and the row still there*, admin
  **204** and then **404**
- for each of those five resources, that GET, PATCH and POST still work for
  a sales user — the half that would break the job if it regressed
- that the sales-workflow deletes above are still open

`server/test/usersApiShared.test.js` covers the shared admin, who is an
admin in every one of these.

`server/test/expenseClaimAuthorization.test.js` covers the money routes
above: that a sales user may submit a claim and correct its facts but
cannot decide, reimburse or correct one; that neither role reaches the
protected columns through the form; that the approver is the signed-in
account rather than the request body; that partial reimbursement still
totals cumulatively; and that vendor payments remain open to both roles.
Every refusal asserts the stored row as well as the status code.
