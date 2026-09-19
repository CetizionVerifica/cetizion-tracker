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
| `GET /api/lookups`, `/api/dashboard`, `/api/export`, `/api/documents` | ✅ | ✅ |

Anything under `/api` with no session is **401**, before any of the above is
considered.

Reading is open in every row where writing is not. The lists, rates and logs
fill the forms and answer the questions a sales user needs to do the job;
the gate is on making something happen, not on looking.

---

## Resources

| Resource | GET | POST / PATCH | DELETE |
| --- | :--: | :--: | :--: |
| enquiries | any | any | **any** |
| quotations | any | any | **any** |
| projects | any | any | **any** |
| onboarding | any | any | **any** |
| travel-logs | any | any | **any** |
| vendor-invoices | any | any | **any** |
| expense-claims | any | any | **any** |
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
