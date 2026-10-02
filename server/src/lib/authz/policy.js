/**
 * Who may reach every route this API mounts (#89).
 *
 * This file is the declaration; `routeInventory.js` is the discovery. The
 * coverage test in `test/authzPolicy.test.js` holds the two against each
 * other, so a route added without a decision here fails the build, and an
 * entry here for a route that no longer exists fails it too.
 *
 * ## The three answers
 *
 *   public   reachable without the normal application sign-in. Every one of
 *            these must name the mechanism that *does* guard it, or say in
 *            `openBecause` why nothing does. Rate limiting is not one of the
 *            mechanisms: it bounds how fast a stranger may knock, never who
 *            they are.
 *   any      any signed-in application user, of either role.
 *   admin    an administrator.
 *
 * `access` is the gate on the route. Anything narrower — this record is
 * yours, this mailbox is yours, this field is not yours to write — is a
 * `restrictions` entry as well, because a 200 from an `any` route can still
 * be scoped to the caller inside the handler.
 */

export const ACCESS_LEVELS = ['public', 'any', 'admin'];

/**
 * The ways a caller can be identified without an application session.
 *
 * `authenticates` is the honest field: it is true only where something the
 * caller presents is checked against something we hold. A limiter, a hard to
 * guess URL or an obscure path is not authentication and is recorded here as
 * `authenticates: false` so nothing can quietly be counted as a lock.
 */
export const AUTH_MECHANISMS = {
  none: {
    authenticates: false,
    proof: null,
    description: 'Deliberately open. Nothing identifies the caller.',
  },
  'staff-credentials': {
    authenticates: true,
    proof: 'A username or email and password, checked against the environment (shared mode) or the users table (database mode).',
    description: 'The sign-in route itself: open because it is how a session is obtained.',
  },
  'staff-session-optional': {
    authenticates: true,
    proof: 'The signed cetizion_session cookie, re-read against the users row on every request.',
    description: 'Mounted outside requireAuth, but answers only a caller whose session it verifies itself; otherwise 401.',
  },
  'acceptance-link-token': {
    authenticates: true,
    proof: 'A 40-60 character random token from the emailed link, SHA-256 hashed and matched against quotation_acceptances.token_hash, with expiry, revision and status checked on every use.',
    description: 'A client opening their own quotation (#53). The token is the credential and it is bound to one quotation.',
  },
  'portal-link-token': {
    authenticates: true,
    proof: 'A single-use random token, SHA-256 hashed and matched against portal_links.token_hash, unused and within 20 minutes, exchanged under FOR UPDATE for a portal session.',
    description: 'The client portal sign-in (#47). request-link answers identically whether or not the address is known.',
  },
  'portal-session': {
    authenticates: true,
    proof: 'The signed cetizion_portal cookie (a key derived from SESSION_SECRET, distinct from the staff one) resolved to a live portal_sessions row, with the company still portal-enabled and the contact still permitted.',
    description: 'The portal session, checked against the database on every request so revoking access bites at once.',
  },
  'graph-client-state': {
    authenticates: true,
    proof: 'Each notification must carry the clientState secret stored on the matching mail_folders subscription row; anything else is dropped.',
    description: 'Microsoft Graph mail notifications. Graph has no session, so the shared secret per subscription is the credential.',
  },
  'hmac-signature': {
    authenticates: true,
    proof: 'An x-cetizion-signature header of the form t=<unix seconds>,v1=<HMAC-SHA256 of "t.body" under INCOMING_WEBHOOK_SECRET>, compared in constant time over the raw body, with timestamps more than five minutes old refused so a captured call cannot be replayed; the route is 404 unless the secret is set and the feature is switched on in Settings.',
    description: 'Incoming enquiry webhooks (#49).',
  },
  'oauth-provider-code': {
    authenticates: true,
    proof: 'The provider redirects back with a code and a state. The state must equal the one in the signed, ten-minute cetizion_oauth handshake cookie, the PKCE verifier from that cookie is sent with the code exchange, and the resulting identity is matched to a users row before any session is issued.',
    description: 'The OAuth sign-in callback. Open because it is how a session is obtained; the handshake cookie is what stops a code obtained elsewhere being redeemed here.',
  },
  'api-token': {
    authenticates: true,
    proof: 'An Authorization: Bearer ctz_... token, SHA-256 hashed and matched against a non-revoked api_tokens row, which also carries the role and person the token may see.',
    description: 'MCP clients (#50). The token, not a session, is the identity.',
  },
  'metrics-token-or-admin-session': {
    authenticates: true,
    proof: 'Either a constant-time match against METRICS_TOKEN, or a staff session re-read from the database whose role is still admin.',
    description: 'Prometheus scrape endpoint (#38). Never public.',
  },
  'web-app-shell': {
    authenticates: false,
    proof: null,
    description: 'The built single-page app: HTML, CSS and JavaScript with no data in it. Everything it displays it fetches from /api, which is gated.',
  },
};

/**
 * Restrictions that apply on top of the route gate. These are what make a
 * 200 narrower than "any signed-in user may do this to any row".
 */
export const RESTRICTIONS = {
  'record-owner': 'The handler limits the rows to ones belonging to the caller.',
  'parent-owner': 'Reachable only through a parent record the caller may already see.',
  'self-only': 'The caller may act on their own account or their own row, not on somebody else\'s.',
  'mailbox-owner': 'Limited to a mailbox the caller owns.',
  'mailbox-delegate': 'Limited to a mailbox the caller has been named on, or an unassigned team inbox.',
  'portal-section': 'The client\'s company must have this portal section switched on.',
  'protected-fields': 'Some columns may not be written here; they move only through their own authorised route.',
  'api-token-scope': 'Limited to what the presented API token\'s role and person allow, and to reads unless the token may write.',
  'settings-override': 'Admin-only unless a named setting opens it to everybody.',
};

const mustBeAdmin = 'admin';
const signedIn = 'any';

/**
 * Explicit routes: everything that is not one of the generated CRUD routers.
 *
 * `why` is required on public and admin entries — a gate without a reason is
 * a gate nobody can review.
 */
