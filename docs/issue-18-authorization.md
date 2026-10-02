# Who may do what

The access rules the API enforces, and why each one is where it is (#18
Phase 1C, extended by #89).

Two roles exist: **admin** and **sales**. Everything below is enforced on
the server. The front end hides what a sales user may not do, but hiding is
a courtesy — the gate is the route.

In `AUTH_MODE=shared` there is one account and it is treated as an admin, so
that the real accounts can be prepared before the cutover. In
`AUTH_MODE=database` the role comes from the user's row and is re-read on
every request, so a change of role is in force on the very next one.

> **The tables in this document are generated.** They are written from
> `server/src/lib/authz/policy.js` by `npm run authz:docs`, and
> `server/test/authzDocs.test.js` fails the build when the file on disk no
> longer matches the policy. Edit the policy, not the table.

---

## The three answers

Every route the application mounts has exactly one of these, declared in
`server/src/lib/authz/policy.js`:

| Answer | Means |
| --- | --- |
| `public` | Reachable without the normal application sign-in. Every one of these must name the mechanism that *does* guard it, or say why nothing does. |
| `any` | Any signed-in application user, of either role. |
| `admin` | An administrator. |

Anything narrower than the route gate — this record is yours, this mailbox is
yours, this field is not yours to write — is recorded on the same entry as a
`restrictions` list, because a 200 from an `any` route can still be scoped to
the caller inside the handler.

**Rate limiting is not authentication.** A limiter bounds how fast a stranger
may knock; it never says who they are. The policy records the two separately
and a test asserts that no mechanism claiming to authenticate leans on one.

---

## The two enforcement mechanisms

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
argument in a router — not a new abstraction. Adding a **route** or a
**resource** additionally means adding an entry to the policy, because the
coverage test refuses a route nobody has decided about.

---

## How this is kept honest (#89)

| Piece | What it does |
| --- | --- |
| `src/lib/authz/routeInventory.js` | Enumerates every route the Express app actually mounts, by reading the app. It does not read the policy. |
| `src/lib/authz/policy.js` | The declaration: an access level for every route, and a read/write/delete level for every CRUD resource. |
| `src/lib/authz/check.js` | Holds the two against each other. Pure functions, so the coverage test can prove the check itself fails when it should. |
| `test/authzPolicy.test.js` | Fails when a mounted route is undeclared, a declared route is gone, an entry is duplicated or invalid, a public route has no documented mechanism, a CRUD resource has no policy, or a resource has drifted from it. |
| `test/authzRoleMatrix.test.js` | Drives anonymous, two sales users and an administrator against every declared route in `AUTH_MODE=database` on a throwaway database. |
| `test/authzDocs.test.js` | Fails when this document no longer matches the policy. |

The route inventory and the policy are deliberately separate files with no
import between them in that direction. Generating one from the other would
make a route nobody declared invisible, which is the failure the whole
arrangement exists to prevent.

---

## Public routes and what guards them

<!-- generated:public-routes -->
| Public route | Authenticated? | What is checked |
| --- | :--: | --- |
| `GET /api/public/accept/:token`<br>`GET /api/public/accept/:token/pdf`<br>`POST /api/public/accept/:token/accept`<br>`POST /api/public/accept/:token/changes` | **yes** | A 40-60 character random token from the emailed link, SHA-256 hashed and matched against quotation_acceptances.token_hash, with expiry, revision and status checked on every use. |
| `POST /api/mcp` | **yes** | An Authorization: Bearer ctz_... token, SHA-256 hashed and matched against a non-revoked api_tokens row, which also carries the role and person the token may see. |
| `POST /api/mail/notifications` | **yes** | Each notification must carry the clientState secret stored on the matching mail_folders subscription row; anything else is dropped. |
| `POST /api/hooks/enquiries` | **yes** | An x-cetizion-signature header of the form t=<unix seconds>,v1=<HMAC-SHA256 of "t.body" under INCOMING_WEBHOOK_SECRET>, compared in constant time over the raw body, with timestamps more than five minutes old refused so a captured call cannot be replayed; the route is 404 unless the secret is set and the feature is switched on in Settings. |
| `GET /metrics` | **yes** | Either a constant-time match against METRICS_TOKEN, or a staff session re-read from the database whose role is still admin. |
| `GET /api/health`<br>`GET /api/auth/config`<br>`POST /api/auth/logout`<br>`GET /api/auth/oauth/:provider/start`<br>`POST /api/portal/request-link`<br>`GET /api/mcp`<br>`DELETE /api/mcp` | no | Deliberately open. Nothing identifies the caller. |
| `GET /api/auth/oauth/:provider/callback` | **yes** | The provider redirects back with a code and a state. The state must equal the one in the signed, ten-minute cetizion_oauth handshake cookie, the PKCE verifier from that cookie is sent with the code exchange, and the resulting identity is matched to a users row before any session is issued. |
| `POST /api/portal/login` | **yes** | A single-use random token, SHA-256 hashed and matched against portal_links.token_hash, unused and within 20 minutes, exchanged under FOR UPDATE for a portal session. |
| `POST /api/portal/logout`<br>`GET /api/portal/me`<br>`GET /api/portal/projects`<br>`GET /api/portal/documents`<br>`GET /api/portal/invoices`<br>`GET /api/portal/invoices/statement.pdf`<br>`GET /api/portal/certificates`<br>`GET /api/portal/files/document/:id`<br>`GET /api/portal/files/quotation/:no`<br>`GET /api/portal/messages`<br>`POST /api/portal/messages` | **yes** | The signed cetizion_portal cookie (a key derived from SESSION_SECRET, distinct from the staff one) resolved to a live portal_sessions row, with the company still portal-enabled and the contact still permitted. |
| `POST /api/auth/login` | **yes** | A username or email and password, checked against the environment (shared mode) or the users table (database mode). |
| `GET /api/auth/me` | **yes** | The signed cetizion_session cookie, re-read against the users row on every request. |
| `GET /{*splat}` | no | The built single-page app: HTML, CSS and JavaScript with no data in it. Everything it displays it fetches from /api, which is gated. |
<!-- /generated:public-routes -->

`GET /api/health?deep=1` is the one route whose answer changes with the
caller: the plain answer is public, the detailed one resolves the session and
refuses anybody who is not a current administrator.

---

## Routes

Everything below the generated CRUD routers. Anything under `/api` with no
session is **401**, before any of these is considered.

<!-- generated:routes -->
| Route | Access | Why, or what narrows it |
| --- | :--: | --- |
| **/api/:resource** | | |
| `PATCH /api/:resource/:id/owner` | **admin** | Assigning, reassigning or unassigning a record moves somebody else's pipeline. Sales users already see only their own rows, so letting one of them set owner_user_id would let them take a record off a colleague, or hand their own away to hide it (#18 Phase 3). |
| `GET /api/:resource/:id/ownership-history` | **admin** | The handover trail for one record: who owned it, who changed that, and when. It names accounts other than the caller's, which is the administrator's view of the team rather than a salesperson's view of their own work (#18 Phase 3). |
| **/api/accounting** | | |
| `GET /api/accounting/entries` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `POST /api/accounting/import` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `GET /api/accounting/items` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `POST /api/accounting/items/:id/accept` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `POST /api/accounting/items/:id/resolve` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `GET /api/accounting/log` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `GET /api/accounting/mappings` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `POST /api/accounting/mappings` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `DELETE /api/accounting/mappings/:id` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `POST /api/accounting/reconcile` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `GET /api/accounting/reports/gstr1-b2b.csv` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `GET /api/accounting/reports/summary` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `GET /api/accounting/reports/tds.csv` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `GET /api/accounting/stages/:id/draft` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `POST /api/accounting/stages/:id/draft` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| `GET /api/accounting/status` | **admin** | The whole accounting router is admin-only: it is the books (#42). |
| `POST /api/accounting/sync` | **admin** | The whole accounting router is administrator-only: it is the books (#42). |
| **/api/activity** | | |
| `GET /api/activity` | **admin** | The audit log: what everybody did and when. Read-only and admin-only (#18 Phase 1.5). |
| **/api/api-tokens** | | |
| `GET /api/api-tokens` | **admin** | A token is a key to the tracker, and one issued with the admin role reads the whole company through MCP (#50). |
| `POST /api/api-tokens` | **admin** | Anybody who may issue a token may issue an admin one and read the whole company through MCP, whatever their own role is (#50). |
| `POST /api/api-tokens/:id/revoke` | **admin** | Revoking is the same power pointed the other way. |
| **/api/auth** | | |
| `GET /api/auth/account` | any | Scoped: self-only. |
| `PATCH /api/auth/account` | any | Scoped: self-only. |
| `DELETE /api/auth/account/identities/:provider` | any | Scoped: self-only. |
| `POST /api/auth/account/password` | any | Scoped: self-only. |
| `DELETE /api/auth/account/sessions/:id` | any | Scoped: self-only. |
| `POST /api/auth/account/sessions/revoke-all` | any | Scoped: self-only. |
| `GET /api/auth/config` | public | none — The sign-in form is drawn before anybody is signed in and has to know whether to ask for a username or an email. It returns the mode and nothing else. |
| `POST /api/auth/login` | public | staff-credentials — This is how a session is obtained. |
| `POST /api/auth/logout` | public | none — It only clears the caller's own cookie. Requiring a valid session to sign out would strand anybody holding an expired one. |
| `GET /api/auth/me` | public | staff-session-optional — Mounted before requireAuth so the front end can ask "am I signed in?" and get an answer rather than an error page. It resolves the session itself and 401s when there is none. |
| `GET /api/auth/oauth/:provider/callback` | public | oauth-provider-code — The provider redirects the browser here. There is no session yet — the handshake cookie, the state and the PKCE verifier are the credential. |
| `GET /api/auth/oauth/:provider/start` | public | none — The first leg of signing in with a provider: it mints a signed handshake cookie and redirects. It reads nothing, answers 404 for a provider that is not switched on, and the `next` it is given is refused unless it is a same-site path. |
| `GET /api/auth/providers` | **admin** | Which sign-in methods are configured, and how. It reports the provider set-up of the deployment, not the caller's own identities — those are on GET /api/auth/account. Carries its own requireAuth and requireAdmin because it is mounted before the /api gate. |
| **/api/cashflow** | | |
| `GET /api/cashflow` | any |  |
| **/api/client-errors** | | |
| `POST /api/client-errors` | any | Mounted after requireAuth: browser errors are reported by signed-in people only. |
| **/api/collections** | | |
| `GET /api/collections` | any |  |
| `GET /api/collections/log` | any |  |
| `POST /api/collections/log` | any |  |
| `POST /api/collections/stages/:id/hold` | **admin** | A hold takes a debt out of the chasing list and out of Due now. Deciding a debt is not chased is the admin's call. |
| `GET /api/collections/stages/:id/payments` | any |  |
| **/api/communications** | | |
| `GET /api/communications` | any |  |
| `POST /api/communications` | any |  |
| `GET /api/communications/contacts` | any |  |
| `GET /api/communications/no-contact` | any |  |
| **/api/companies** | | |
| `GET /api/companies/:id/full` | any |  |
| `POST /api/companies/:id/merge` | **admin** | A merge folds every record of one client into another and deletes the loser. It cannot be undone from the UI. |
| `GET /api/companies/duplicates` | any |  |
| **/api/dashboard** | | |
| `GET /api/dashboard/data-quality` | any |  |
| `GET /api/dashboard/overview` | any |  |
| `GET /api/dashboard/payables` | any | What we owe travel vendors, aged (#76). Open to both roles, deliberately and for the same reason GET /api/collections is: the person arranging the travel is the person chasing the bill. |
| `GET /api/dashboard/revenue-report` | any |  |
| `GET /api/dashboard/sales-report` | any |  |
| `GET /api/dashboard/travel` | any |  |
| `GET /api/dashboard/worklist` | any |  |
| **/api/deliverables** | | |
| `GET /api/deliverables` | any |  |
| `POST /api/deliverables` | any |  |
| `DELETE /api/deliverables/:id` | any |  |
| `GET /api/deliverables/:id` | any |  |
| `PATCH /api/deliverables/:id` | any |  |
| `POST /api/deliverables/:id/supersede` | any |  |
| `POST /api/deliverables/:id/withdraw` | any |  |
| **/api/documents** | | |
| `POST /api/documents` | any |  |
| `GET /api/documents/:id` | any |  |
| **/api/emails** | | |
| `GET /api/emails` | any |  |
| `GET /api/emails/:id` | any |  |
| `POST /api/emails/test` | **admin** | It sends real mail to an address the caller names — an effect outside the application. |
| **/api/expense-claims** | | |
| `POST /api/expense-claims/:id/correct` | **admin** | The only route that can move a recorded reimbursement total back down, so it is the one place a figure already booked against a claim can be changed (#85). It refuses to run without a reason, caps the figure at what was claimed, and records the before and after in the same transaction as the change. Reimbursing adds; correcting rewrites — and because amount_reimbursed is a single column rather than a ledger, the activity row is the only surviving trace of the larger figure. An administrator is the answer for the same reason /decide is: this is the correction path for money, not a tidy-up. |
| `POST /api/expense-claims/:id/decide` | **admin** | Approving, rejecting or holding an expense claim is the administrator's decision. An approval anybody can grant themselves is not an approval (#85). |
| `POST /api/expense-claims/:id/reimburse` | **admin** | Reimbursement moves money out of the business (#85). |
| **/api/export** | | |
| `GET /api/export/:resource.csv` | any |  |
| `GET /api/export/:resource.xlsx` | any |  |
| `GET /api/export/payables.csv` | any | The same rows as GET /api/dashboard/payables, so it carries the same answer. |
| `GET /api/export/sales-report.pdf` | any |  |
| `GET /api/export/sales-report/:report.csv` | any |  |
| **/api/follow-ups** | | |
| `GET /api/follow-ups` | any | Scoped: record-owner. |
| `GET /api/follow-ups/record` | any | Scoped: record-owner. |
| `GET /api/follow-ups/summary` | **admin** | How each salesperson answers their reminders is a management view of the whole team. |
| **/api/health** | | |
| `GET /api/health` | public | none — The platform needs somewhere to point a health check. It answers only that the database replied, when the process started, the environment name and the auth mode — the last of which /api/auth/config already tells any caller. ?deep=1 is checked inside the handler and needs an administrator. |
| **/api/hooks** | | |
| `POST /api/hooks/enquiries` | public | hmac-signature — An external form posts an enquiry (#49). Off entirely unless the secret is set and Settings enables it. |
| **/api/import** | | |
| `GET /api/import/batches` | **admin** | Import batches carry whole spreadsheets of other people's records. |
| `POST /api/import/batches` | **admin** | Uploading a sheet to import. |
| `DELETE /api/import/batches/:id` | **admin** | The whole import router is administrator-only: a commit writes records in bulk, under somebody else's name, across every table the sheet touches. |
| `GET /api/import/batches/:id` | **admin** | The whole import router is administrator-only: a commit writes records in bulk, under somebody else's name, across every table the sheet touches. |
| `POST /api/import/batches/:id/commit` | **admin** | A commit writes every row of the batch into the live tables. |
| `POST /api/import/batches/:id/duplicates` | **admin** | The whole import router is administrator-only: a commit writes records in bulk, under somebody else's name, across every table the sheet touches. |
| `POST /api/import/batches/:id/replan` | **admin** | The whole import router is administrator-only: a commit writes records in bulk, under somebody else's name, across every table the sheet touches. |
| `PATCH /api/import/items/:id` | **admin** | The whole import router is administrator-only: a commit writes records in bulk, under somebody else's name, across every table the sheet touches. |
| `GET /api/import/template.csv` | **admin** | The whole import router is admin-only: a commit writes records in bulk under somebody else's name. |
| **/api/inbox** | | |
| `GET /api/inbox` | any | Scoped: mailbox-delegate. |
| `GET /api/inbox/:id` | any | Scoped: mailbox-delegate. |
| `PATCH /api/inbox/:id` | any | Scoped: mailbox-delegate. |
| `POST /api/inbox/:id/convert` | any | Scoped: mailbox-delegate. |
| `POST /api/inbox/:id/reply` | any | Scoped: mailbox-delegate. |
| `GET /api/inbox/canned` | any |  |
| `POST /api/inbox/canned` | any |  |
| `DELETE /api/inbox/canned/:id` | any | ownCanned: the author or an admin. |
| `PATCH /api/inbox/canned/:id` | any | ownCanned: the author or an admin. |
| `GET /api/inbox/inboxes` | any |  |
| `POST /api/inbox/inboxes` | **admin** | An inbox and its membership decide whose queue a client's mail lands in. |
| `DELETE /api/inbox/inboxes/:id` | **admin** | Removing a shared inbox decides where a client's mail stops landing, for everybody. |
| `PATCH /api/inbox/inboxes/:id` | **admin** | An inbox and its membership decide whose queue a client's mail lands in. |
| `GET /api/inbox/summary` | any | Scoped: mailbox-delegate. |
| **/api/jobs** | | |
| `GET /api/jobs` | any |  |
| `POST /api/jobs/:name/run` | **admin** | A job by hand emails every client it decides is due. Not a preview, and not the caller's own records. |
| **/api/kpis** | | |
| `GET /api/kpis/me` | any | Scoped: self-only. |
| `GET /api/kpis/targets` | any | A salesperson sees the targets set for them; asking after somebody else's is refused in the handler the same way as /users/:userId. |
| `GET /api/kpis/team` | **admin** | Every salesperson's figures side by side. That is the manager's view of the team, and one salesperson comparing themselves against a named colleague is not what these numbers are for (#18 §5). |
| `GET /api/kpis/users/:userId` | any | The handler refuses another salesperson with 403 rather than an empty list: an empty list reads as "no work done", which is a different and worse answer than "not yours to see". An admin may read anybody's. |
| `PUT /api/kpis/users/:userId/targets/:metric` | **admin** | A target is what somebody is measured against, so setting your own would make the measurement meaningless (#18 §5). |
| **/api/lookups** | | |
| `GET /api/lookups` | any |  |
| `GET /api/lookups/next-id/:kind` | any |  |
| **/api/mail** | | |
| `POST /api/mail/notifications` | public | graph-client-state — Microsoft Graph posts here and has no session. A notification whose clientState does not match the stored subscription secret is ignored. |
| `GET /api/mail/threads` | any | Scoped: mailbox-owner, mailbox-delegate. |
| `GET /api/mail/threads/:id` | any | Scoped: mailbox-owner, mailbox-delegate. |
| `PATCH /api/mail/threads/:id` | any | Scoped: mailbox-owner, mailbox-delegate. |
| `POST /api/mail/threads/:id/reply` | any | Scoped: mailbox-owner, mailbox-delegate. |
| **/api/mailboxes** | | |
| `GET /api/mailboxes` | any | Scoped: mailbox-owner, mailbox-delegate. |
| `PATCH /api/mailboxes/:id` | any | Scoped: mailbox-owner. |
| `POST /api/mailboxes/:id/disconnect` | any | Scoped: mailbox-owner. |
| `POST /api/mailboxes/:id/refresh-bodies` | any | Scoped: mailbox-owner. |
| `POST /api/mailboxes/:id/sync` | any | Scoped: mailbox-owner. |
| `POST /api/mailboxes/:id/test-messages` | **admin** | Writes sample messages into a real connected mailbox. |
| `GET /api/mailboxes/blocklist` | any |  |
| `POST /api/mailboxes/blocklist` | **admin** | The blocklist decides whose mail the application will never sync, for everybody. |
| `DELETE /api/mailboxes/blocklist/:id` | **admin** | The blocklist decides whose mail the application will never sync, for everybody; removing an entry starts that mail flowing again. |
| `GET /api/mailboxes/connect/microsoft` | any |  |
| `GET /api/mailboxes/oauth/microsoft` | any |  |
| `POST /api/mailboxes/test` | **admin** | Probes the Microsoft app registration — a credential check, not a mailbox action. |
| **/api/mcp** | | |
| `DELETE /api/mcp` | public | none — A fixed 405 with an empty body, for MCP clients that try to end a session this stateless server never opened. |
| `GET /api/mcp` | public | none — A fixed 405 telling a client to use POST. It reads nothing and reveals nothing. |
| `POST /api/mcp` | public | api-token — MCP clients authenticate with an API token instead of a session (#50). No token, no answer. |
| **/api/notifications** | | |
| `GET /api/notifications` | any | Scoped: record-owner. |
| `POST /api/notifications/:id/read` | any | Scoped: record-owner. |
| `POST /api/notifications/read-all` | any | Scoped: record-owner. |
| `GET /api/notifications/summary` | any | Scoped: record-owner. |
| `POST /api/notifications/sweep` | **admin** | The same work as the notifications.daily job. Running a job by hand is operational. |
| **/api/payment-stages** | | |
| `POST /api/payment-stages/:id/invoice` | any |  |
| `POST /api/payment-stages/:id/payment` | any |  |
| **/api/pipeline** | | |
| `GET /api/pipeline` | any |  |
| `POST /api/pipeline/:key/move` | any |  |
| **/api/portal** | | |
| `GET /api/portal/certificates` | public | portal-session — The client's own certificates. |
| `GET /api/portal/documents` | public | portal-session — The client's own documents. |
| `GET /api/portal/files/document/:id` | public | portal-session — A document file, checked against the session's company before it is served. |
| `GET /api/portal/files/quotation/:no` | public | portal-session — A quotation PDF, checked against the session's company before it is served. |
| `GET /api/portal/invoices` | public | portal-session — The client's own invoices. |
| `GET /api/portal/invoices/statement.pdf` | public | portal-session — The client's own statement. |
| `POST /api/portal/login` | public | portal-link-token — Exchanges the emailed single-use token for a portal session. |
| `POST /api/portal/logout` | public | portal-session — Portal routes sit outside the staff sign-in and carry their own session. |
| `GET /api/portal/me` | public | portal-session — Who the portal session belongs to. |
| `GET /api/portal/messages` | public | portal-session — The client's own messages. |
| `POST /api/portal/messages` | public | portal-session — The client writes to us. |
| `GET /api/portal/projects` | public | portal-session — The client's own projects. |
| `POST /api/portal/request-link` | public | none — A client asks for a sign-in link. It answers the same sentence whether or not the address belongs to a portal-enabled contact, so it confirms nothing. |
| **/api/portal-admin** | | |
| `GET /api/portal-admin/companies/:id` | **admin** | Who outside the company may see this client's records (#47). |
| `PATCH /api/portal-admin/companies/:id` | **admin** | Switching the portal on and choosing its sections. |
| `PATCH /api/portal-admin/contacts/:id` | **admin** | Granting or withdrawing a client contact's portal access. |
| `POST /api/portal-admin/contacts/:id/invite` | **admin** | Emailing a sign-in link to somebody outside the company. |
| **/api/profitability** | | |
| `GET /api/profitability` | **admin** | Delivery cost against PO value is what the business earns (#39). |
| `GET /api/profitability/projects/:id` | **admin** | One project's delivery cost against its PO value is what the business earns on it (#39). |
| **/api/projects** | | |
| `GET /api/projects/:projectId/full` | any |  |
| `POST /api/projects/:projectId/onboarding/apply-template` | any |  |
| **/api/public** | | |
| `GET /api/public/accept/:token` | public | acceptance-link-token — A client opens the quotation addressed to them (#53) without an account. |
| `POST /api/public/accept/:token/accept` | public | acceptance-link-token — The client accepts the quotation the token is bound to. |
| `POST /api/public/accept/:token/changes` | public | acceptance-link-token — The client asks for changes to the quotation the token is bound to. |
| `GET /api/public/accept/:token/pdf` | public | acceptance-link-token — The same quotation as a PDF. |
| **/api/purchase-orders** | | |
| `GET /api/purchase-orders/:poNumber/full` | any |  |
| `POST /api/purchase-orders/:poNumber/stages` | any |  |
| **/api/quotations** | | |
| `POST /api/quotations/:id/convert` | any |  |
| `POST /api/quotations/:key/accept` | any |  |
| `POST /api/quotations/:key/acceptance-link` | any |  |
| `GET /api/quotations/:key/acceptances` | any |  |
| `POST /api/quotations/:key/acceptances/:id/revoke` | any |  |
| `POST /api/quotations/:key/approval/decide` | **admin** | An approval you can grant yourself is not an approval. A discount past the threshold is decided by somebody else. |
| `POST /api/quotations/:key/approval/request` | any |  |
| `GET /api/quotations/:key/full` | any |  |
| `GET /api/quotations/:key/pdf` | any |  |
| `POST /api/quotations/:key/register` | any |  |
| `POST /api/quotations/:key/revise` | any |  |
| `POST /api/quotations/:key/send` | any |  |
| **/api/renewals** | | |
| `GET /api/renewals` | any |  |
| `POST /api/renewals/:id/cancel` | any |  |
| `POST /api/renewals/:id/open` | any |  |
| `POST /api/renewals/discover` | **admin** | Running the discovery sweep by hand is an operational act; it creates renewal records across every client. |
| `POST /api/renewals/manual` | any |  |
| **/api/reports** | | |
| `GET /api/reports/by-status` | any | Open deals by the status on the record, which is not always where its pipeline stage puts it. |
| `GET /api/reports/conversion` | any | Win rate grouped by owner, sector or service. The grouping column is chosen from a fixed map in the route, never taken from the query string. |
| `GET /api/reports/quoted-won` | any | Quoted against won by month, in INR; quotations in other currencies are counted and reported separately rather than converted at today's rate into a month that has passed. |
| `GET /api/reports/sales` | any | The Reports section's questions for a period (enquiries received, their outcome, monthly revenue). Every query reads the scoped sources; ?owner= narrows an admin's view to one salesperson and is ignored for a sales user. |
| `GET /api/reports/win-rate` | any | Win rate by financial quarter. Scoped: before #18 Phase 2C this summed every quotation for anyone signed in, which the note here used to justify by saying both roles see quotations anyway — no longer true once the list itself was scoped. |
| **/api/search** | | |
| `GET /api/search` | any | One request across every record type behind Cmd+K (#75). It ranks and returns what the caller may already list; it opens nothing a list page does not. |
| **/api/settings** | | |
| `GET /api/settings` | any |  |
| `PATCH /api/settings/:key` | **admin** | A setting re-aims the whole application: which mailbox syncs, whether margin is visible, whether incoming webhooks are on. |
| **/api/tasks** | | |
| `GET /api/tasks/summary` | any |  |
| **/api/timeline** | | |
| `GET /api/timeline` | any |  |
| **/api/travel-logs** | | |
| `GET /api/travel-logs/:travelId/full` | any |  |
| **/api/users** | | |
| `GET /api/users` | **admin** | The account list, including roles and who is switched off. |
| `POST /api/users` | **admin** | Creating an account is handing out a key. |
| `PATCH /api/users/:id` | **admin** | Changing a role or switching an account off. |
| `POST /api/users/:id/password` | **admin** | Setting somebody's password. |
| **/api/vendor-invoices** | | |
| `POST /api/vendor-invoices/:id/pay` | any | Recording a vendor payment is ordinary work for admin and sales, so the gate stays open — but amount_paid and payment_date must move only through here, never through PATCH /api/vendor-invoices/:id. |
| **/api/views** | | |
| `GET /api/views` | any | Scoped: record-owner. |
| `POST /api/views` | any | Scoped: record-owner. |
| `DELETE /api/views/:id` | any | Scoped: record-owner. |
| `PATCH /api/views/:id` | any | Scoped: record-owner. |
| `POST /api/views/order` | any | Scoped: record-owner. |
| **/api/visits** | | |
| `GET /api/visits` | any |  |
| `POST /api/visits` | any |  |
| `DELETE /api/visits/:id` | any |  |
| `GET /api/visits/:id` | any |  |
| `PATCH /api/visits/:id` | any |  |
| `POST /api/visits/:id/trip` | any |  |
| `GET /api/visits/capacity` | any |  |
| `POST /api/visits/check` | any |  |
| `DELETE /api/visits/leave/:id` | **admin** | Removing somebody else's leave. |
| `GET /api/visits/staff` | any |  |
| `POST /api/visits/staff` | **admin** | The engineer roster is shared scheduling data; adding to it changes everybody's capacity figures. |
| `PATCH /api/visits/staff/:id` | **admin** | The engineer roster is shared scheduling data; editing it changes everybody's capacity figures. |
| `POST /api/visits/staff/:id/leave` | **admin** | Booking somebody else's leave. |
| `GET /api/visits/today` | any |  |
| **/api/webhooks** | | |
| `GET /api/webhooks` | **admin** | The whole outgoing-webhook router is admin-only: an endpoint here sends this company's data to an address somebody types (#49). |
| `POST /api/webhooks` | **admin** | The whole outgoing-webhook router is administrator-only: an endpoint here sends this company's data to an address somebody types (#49). |
| `DELETE /api/webhooks/:id` | **admin** | The whole outgoing-webhook router is administrator-only: an endpoint here sends this company's data to an address somebody types (#49). |
| `PATCH /api/webhooks/:id` | **admin** | The whole outgoing-webhook router is administrator-only: an endpoint here sends this company's data to an address somebody types (#49). |
| `POST /api/webhooks/:id/rotate-secret` | **admin** | The whole outgoing-webhook router is administrator-only: an endpoint here sends this company's data to an address somebody types (#49). |
| `POST /api/webhooks/:id/test` | **admin** | The whole outgoing-webhook router is administrator-only: an endpoint here sends this company's data to an address somebody types (#49). |
| `GET /api/webhooks/deliveries` | **admin** | Delivery bodies contain the records that were sent. |
| `POST /api/webhooks/deliveries/:id/replay` | **admin** | Re-sends data to the external endpoint. |
| `POST /api/webhooks/run` | **admin** | Running the delivery job by hand. |
| **/metrics** | | |
| `GET /metrics` | public | metrics-token-or-admin-session — Mounted outside /api so a scraper can reach it with a bearer token, but it refuses anyone who is neither the token holder nor a current administrator. |
| **the web app** | | |
| `GET /{*splat}` | public | web-app-shell — The built single-page app is static files with no data in them; every figure it shows it fetches from /api, which is gated. |
<!-- /generated:routes -->

Reading is open in most rows where writing is not. The lists, rates and logs
fill the forms and answer the questions a sales user needs to do the job; the
gate is on making something happen, not on looking.

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

Each of these is one generic CRUD router with five routes: `GET /api/<name>`,
`GET /api/<name>/:id`, `POST /api/<name>`, `PATCH /api/<name>/:id` and
`DELETE /api/<name>/:id`. "any" means any authenticated user, of either role.

<!-- generated:resources -->
| Resource | GET | POST / PATCH | DELETE | Why |
| --- | :--: | :--: | :--: | --- |
| `attachments` | any | any | any | A salesperson's own working record. Open until ownership and row scoping land (#18 Phase 2). |
| `companies` | any | any | **admin** | Shared master data. Every record that ever named this client points at it, and the link trigger creates one on its own. |
| `contacts` | any | any | **admin** | Shared master data, created and referenced the same way. |
| `engagements` | any | any | any | A salesperson's own working record. Open until ownership and row scoping land (#18 Phase 2). |
| `enquiries` | any | any | any | A salesperson's own working record. An enquiry is the first record of a lead, and entering and working one is ordinary sales work, so the gate is open to both roles — but it is not open on every row: ownerScoped scopes every read, write and delete to the records the caller owns (#18 Phase 2C). An administrator sees all of them. |
| `exchange-rates` | any | **admin** | **admin** | One rate re-values every historical deal in every report. |
| `expense-categories` | any | **admin** | **admin** | A Settings catalogue: one edit re-labels every record that used the old value. |
| `expense-claims` | any | any | any | Admin and sales both submit ordinary expense claims. Protected fields: `approval_status`, `approved_by`, `amount_reimbursed`, `reimbursement_date`. |
| `holidays` | any | **admin** | **admin** | The working calendar. A holiday decides which days count towards a reply clock, a follow-up deadline and every "working days" figure, so one edit moves what the whole company is judged late by. Correcting the dates that move each year is an administrator's job (adminOnlyWrites). |
| `lead-sources` | any | **admin** | **admin** | A Settings catalogue: one edit re-labels every record that used the old value. |
| `lost-reasons` | any | **admin** | **admin** | A Settings catalogue: one edit re-labels every record that used the old value. |
| `notes` | any | any | any | A salesperson's own working record. Open until ownership and row scoping land (#18 Phase 2). |
| `onboarding` | any | any | any | A salesperson's own working record. Open until ownership and row scoping land (#18 Phase 2). |
| `onboarding-template-lines` | any | **admin** | **admin** | The steps an onboarding template is made of, so editing one rewrites the plan of every project made from it. |
| `onboarding-templates` | any | **admin** | **admin** | A template writes the onboarding steps of every project made from it. |
| `payment-stages` | any | any | **admin** | The invoicing schedule: what has been raised, what is due, what has been paid. |
| `payment-terms-template-lines` | any | **admin** | **admin** | The lines a payment-terms template is made of, so editing one rewrites the schedule of every PO made from it. |
| `payment-terms-templates` | any | **admin** | **admin** | A template writes the payment schedule of every PO made from it. |
| `payments` | any | **admin** | **admin** | The receipts ledger. A payment row is what says a client has paid. |
| `pipeline-stages` | any | **admin** | **admin** | A stage's status mapping and probability rewrite quotation statuses and the whole forecast. |
| `po-services` | any | any | **admin** | The lines a PO's value is made of. |
| `project-costs` | any | **admin** | **admin** | Delivery cost is one half of what the business earns on a project (#39). |
| `project-milestones` | any | any | any | What a project must reach before an On Milestone stage can be invoiced (#26). Entering and reaching milestones is ordinary delivery work, so the gate is open — but it is not open on every project: ownerScopedBy: 'project' scopes every read, update and delete to projects the caller owns, through the project's owner_user_id rather than the project_manager name column (the review of #115, #119; #18 Phase 2C). Without that scoping an open PATCH here would let any signed-in user stamp another project's milestone as reached and push it into the invoice run, the cash-flow forecast and the ageing. |
| `projects` | any | any | any | A salesperson's own working record. A project is the work won from one, and entering and working one is ordinary sales work, so the gate is open to both roles — but it is not open on every row: ownerScoped scopes every read, write and delete to the records the caller owns (#18 Phase 2C). An administrator sees all of them. |
| `purchase-orders` | any | any | **admin** | The PO value is what Due now, To bill and profitability are computed against, and deleting one takes its lines and stages with it. |
| `quotation-lines` | any | any | any | The lines of a quotation, edited with it. |
| `quotations` | any | any | any | A salesperson's own working record. A quotation is the offer made on one, and entering and working one is ordinary sales work, so the gate is open to both roles — but it is not open on every row: ownerScoped scopes every read, write and delete to the records the caller owns (#18 Phase 2C). An administrator sees all of them. |
| `services` | any | **admin** | **admin** | A Settings catalogue: one edit re-labels every record that used the old value. |
| `tasks` | any | any | any | A salesperson's own working record. Open until ownership and row scoping land (#18 Phase 2). |
| `travel-logs` | any | any | any | A salesperson's own working record. Open until ownership and row scoping land (#18 Phase 2). |
| `travel-vendors` | any | **admin** | **admin** | A Settings catalogue: one edit re-labels every record that used the old value. |
| `vendor-invoices` | any | any | any | Sales enter vendor invoices as ordinary work. Protected fields: `amount_paid`, `payment_date`. |
<!-- /generated:resources -->

### Documents are not an endpoint

Documents are never deleted directly. They go with the record that holds
them, through `hasDocument` / `cascadeDocuments` on the resource, so they
inherit whatever that resource's delete rule is — and the files leave
Cloudinary only once the delete has committed.

### Why a salesperson's own records are still deletable by anybody

`enquiries`, `quotations`, `projects`, `onboarding`, `travel-logs`,
`engagements`, `tasks`, `notes` and `attachments` are deletable by any
authenticated user, and that is a decision rather than an oversight. The
tracker cannot yet answer "whose record is this?" — there is no owner column
and no row scoping — so the only rules available are "any authenticated user"
and "admin only", and admin-only would mean a salesperson cannot remove a
quotation they mistyped ten seconds ago.

The rule these want is neither: it is "the person whose record it is, or an
admin". **#18 Phase 2 is what settles it.** The policy entries above are what
must change when ownership and row scoping land.

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

## Known gaps

### Issue #18 Phase 2 — ownership, row scoping and the activity log

Work on the other branches adds routes and narrows existing ones. When it is
integrated, the policy needs:

- **Ownership and row scoping.** The nine resources listed above move from
  `delete: 'any'` to an owner-or-admin rule, which is a fourth answer the
  three-level vocabulary does not yet have. Expect a `record-owner`
  restriction on their `PATCH` and `DELETE` entries and a matching role-matrix
  test proving sales user B cannot delete sales user A's quotation.
- **Assignment history and sales KPI routes.** Any route those add is a new
  policy entry; the coverage test will name each one until it has one.
- **The activity log.** `GET /api/activity` is already declared admin-only
  here. Anything Phase 2 adds under it needs the same.

---

## Running the checks

```sh
cd server
npm test                       # includes the coverage and role-matrix tests
npm run authz:docs             # rewrite the tables above from the policy
npm run authz:docs -- --check  # fail if this document is out of date
```

The role matrix needs a Postgres it may create databases on:
`TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`. It
creates one named `authz_matrix_*`, loads `db/schema.sql` and `db/views.sql`
into it, and drops only that database afterwards. Without the variable the
suite skips rather than passing quietly; CI sets it.

### What the suites cover

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