export const routes = [
  // -------------------------------------------------------------- health
  {
    method: 'GET', path: '/api/health', access: 'public', mechanism: 'none',
    openBecause: 'The platform needs somewhere to point a health check. It answers only that the database replied, when the process started, the environment name and the auth mode — the last of which /api/auth/config already tells any caller. ?deep=1 is checked inside the handler and needs an administrator.',
    restrictions: ['self-only'],
    note: 'GET /api/health?deep=1 requires an admin session: healthHandler resolves currentUser and refuses anyone else.',
  },

  // ---------------------------------------------------------------- auth
  { method: 'POST', path: '/api/auth/login', access: 'public', mechanism: 'staff-credentials', openBecause: 'This is how a session is obtained.' },
  { method: 'GET', path: '/api/auth/config', access: 'public', mechanism: 'none', openBecause: 'The sign-in form is drawn before anybody is signed in and has to know whether to ask for a username or an email. It returns the mode and nothing else.' },
  { method: 'POST', path: '/api/auth/logout', access: 'public', mechanism: 'none', openBecause: 'It only clears the caller\'s own cookie. Requiring a valid session to sign out would strand anybody holding an expired one.' },
  { method: 'GET', path: '/api/auth/me', access: 'public', mechanism: 'staff-session-optional', openBecause: 'Mounted before requireAuth so the front end can ask "am I signed in?" and get an answer rather than an error page. It resolves the session itself and 401s when there is none.', restrictions: ['self-only'] },

  // The OAuth handshake (#71). Both sit outside the /api requireAuth, because
  // signing in is what they are for.
  { method: 'GET', path: '/api/auth/oauth/:provider/start', access: 'public', mechanism: 'none', openBecause: 'The first leg of signing in with a provider: it mints a signed handshake cookie and redirects. It reads nothing, answers 404 for a provider that is not switched on, and the `next` it is given is refused unless it is a same-site path.' },
  { method: 'GET', path: '/api/auth/oauth/:provider/callback', access: 'public', mechanism: 'oauth-provider-code', openBecause: 'The provider redirects the browser here. There is no session yet — the handshake cookie, the state and the PKCE verifier are the credential.' },

  // The personal account page (#71). Mounted outside the /api requireAuth,
  // so accountRouter carries its own: requireAuth, then a database-mode
  // check that 404s a deployment signing in with one shared account.
  { method: 'GET', path: '/api/auth/account', access: signedIn, restrictions: ['self-only'] },
  { method: 'PATCH', path: '/api/auth/account', access: signedIn, restrictions: ['self-only'] },
  { method: 'POST', path: '/api/auth/account/password', access: signedIn, restrictions: ['self-only'] },
  { method: 'DELETE', path: '/api/auth/account/identities/:provider', access: signedIn, restrictions: ['self-only'] },
  { method: 'DELETE', path: '/api/auth/account/sessions/:id', access: signedIn, restrictions: ['self-only'] },
  { method: 'POST', path: '/api/auth/account/sessions/revoke-all', access: signedIn, restrictions: ['self-only'] },
  { method: 'GET', path: '/api/auth/providers', access: mustBeAdmin, why: 'Which sign-in methods are configured, and how. It reports the provider set-up of the deployment, not the caller\'s own identities — those are on GET /api/auth/account. Carries its own requireAuth and requireAdmin because it is mounted before the /api gate.' },

  // ------------------------------------------------ public quotation link
  { method: 'GET', path: '/api/public/accept/:token', access: 'public', mechanism: 'acceptance-link-token', openBecause: 'A client opens the quotation addressed to them (#53) without an account.', restrictions: ['parent-owner'] },
  { method: 'GET', path: '/api/public/accept/:token/pdf', access: 'public', mechanism: 'acceptance-link-token', openBecause: 'The same quotation as a PDF.', restrictions: ['parent-owner'] },
  { method: 'POST', path: '/api/public/accept/:token/accept', access: 'public', mechanism: 'acceptance-link-token', openBecause: 'The client accepts the quotation the token is bound to.', restrictions: ['parent-owner'] },
  { method: 'POST', path: '/api/public/accept/:token/changes', access: 'public', mechanism: 'acceptance-link-token', openBecause: 'The client asks for changes to the quotation the token is bound to.', restrictions: ['parent-owner'] },

  // ----------------------------------------------------- mail webhook
  { method: 'POST', path: '/api/mail/notifications', access: 'public', mechanism: 'graph-client-state', openBecause: 'Microsoft Graph posts here and has no session. A notification whose clientState does not match the stored subscription secret is ignored.' },

  // --------------------------------------------------- incoming webhooks
  { method: 'POST', path: '/api/hooks/enquiries', access: 'public', mechanism: 'hmac-signature', openBecause: 'An external form posts an enquiry (#49). Off entirely unless the secret is set and Settings enables it.' },

  // ------------------------------------------------------- client portal
  { method: 'POST', path: '/api/portal/request-link', access: 'public', mechanism: 'none', openBecause: 'A client asks for a sign-in link. It answers the same sentence whether or not the address belongs to a portal-enabled contact, so it confirms nothing.' },
  { method: 'POST', path: '/api/portal/login', access: 'public', mechanism: 'portal-link-token', openBecause: 'Exchanges the emailed single-use token for a portal session.' },
  { method: 'POST', path: '/api/portal/logout', access: 'public', mechanism: 'portal-session', openBecause: 'Portal routes sit outside the staff sign-in and carry their own session.', restrictions: ['self-only'] },
  { method: 'GET', path: '/api/portal/me', access: 'public', mechanism: 'portal-session', openBecause: 'Who the portal session belongs to.', restrictions: ['self-only'] },
  { method: 'GET', path: '/api/portal/projects', access: 'public', mechanism: 'portal-session', openBecause: 'The client\'s own projects.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/documents', access: 'public', mechanism: 'portal-session', openBecause: 'The client\'s own documents.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/invoices', access: 'public', mechanism: 'portal-session', openBecause: 'The client\'s own invoices.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/invoices/statement.pdf', access: 'public', mechanism: 'portal-session', openBecause: 'The client\'s own statement.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/certificates', access: 'public', mechanism: 'portal-session', openBecause: 'The client\'s own certificates.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/files/document/:id', access: 'public', mechanism: 'portal-session', openBecause: 'A document file, checked against the session\'s company before it is served.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/files/quotation/:no', access: 'public', mechanism: 'portal-session', openBecause: 'A quotation PDF, checked against the session\'s company before it is served.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/messages', access: 'public', mechanism: 'portal-session', openBecause: 'The client\'s own messages.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'POST', path: '/api/portal/messages', access: 'public', mechanism: 'portal-session', openBecause: 'The client writes to us.', restrictions: ['record-owner', 'portal-section'] },

  // ------------------------------------------------------------- MCP
  { method: 'POST', path: '/api/mcp', access: 'public', mechanism: 'api-token', openBecause: 'MCP clients authenticate with an API token instead of a session (#50). No token, no answer.', restrictions: ['api-token-scope'] },
  { method: 'GET', path: '/api/mcp', access: 'public', mechanism: 'none', openBecause: 'A fixed 405 telling a client to use POST. It reads nothing and reveals nothing.' },
  { method: 'DELETE', path: '/api/mcp', access: 'public', mechanism: 'none', openBecause: 'A fixed 405 with an empty body, for MCP clients that try to end a session this stateless server never opened.' },

  // ----------------------------------------------------------- metrics
  { method: 'GET', path: '/metrics', access: 'public', mechanism: 'metrics-token-or-admin-session', openBecause: 'Mounted outside /api so a scraper can reach it with a bearer token, but it refuses anyone who is neither the token holder nor a current administrator.' },

  // =====================================================================
  // Everything below is behind app.use('/api', requireAuth).
  // =====================================================================

  // ------------------------------------------------------------ dashboard
  { method: 'GET', path: '/api/dashboard/overview', access: signedIn },
  { method: 'GET', path: '/api/dashboard/worklist', access: signedIn },
  { method: 'GET', path: '/api/dashboard/travel', access: signedIn },
  { method: 'GET', path: '/api/dashboard/data-quality', access: signedIn },
  { method: 'GET', path: '/api/dashboard/payables', access: signedIn, note: 'What we owe travel vendors, aged (#76). Open to both roles, deliberately and for the same reason GET /api/collections is: the person arranging the travel is the person chasing the bill.' },

  // --------------------------------------------------------------- search
  { method: 'GET', path: '/api/search', access: signedIn, note: 'One request across every record type behind Cmd+K (#75). It ranks and returns what the caller may already list; it opens nothing a list page does not.' },

  // -------------------------------------------------------------- reports
  //
  // Each of these aggregates `quotations`, which is owner-scoped, so each
  // carries ownerClause and a sales user sees the shape of their own book
  // rather than the company's. The gate is open because the numbers are
  // counts and quotation values a salesperson already sees on their own
  // rows; none of them carries margin, which is what /api/profitability is
  // gated for.
  { method: 'GET', path: '/api/reports/win-rate', access: signedIn, restrictions: ['record-owner'], note: 'Win rate by financial quarter. Scoped: before #18 Phase 2C this summed every quotation for anyone signed in, which the note here used to justify by saying both roles see quotations anyway — no longer true once the list itself was scoped.' },
  { method: 'GET', path: '/api/reports/conversion', access: signedIn, restrictions: ['record-owner'], note: 'Win rate grouped by owner, sector or service. The grouping column is chosen from a fixed map in the route, never taken from the query string.' },
  { method: 'GET', path: '/api/reports/quoted-won', access: signedIn, restrictions: ['record-owner'], note: 'Quoted against won by month, in INR; quotations in other currencies are counted and reported separately rather than converted at today\'s rate into a month that has passed.' },
  { method: 'GET', path: '/api/reports/by-status', access: signedIn, restrictions: ['record-owner'], note: 'Open deals by the status on the record, which is not always where its pipeline stage puts it.' },
  { method: 'GET', path: '/api/reports/sales', access: signedIn, restrictions: ['record-owner'], note: 'The Reports section\'s questions for a period: enquiries received and their outcome, sector-wise POs, service-wise sales, new and existing customers, and monthly revenue. Every record listed comes from the scoped sources; ?owner= narrows an admin\'s view to one salesperson and is ignored for a sales user. One deliberate exception: whether a customer had ordered before is judged against every counting PO, so a sales user sees a long-standing client as existing, and a repeat order\'s count of previous orders — never those orders themselves.' },
  { method: 'GET', path: '/api/reports/categories', access: mustBeAdmin, why: 'Settings → Reports: lists every sector spelling in use across all quotations, enquiries and companies, which is the whole book rather than the caller\'s own records.' },

  // --------------------------------------------------------- saved views
  //
  // A view is its owner\'s or it is shared (owner IS NULL). The handler
  // decides which: a listing returns the caller\'s own and the shared ones,
  // and writing or removing a shared view needs an administrator.
  { method: 'GET', path: '/api/views', access: signedIn, restrictions: ['record-owner'] },
  { method: 'POST', path: '/api/views', access: signedIn, restrictions: ['record-owner'] },
  { method: 'PATCH', path: '/api/views/:id', access: signedIn, restrictions: ['record-owner'] },
  { method: 'DELETE', path: '/api/views/:id', access: signedIn, restrictions: ['record-owner'] },
  { method: 'POST', path: '/api/views/order', access: signedIn, restrictions: ['record-owner'] },

  // -------------------------------------------------- lookups / settings
  { method: 'GET', path: '/api/lookups', access: signedIn },
  { method: 'GET', path: '/api/lookups/next-id/:kind', access: signedIn },
  { method: 'GET', path: '/api/settings', access: signedIn },
  { method: 'PATCH', path: '/api/settings/:key', access: mustBeAdmin, why: 'A setting re-aims the whole application: which mailbox syncs, whether margin is visible, whether incoming webhooks are on.' },

  // --------------------------------------------------------------- export
  { method: 'GET', path: '/api/export/sales-report.pdf', access: signedIn },
  { method: 'GET', path: '/api/export/sales-report/:report.csv', access: signedIn },
  { method: 'GET', path: '/api/export/:resource.csv', access: signedIn },
  { method: 'GET', path: '/api/export/payables.csv', access: signedIn, note: 'The same rows as GET /api/dashboard/payables, so it carries the same answer.' },
  { method: 'GET', path: '/api/export/:resource.xlsx', access: signedIn },

  // --------------------------------------------------------------- import
  { method: 'GET', path: '/api/import/template.csv', access: mustBeAdmin, why: 'The whole import router is admin-only: a commit writes records in bulk under somebody else\'s name.' },
  { method: 'POST', path: '/api/import/batches', access: mustBeAdmin, why: 'Uploading a sheet to import.' },
  { method: 'GET', path: '/api/import/batches', access: mustBeAdmin, why: 'Import batches carry whole spreadsheets of other people\'s records.' },
  { method: 'GET', path: '/api/import/batches/:id', access: mustBeAdmin, why: 'The whole import router is administrator-only: a commit writes records in bulk, under somebody else\'s name, across every table the sheet touches.' },
  { method: 'POST', path: '/api/import/batches/:id/replan', access: mustBeAdmin, why: 'The whole import router is administrator-only: a commit writes records in bulk, under somebody else\'s name, across every table the sheet touches.' },
  { method: 'DELETE', path: '/api/import/batches/:id', access: mustBeAdmin, why: 'The whole import router is administrator-only: a commit writes records in bulk, under somebody else\'s name, across every table the sheet touches.' },
  { method: 'PATCH', path: '/api/import/items/:id', access: mustBeAdmin, why: 'The whole import router is administrator-only: a commit writes records in bulk, under somebody else\'s name, across every table the sheet touches.' },
  { method: 'POST', path: '/api/import/batches/:id/duplicates', access: mustBeAdmin, why: 'The whole import router is administrator-only: a commit writes records in bulk, under somebody else\'s name, across every table the sheet touches.' },
  { method: 'POST', path: '/api/import/batches/:id/commit', access: mustBeAdmin, why: 'A commit writes every row of the batch into the live tables.' },

  // ------------------------------------------------------------ documents
  { method: 'POST', path: '/api/documents', access: signedIn },
  { method: 'GET', path: '/api/documents/:id', access: signedIn },

  // ---------------------------------------------------------------- users
  { method: 'GET', path: '/api/users', access: mustBeAdmin, why: 'The account list, including roles and who is switched off.' },
  { method: 'POST', path: '/api/users', access: mustBeAdmin, why: 'Creating an account is handing out a key.' },
  { method: 'PATCH', path: '/api/users/:id', access: mustBeAdmin, why: 'Changing a role or switching an account off.' },
  { method: 'POST', path: '/api/users/:id/password', access: mustBeAdmin, why: 'Setting somebody\'s password.' },

  // ------------------------------------------------------------- activity
  { method: 'GET', path: '/api/activity', access: mustBeAdmin, why: 'The audit log: what everybody did and when. Read-only and admin-only (#18 Phase 1.5).' },

  // ------------------------------------------------------------ companies
  { method: 'GET', path: '/api/companies/duplicates', access: signedIn },
  { method: 'GET', path: '/api/companies/:id/full', access: signedIn },
  { method: 'POST', path: '/api/companies/:id/merge', access: mustBeAdmin, why: 'A merge folds every record of one client into another and deletes the loser. It cannot be undone from the UI.' },

  // --------------------------------------------------------------- emails
  { method: 'GET', path: '/api/emails', access: signedIn },
  { method: 'GET', path: '/api/emails/:id', access: signedIn },
  { method: 'POST', path: '/api/emails/test', access: mustBeAdmin, why: 'It sends real mail to an address the caller names — an effect outside the application.' },

  // ------------------------------------------------------------- pipeline
  { method: 'GET', path: '/api/pipeline', access: signedIn },
  { method: 'POST', path: '/api/pipeline/:key/move', access: signedIn },

  // ------------------------------------------------------------- timeline
  { method: 'GET', path: '/api/timeline', access: signedIn },
  { method: 'GET', path: '/api/tasks/summary', access: signedIn },

  // ---------------------------------------------------------- collections
  { method: 'GET', path: '/api/collections', access: signedIn },
  { method: 'GET', path: '/api/collections/log', access: signedIn },
  { method: 'POST', path: '/api/collections/log', access: signedIn },
  { method: 'GET', path: '/api/collections/stages/:id/payments', access: signedIn },
  { method: 'POST', path: '/api/collections/stages/:id/hold', access: mustBeAdmin, why: 'A hold takes a debt out of the chasing list and out of Due now. Deciding a debt is not chased is the admin\'s call.' },

  // ------------------------------------------------------------- renewals
  { method: 'GET', path: '/api/renewals', access: signedIn },
  { method: 'POST', path: '/api/renewals/discover', access: mustBeAdmin, why: 'Running the discovery sweep by hand is an operational act; it creates renewal records across every client.' },
  { method: 'POST', path: '/api/renewals/:id/open', access: signedIn },
  { method: 'POST', path: '/api/renewals/:id/cancel', access: signedIn },
  { method: 'POST', path: '/api/renewals/manual', access: signedIn },

  // ------------------------------------------------------------- cashflow
  { method: 'GET', path: '/api/cashflow', access: signedIn },

  // -------------------------------------------------------- notifications
  { method: 'GET', path: '/api/notifications', access: signedIn, restrictions: ['record-owner'] },
  { method: 'GET', path: '/api/notifications/summary', access: signedIn, restrictions: ['record-owner'] },
  { method: 'POST', path: '/api/notifications/read-all', access: signedIn, restrictions: ['record-owner'] },
  { method: 'POST', path: '/api/notifications/:id/read', access: signedIn, restrictions: ['record-owner'] },
  { method: 'POST', path: '/api/notifications/sweep', access: mustBeAdmin, why: 'The same work as the notifications.daily job. Running a job by hand is operational.' },

  // ----------------------------------------------------------- follow-ups
  { method: 'GET', path: '/api/follow-ups', access: signedIn, restrictions: ['record-owner'] },
  { method: 'GET', path: '/api/follow-ups/record', access: signedIn, restrictions: ['record-owner'] },
  { method: 'GET', path: '/api/follow-ups/summary', access: mustBeAdmin, why: 'How each salesperson answers their reminders is a management view of the whole team.' },

  // ------------------------------------------------------------- insights
  { method: 'GET', path: '/api/insights', access: signedIn, restrictions: ['record-owner'], note: 'Five questions on one screen (docs/insights-dashboard-plan.md). Every section is narrowed to the reader\'s records; ?owner= is honoured for an admin only.' },

  // ------------------------------------------------------- communications
  { method: 'GET', path: '/api/communications', access: signedIn },
  { method: 'POST', path: '/api/communications', access: signedIn },
  { method: 'GET', path: '/api/communications/contacts', access: signedIn },
  { method: 'GET', path: '/api/communications/no-contact', access: signedIn },

  // --------------------------------------------------------- deliverables
  { method: 'GET', path: '/api/deliverables', access: signedIn },
  { method: 'GET', path: '/api/deliverables/:id', access: signedIn },
  { method: 'POST', path: '/api/deliverables', access: signedIn },
  { method: 'PATCH', path: '/api/deliverables/:id', access: signedIn },
  { method: 'POST', path: '/api/deliverables/:id/supersede', access: signedIn },
  { method: 'POST', path: '/api/deliverables/:id/withdraw', access: signedIn },
  { method: 'DELETE', path: '/api/deliverables/:id', access: signedIn },

  // ------------------------------------------------------------ mailboxes
  { method: 'GET', path: '/api/mailboxes', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'GET', path: '/api/mailboxes/connect/microsoft', access: signedIn },
  { method: 'GET', path: '/api/mailboxes/oauth/microsoft', access: signedIn },
  { method: 'POST', path: '/api/mailboxes/test', access: mustBeAdmin, why: 'Probes the Microsoft app registration — a credential check, not a mailbox action.' },
  { method: 'POST', path: '/api/mailboxes/:id/test-messages', access: mustBeAdmin, why: 'Writes sample messages into a real connected mailbox.' },
  { method: 'PATCH', path: '/api/mailboxes/:id', access: signedIn, restrictions: ['mailbox-owner'] },
  { method: 'POST', path: '/api/mailboxes/:id/sync', access: signedIn, restrictions: ['mailbox-owner'] },
  { method: 'POST', path: '/api/mailboxes/:id/refresh-bodies', access: signedIn, restrictions: ['mailbox-owner'] },
  { method: 'POST', path: '/api/mailboxes/:id/disconnect', access: signedIn, restrictions: ['mailbox-owner'] },
  { method: 'GET', path: '/api/mailboxes/auto-enquiries', access: mustBeAdmin, why: 'Counts what every mailbox\'s mail was judged to be, the whole team\'s included.' },
  { method: 'POST', path: '/api/mailboxes/:id/auto-enquiries/rerun', access: mustBeAdmin, why: 'Has a mailbox\'s mail judged again for enquiries, which spends the AI budget everybody shares.' },
  { method: 'GET', path: '/api/mailboxes/blocklist', access: signedIn },
  { method: 'POST', path: '/api/mailboxes/blocklist', access: mustBeAdmin, why: 'The blocklist decides whose mail the application will never sync, for everybody.' },
  { method: 'DELETE', path: '/api/mailboxes/blocklist/:id', access: mustBeAdmin, why: 'The blocklist decides whose mail the application will never sync, for everybody; removing an entry starts that mail flowing again.' },

  // ---------------------------------------------------------- mail threads
  { method: 'GET', path: '/api/mail/origin', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'GET', path: '/api/mail/threads', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'GET', path: '/api/mail/threads/:id', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'PATCH', path: '/api/mail/threads/:id', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'POST', path: '/api/mail/threads/:id/reply', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },

  // ---------------------------------------------------------------- inbox
  { method: 'GET', path: '/api/inbox', access: signedIn, restrictions: ['mailbox-delegate'] },
  { method: 'GET', path: '/api/inbox/summary', access: signedIn, restrictions: ['mailbox-delegate'] },
  { method: 'GET', path: '/api/inbox/:id', access: signedIn, restrictions: ['mailbox-delegate'] },
  { method: 'PATCH', path: '/api/inbox/:id', access: signedIn, restrictions: ['mailbox-delegate'] },
  { method: 'POST', path: '/api/inbox/:id/reply', access: signedIn, restrictions: ['mailbox-delegate'] },
  { method: 'POST', path: '/api/inbox/:id/convert', access: signedIn, restrictions: ['mailbox-delegate'] },
  { method: 'GET', path: '/api/inbox/inboxes', access: signedIn },
  { method: 'POST', path: '/api/inbox/inboxes', access: mustBeAdmin, why: 'An inbox and its membership decide whose queue a client\'s mail lands in.' },
  { method: 'PATCH', path: '/api/inbox/inboxes/:id', access: mustBeAdmin, why: 'An inbox and its membership decide whose queue a client\'s mail lands in.' },
  { method: 'DELETE', path: '/api/inbox/inboxes/:id', access: mustBeAdmin, why: 'Removing a shared inbox decides where a client\'s mail stops landing, for everybody.' },
  { method: 'GET', path: '/api/inbox/canned', access: signedIn },
  { method: 'POST', path: '/api/inbox/canned', access: signedIn },
  { method: 'PATCH', path: '/api/inbox/canned/:id', access: signedIn, restrictions: ['record-owner'], note: 'ownCanned: the author or an admin.' },
  { method: 'DELETE', path: '/api/inbox/canned/:id', access: signedIn, restrictions: ['record-owner'], note: 'ownCanned: the author or an admin.' },

  // -------------------------------------------------------- profitability
  { method: 'GET', path: '/api/profitability', access: mustBeAdmin, why: 'Delivery cost against PO value is what the business earns (#39).', restrictions: ['settings-override'], note: 'maySeeMargin opens this to everybody when the setting margin_visible_to_sales is true.' },
  { method: 'GET', path: '/api/profitability/projects/:id', access: mustBeAdmin, why: 'One project\'s delivery cost against its PO value is what the business earns on it (#39).', restrictions: ['settings-override'], note: 'maySeeMargin opens this to everybody when the setting margin_visible_to_sales is true.' },

  // --------------------------------------------------------------- visits
  { method: 'GET', path: '/api/visits', access: signedIn },
  { method: 'GET', path: '/api/visits/:id', access: signedIn },
  { method: 'POST', path: '/api/visits', access: signedIn },
  { method: 'PATCH', path: '/api/visits/:id', access: signedIn },
  { method: 'DELETE', path: '/api/visits/:id', access: signedIn },
  { method: 'POST', path: '/api/visits/check', access: signedIn },
  { method: 'POST', path: '/api/visits/:id/trip', access: signedIn },
  { method: 'GET', path: '/api/visits/today', access: signedIn },
  { method: 'GET', path: '/api/visits/capacity', access: signedIn },
  { method: 'GET', path: '/api/visits/staff', access: signedIn },
  { method: 'POST', path: '/api/visits/staff', access: mustBeAdmin, why: 'The engineer roster is shared scheduling data; adding to it changes everybody\'s capacity figures.' },
  { method: 'PATCH', path: '/api/visits/staff/:id', access: mustBeAdmin, why: 'The engineer roster is shared scheduling data; editing it changes everybody\'s capacity figures.' },
  { method: 'POST', path: '/api/visits/staff/:id/leave', access: mustBeAdmin, why: 'Booking somebody else\'s leave.' },
  { method: 'DELETE', path: '/api/visits/leave/:id', access: mustBeAdmin, why: 'Removing somebody else\'s leave.' },

  // ------------------------------------------------------------- webhooks
  { method: 'GET', path: '/api/webhooks', access: mustBeAdmin, why: 'The whole outgoing-webhook router is admin-only: an endpoint here sends this company\'s data to an address somebody types (#49).' },
  { method: 'POST', path: '/api/webhooks', access: mustBeAdmin, why: 'The whole outgoing-webhook router is administrator-only: an endpoint here sends this company\'s data to an address somebody types (#49).' },
  { method: 'PATCH', path: '/api/webhooks/:id', access: mustBeAdmin, why: 'The whole outgoing-webhook router is administrator-only: an endpoint here sends this company\'s data to an address somebody types (#49).' },
  { method: 'DELETE', path: '/api/webhooks/:id', access: mustBeAdmin, why: 'The whole outgoing-webhook router is administrator-only: an endpoint here sends this company\'s data to an address somebody types (#49).' },
  { method: 'POST', path: '/api/webhooks/:id/rotate-secret', access: mustBeAdmin, why: 'The whole outgoing-webhook router is administrator-only: an endpoint here sends this company\'s data to an address somebody types (#49).' },
  { method: 'POST', path: '/api/webhooks/:id/test', access: mustBeAdmin, why: 'The whole outgoing-webhook router is administrator-only: an endpoint here sends this company\'s data to an address somebody types (#49).' },
  { method: 'GET', path: '/api/webhooks/deliveries', access: mustBeAdmin, why: 'Delivery bodies contain the records that were sent.' },
  { method: 'POST', path: '/api/webhooks/deliveries/:id/replay', access: mustBeAdmin, why: 'Re-sends data to the external endpoint.' },
  { method: 'POST', path: '/api/webhooks/run', access: mustBeAdmin, why: 'Running the delivery job by hand.' },

  // --------------------------------------------------------- portal admin
  { method: 'GET', path: '/api/portal-admin/companies/:id', access: mustBeAdmin, why: 'Who outside the company may see this client\'s records (#47).' },
  { method: 'PATCH', path: '/api/portal-admin/companies/:id', access: mustBeAdmin, why: 'Switching the portal on and choosing its sections.' },
  { method: 'PATCH', path: '/api/portal-admin/contacts/:id', access: mustBeAdmin, why: 'Granting or withdrawing a client contact\'s portal access.' },
  { method: 'POST', path: '/api/portal-admin/contacts/:id/invite', access: mustBeAdmin, why: 'Emailing a sign-in link to somebody outside the company.' },

  // ----------------------------------------------------------- accounting
  { method: 'GET', path: '/api/accounting/status', access: mustBeAdmin, why: 'The whole accounting router is admin-only: it is the books (#42).' },
  { method: 'POST', path: '/api/accounting/import', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'POST', path: '/api/accounting/sync', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'POST', path: '/api/accounting/reconcile', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'GET', path: '/api/accounting/items', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'POST', path: '/api/accounting/items/:id/accept', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'POST', path: '/api/accounting/items/:id/resolve', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'GET', path: '/api/accounting/entries', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'GET', path: '/api/accounting/mappings', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'POST', path: '/api/accounting/mappings', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'DELETE', path: '/api/accounting/mappings/:id', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'GET', path: '/api/accounting/stages/:id/draft', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'POST', path: '/api/accounting/stages/:id/draft', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'GET', path: '/api/accounting/reports/summary', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'GET', path: '/api/accounting/reports/tds.csv', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'GET', path: '/api/accounting/reports/gstr1-b2b.csv', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },
  { method: 'GET', path: '/api/accounting/log', access: mustBeAdmin, why: 'The whole accounting router is administrator-only: it is the books (#42).' },

  // ----------------------------------------------------------- API tokens
  { method: 'GET', path: '/api/api-tokens', access: mustBeAdmin, why: 'A token is a key to the tracker, and one issued with the admin role reads the whole company through MCP (#50).' },
  { method: 'POST', path: '/api/api-tokens', access: mustBeAdmin, why: 'Anybody who may issue a token may issue an admin one and read the whole company through MCP, whatever their own role is (#50).' },
  { method: 'POST', path: '/api/api-tokens/:id/revoke', access: mustBeAdmin, why: 'Revoking is the same power pointed the other way.' },

  // -------------------------------------------------------- client errors
  { method: 'POST', path: '/api/client-errors', access: signedIn, note: 'Mounted after requireAuth: browser errors are reported by signed-in people only.' },

  // ----------------------------------------------------------------- jobs
  { method: 'GET', path: '/api/jobs', access: signedIn },
  { method: 'POST', path: '/api/jobs/:name/run', access: mustBeAdmin, why: 'A job by hand emails every client it decides is due. Not a preview, and not the caller\'s own records.' },

  // ------------------------------------------------------------ workflow
  { method: 'GET', path: '/api/projects/:projectId/full', access: signedIn },
  { method: 'POST', path: '/api/projects/:projectId/onboarding/apply-template', access: signedIn },
  { method: 'GET', path: '/api/purchase-orders/:poNumber/full', access: signedIn },
  { method: 'POST', path: '/api/purchase-orders/:poNumber/stages', access: signedIn },
  { method: 'GET', path: '/api/travel-logs/:travelId/full', access: signedIn },
  { method: 'POST', path: '/api/payment-stages/:id/invoice', access: signedIn },
  { method: 'POST', path: '/api/payment-stages/:id/payment', access: signedIn },

  // --------------------------------------------------------- quotations
  { method: 'POST', path: '/api/quotations/:key/register', access: signedIn },
  { method: 'POST', path: '/api/quotations/:key/approval/request', access: signedIn },
  { method: 'POST', path: '/api/quotations/:key/approval/decide', access: mustBeAdmin, why: 'An approval you can grant yourself is not an approval. A discount past the threshold is decided by somebody else.' },
  { method: 'POST', path: '/api/quotations/:key/acceptance-link', access: signedIn },
  { method: 'GET', path: '/api/quotations/:key/acceptances', access: signedIn },
  { method: 'POST', path: '/api/quotations/:key/acceptances/:id/revoke', access: signedIn },
  { method: 'GET', path: '/api/quotations/:key/full', access: signedIn },
  { method: 'GET', path: '/api/quotations/:key/pdf', access: signedIn },
  { method: 'POST', path: '/api/quotations/:key/revise', access: signedIn },
  { method: 'POST', path: '/api/quotations/:key/email-read-checked', access: signedIn },
  { method: 'POST', path: '/api/quotations/:key/send', access: signedIn },
  { method: 'POST', path: '/api/quotations/:key/accept', access: signedIn },
  { method: 'POST', path: '/api/quotations/:id/convert', access: signedIn },

  // --------------------------------------------- travel finance (#85)
  //
  // #85 is in the history below this commit, so these describe what the code
  // does rather than what it should do. The four claim columns and the two
  // vendor-invoice ones are closed on the generic form by `protectedFields`
  // and move only through the routes here.
  {
    method: 'POST', path: '/api/vendor-invoices/:id/pay', access: signedIn,
    note: 'Recording a vendor payment is ordinary work for admin and sales, so the gate stays open — but amount_paid and payment_date must move only through here, never through PATCH /api/vendor-invoices/:id.',
  },
  {
    method: 'POST', path: '/api/expense-claims/:id/decide', access: mustBeAdmin,
    why: 'Approving, rejecting or holding an expense claim is the administrator\'s decision. An approval anybody can grant themselves is not an approval (#85).',
  },
  {
    method: 'POST', path: '/api/expense-claims/:id/reimburse', access: mustBeAdmin,
    why: 'Reimbursement moves money out of the business (#85).',
  },
  {
    method: 'POST', path: '/api/expense-claims/:id/correct', access: mustBeAdmin,
    why: 'The only route that can move a recorded reimbursement total back down, so it is the one place a figure already booked against a claim can be changed (#85). It refuses to run without a reason, caps the figure at what was claimed, and records the before and after in the same transaction as the change. Reimbursing adds; correcting rewrites — and because amount_reimbursed is a single column rather than a ledger, the activity row is the only surviving trace of the larger figure. An administrator is the answer for the same reason /decide is: this is the correction path for money, not a tidy-up.',
  },

  // ------------------------------------------- record ownership (#18)
  //
  // Who a record belongs to is the administrator's to set. A salesperson may
  // read their own work — that is what row scoping is for — but reassigning
  // it is a decision about people, not about the record, and the handover
  // history is the audit of those decisions.
  {
    method: 'PATCH', path: '/api/:resource/:id/owner', access: mustBeAdmin,
    why: 'Assigning, reassigning or unassigning a record moves somebody else\'s pipeline. Sales users already see only their own rows, so letting one of them set owner_user_id would let them take a record off a colleague, or hand their own away to hide it (#18 Phase 3).',
  },
  {
    method: 'GET', path: '/api/:resource/:id/ownership-history', access: mustBeAdmin,
    why: 'The handover trail for one record: who owned it, who changed that, and when. It names accounts other than the caller\'s, which is the administrator\'s view of the team rather than a salesperson\'s view of their own work (#18 Phase 3).',
  },

  // -------------------------------------------------- sales KPIs (#18 §5)
  //
  // Everything here is mounted behind the router's own requireAuth. The
  // split is between a person's own figures, which are theirs to read, and
  // the team's, which are the administrator's — and between reading a target
  // and setting one.
  { method: 'GET', path: '/api/kpis/me', access: signedIn, restrictions: ['self-only'] },
  {
    method: 'GET', path: '/api/kpis/team', access: mustBeAdmin,
    why: 'Every salesperson\'s figures side by side. That is the manager\'s view of the team, and one salesperson comparing themselves against a named colleague is not what these numbers are for (#18 §5).',
  },
  {
    method: 'GET', path: '/api/kpis/users/:userId', access: signedIn, restrictions: ['self-only'],
    note: 'The handler refuses another salesperson with 403 rather than an empty list: an empty list reads as "no work done", which is a different and worse answer than "not yours to see". An admin may read anybody\'s.',
  },
  {
    method: 'GET', path: '/api/kpis/targets', access: signedIn, restrictions: ['self-only'],
    note: 'A salesperson sees the targets set for them; asking after somebody else\'s is refused in the handler the same way as /users/:userId.',
  },
  {
    method: 'PUT', path: '/api/kpis/users/:userId/targets/:metric', access: mustBeAdmin,
    why: 'A target is what somebody is measured against, so setting your own would make the measurement meaningless (#18 §5).',
  },

  // -------------------------------------------------------- the web shell
  {
    method: 'GET', path: '/{*splat}', access: 'public', mechanism: 'web-app-shell',
    openBecause: 'The built single-page app is static files with no data in them; every figure it shows it fetches from /api, which is gated.',
    onlyWhenWebBuilt: true,
  },
];

/**
 * The generic CRUD resources.
 *
 * Every resource in `lib/resources.js` must appear here, and nothing else
 * may. Adding a resource to the registry therefore costs one deliberate
 * decision in this table, which is the point.
 *
 *   read / write / delete are the access level for
 *   GET, (POST and PATCH), and DELETE respectively.
 *
 *   `protectedFields` are columns the resource's schema accepts but which
 *   must not be writable through ordinary CRUD — they belong to a workflow
 *   route with its own gate.
 *
 *   `restrictions` carries the same vocabulary as the explicit route entries,
 *   for a resource whose rows are narrower than its gate: `ownerScoped` and
 *   `ownerScopedBy` on the registry scope the rows a caller may reach at all,
 *   so the gate being "any" does not mean "any row". (#18 Phase 2C replaced
 *   the earlier `visibleTo` hook, which matched the free-text sales_person,
 *   with a predicate on owner_user_id.)
 */
export const resourceAccess = {
  // --- a salesperson's own working records -------------------------------
  enquiries: {
    read: 'any', write: 'any', delete: 'any',
    restrictions: ['record-owner'],
    why: 'A salesperson\'s own working record. An enquiry is the first record of a lead, and entering and working one is ordinary sales work, so the gate is open to both roles — but it is not open on every row: ownerScoped scopes every read, write and delete to the records the caller owns (#18 Phase 2C). An administrator sees all of them.' },
  quotations: {
    read: 'any', write: 'any', delete: 'any',
    restrictions: ['record-owner'],
    why: 'A salesperson\'s own working record. A quotation is the offer made on one, and entering and working one is ordinary sales work, so the gate is open to both roles — but it is not open on every row: ownerScoped scopes every read, write and delete to the records the caller owns (#18 Phase 2C). An administrator sees all of them.' },
  projects: {
    read: 'any', write: 'any', delete: 'any',
    restrictions: ['record-owner'],
    why: 'A salesperson\'s own working record. A project is the work won from one, and entering and working one is ordinary sales work, so the gate is open to both roles — but it is not open on every row: ownerScoped scopes every read, write and delete to the records the caller owns (#18 Phase 2C). An administrator sees all of them.' },
  onboarding: { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  'travel-logs': { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  engagements: { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  tasks: { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  notes: { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  attachments: { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  'quotation-lines': { read: 'any', write: 'any', delete: 'any', why: 'The lines of a quotation, edited with it.' },

  // --- travel finance (#85) ---------------------------------------------
  'vendor-invoices': {
    read: 'any', write: 'any', delete: 'any',
    why: 'Sales enter vendor invoices as ordinary work.',
    protectedFields: ['amount_paid', 'payment_date'],
    protectedBecause: 'A payment is recorded through POST /api/vendor-invoices/:id/pay, which is the route that audits it. Letting an ordinary PATCH set amount_paid means a vendor invoice can be marked paid with no payment behind it (#85).',
  },
  'expense-claims': {
    read: 'any', write: 'any', delete: 'any',
    why: 'Admin and sales both submit ordinary expense claims.',
    protectedFields: ['approval_status', 'approved_by', 'amount_reimbursed', 'reimbursement_date'],
    protectedBecause: 'Approval and reimbursement go through POST /api/expense-claims/:id/decide, /reimburse and /correct, which are administrator-only. If PATCH can write approval_status the admin-only gate on those routes is decoration: anybody could approve and reimburse their own claim in one request (#85). The check lives in validate() in lib/crud.js — the one place every generic write passes, so the MCP import_records tool inherits it without going near a route — and it reads the request body rather than the parsed record, because zod fills approval_status and amount_reimbursed from their defaults whether or not the caller sent them. An explicit null counts as an attempt.',
  },

  // --- shared master data: anybody may add and correct, admin deletes ----
  companies: { read: 'any', write: 'any', delete: 'admin', why: 'Shared master data. Every record that ever named this client points at it, and the link trigger creates one on its own.' },
  contacts: { read: 'any', write: 'any', delete: 'admin', why: 'Shared master data, created and referenced the same way.' },

  // --- financial records: anybody may enter, admin deletes ---------------
  'purchase-orders': { read: 'any', write: 'any', delete: 'admin', why: 'The PO value is what Due now, To bill and profitability are computed against, and deleting one takes its lines and stages with it.' },
  'po-services': { read: 'any', write: 'any', delete: 'admin', why: 'The lines a PO\'s value is made of.' },
  'payment-stages': { read: 'any', write: 'any', delete: 'admin', why: 'The invoicing schedule: what has been raised, what is due, what has been paid.' },
  payments: { read: 'any', write: 'admin', delete: 'admin', why: 'The receipts ledger. A payment row is what says a client has paid.' },
  'project-costs': { read: 'any', write: 'admin', delete: 'admin', why: 'Delivery cost is one half of what the business earns on a project (#39).' },

  'project-milestones': {
    read: 'any', write: 'any', delete: 'any',
    restrictions: ['record-owner'],
    why: 'What a project must reach before an On Milestone stage can be invoiced (#26). Entering and reaching milestones is ordinary delivery work, so the gate is open — but it is not open on every project: ownerScopedBy: \'project\' scopes every read, update and delete to projects the caller owns, through the project\'s owner_user_id rather than the project_manager name column (the review of #115, #119; #18 Phase 2C). Without that scoping an open PATCH here would let any signed-in user stamp another project\'s milestone as reached and push it into the invoice run, the cash-flow forecast and the ageing.',
  },

  // --- the Settings lists: one edit re-labels every record that used it --
  'pipeline-stages': { read: 'any', write: 'admin', delete: 'admin', why: 'A stage\'s status mapping and probability rewrite quotation statuses and the whole forecast.' },
  services: { read: 'any', write: 'admin', delete: 'admin', why: 'A Settings catalogue: one edit re-labels every record that used the old value.' },
  'sector-aliases': { read: 'any', write: 'admin', delete: 'admin', why: 'Which spellings the Reports section counts under each headline sector; one edit moves POs between sectors in every report.' },
  'travel-vendors': { read: 'any', write: 'admin', delete: 'admin', why: 'A Settings catalogue: one edit re-labels every record that used the old value.' },
  'expense-categories': { read: 'any', write: 'admin', delete: 'admin', why: 'A Settings catalogue: one edit re-labels every record that used the old value.' },
  'exchange-rates': { read: 'any', write: 'admin', delete: 'admin', why: 'One rate re-values every historical deal in every report.' },
  holidays: { read: 'any', write: 'admin', delete: 'admin', why: 'The working calendar. A holiday decides which days count towards a reply clock, a follow-up deadline and every "working days" figure, so one edit moves what the whole company is judged late by. Correcting the dates that move each year is an administrator\'s job (adminOnlyWrites).' },
  'lead-sources': { read: 'any', write: 'admin', delete: 'admin', why: 'A Settings catalogue: one edit re-labels every record that used the old value.' },
  'lost-reasons': { read: 'any', write: 'admin', delete: 'admin', why: 'A Settings catalogue: one edit re-labels every record that used the old value.' },
  'payment-terms-templates': { read: 'any', write: 'admin', delete: 'admin', why: 'A template writes the payment schedule of every PO made from it.' },
  'payment-terms-template-lines': { read: 'any', write: 'admin', delete: 'admin', why: 'The lines a payment-terms template is made of, so editing one rewrites the schedule of every PO made from it.' },
  'onboarding-templates': { read: 'any', write: 'admin', delete: 'admin', why: 'A template writes the onboarding steps of every project made from it.' },
  'onboarding-template-lines': { read: 'any', write: 'admin', delete: 'admin', why: 'The steps an onboarding template is made of, so editing one rewrites the plan of every project made from it.' },
};

/** The five routes `crudRouter()` mounts for one resource. */
export function crudRoutesFor(name, access) {
  const base = `/api/${name}`;
  return [
    { method: 'GET', path: base, access: access.read, resource: name, operation: 'list' },
    { method: 'GET', path: `${base}/:id`, access: access.read, resource: name, operation: 'read' },
    { method: 'POST', path: base, access: access.write, resource: name, operation: 'create' },
    { method: 'PATCH', path: `${base}/:id`, access: access.write, resource: name, operation: 'update' },
    { method: 'DELETE', path: `${base}/:id`, access: access.delete, resource: name, operation: 'delete' },
  ].map((r) => ({ ...r, why: access.why, ...(access.restrictions ? { restrictions: access.restrictions } : {}) }));
}

export const crudRoutes = () =>
  Object.entries(resourceAccess).flatMap(([name, access]) => crudRoutesFor(name, access));

/** Every declared route: the explicit ones and the generated CRUD ones. */
export const policyRoutes = () => [...routes, ...crudRoutes()];
