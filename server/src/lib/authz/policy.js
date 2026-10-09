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
  'questionnaire-link-token': {
    authenticates: true,
    proof: 'A 40-60 character random token from the emailed or copied link, SHA-256 hashed and matched against questionnaire_links.token_hash, with expiry, revoke and the status of the response checked on every use.',
    description: 'A client filling in a service questionnaire (#208). The token is the credential and it is bound to one response: its questions, its own answers and its own files.',
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
  'hr-travel-only': 'For the HR role, limited to the rows on trips and travel vendor invoices.',
  'hr-travel-invoices-only': 'For the HR role, the sales side is narrowed to one thing: the travel invoice a trip is actually billed on \u2014 its number, date, amount, what has been received against it, when, its status and its PDF. No payment-stage list, no ordinary PO stage, no travel invoice nobody has linked a trip to, and no receipt rows, TDS, reminders, collections notes or margins.',
  'travel-desk-only': 'The handler allows the administrator and the HR role only: paying a travel agency is the travel desk\'s work, and the three access levels cannot say "admin and HR but not sales" on their own.',
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
  { method: 'GET', path: '/api/public/questionnaire/:token', access: 'public', mechanism: 'questionnaire-link-token', openBecause: 'A client opens the questionnaire sent to them (#208) without an account; only the questions, answers and file names of that response go out.', restrictions: ['parent-owner'] },
  { method: 'PUT', path: '/api/public/questionnaire/:token/answers', access: 'public', mechanism: 'questionnaire-link-token', openBecause: 'The answers of the client, saved as they go; checked against the questions, refused once submitted.', restrictions: ['parent-owner'] },
  { method: 'POST', path: '/api/public/questionnaire/:token/files', access: 'public', mechanism: 'questionnaire-link-token', openBecause: 'A file for a file question: PDF, image, Word or Excel, within the document size cap, held on that response only.', restrictions: ['parent-owner'] },
  { method: 'POST', path: '/api/public/questionnaire/:token/submit', access: 'public', mechanism: 'questionnaire-link-token', openBecause: 'The client submits; every required answer checked, then read-only and the owner of the enquiry told.', restrictions: ['parent-owner'] },
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
  { method: 'GET', path: '/api/portal/files/invoice/:id', access: 'public', mechanism: 'portal-session', openBecause: 'An invoice\'s PDF, from the Invoices section; the invoice is checked against the session\'s company before it is served (#198).', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/files/po/:no', access: 'public', mechanism: 'portal-session', openBecause: 'A live purchase order\'s file, from Projects & orders; checked against the session\'s company before it is served (#198).', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/messages', access: 'public', mechanism: 'portal-session', openBecause: 'The client\'s own messages.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'POST', path: '/api/portal/messages', access: 'public', mechanism: 'portal-session', openBecause: 'The client writes to us.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'GET', path: '/api/portal/actions', access: 'public', mechanism: 'portal-session', openBecause: 'The client\'s own confirmations, queries and payment advice, and where each stands (#198).', restrictions: ['record-owner', 'portal-section'] },
  { method: 'POST', path: '/api/portal/actions', access: 'public', mechanism: 'portal-session', openBecause: 'The client confirms an invoice, raises a query, or tells us they paid (#198). A claim only: it writes no payment; every invoice and PO named is checked against the session\'s company first.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'POST', path: '/api/portal/documents', access: 'public', mechanism: 'portal-session', openBecause: 'The client uploads a file onto one of their own projects or POs (#198), checked against the session\'s company; PDF, image, Word or Excel only, within the document size limit.', restrictions: ['record-owner', 'portal-section'] },
  { method: 'DELETE', path: '/api/portal/documents/:id', access: 'public', mechanism: 'portal-session', openBecause: 'The client takes back their own upload, until our team has seen it (#198).', restrictions: ['record-owner', 'portal-section'] },

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
  // ---------------------------------------------------- scheduled reports
  { method: 'GET', path: '/api/mis-reports/:kind/preview', access: mustBeAdmin, why: 'The Daily Sales Briefing and Weekly MIS are management reports over every record and every mailbox\'s readers; nothing is scoped to the caller.' },
  { method: 'GET', path: '/api/mis-reports/:kind/preview.pdf', access: mustBeAdmin, why: 'The same report as a PDF, built over the whole book.' },
  { method: 'GET', path: '/api/mis-reports/runs', access: mustBeAdmin, why: 'Every report sent to management, with its recipients.' },
  { method: 'GET', path: '/api/mis-reports/runs/:id/pdf', access: mustBeAdmin, why: 'The PDF that went to management, over the whole book.' },
  { method: 'POST', path: '/api/mis-reports/:kind/send', access: mustBeAdmin, why: 'Emails management a report now, from the chosen sender; not a preview.' },
  { method: 'GET', path: '/api/mis-reports/sender', access: mustBeAdmin, why: 'Which mailbox and address the management reports go from, and why that mailbox cannot send; part of the reports\' settings.' },
  { method: 'GET', path: '/api/mis-reports/personal/people', access: mustBeAdmin, why: 'Who a personal daily MIS is for and the state of each one\'s mailbox; part of the reports\' settings.' },
  { method: 'GET', path: '/api/mis-reports/personal/:userId/preview', access: mustBeAdmin, why: 'One person\'s day as the personal MIS sees it, and the AI\'s report on it; a manager\'s view of someone else\'s work. Their mail text stays hidden.' },
  { method: 'GET', path: '/api/mis-reports/personal/:userId/preview.pdf', access: mustBeAdmin, why: 'One person\'s daily MIS as it would be sent to management, written now by the AI; a manager\'s view of someone else\'s work.' },
  { method: 'POST', path: '/api/mis-reports/personal/:userId/send', access: mustBeAdmin, why: 'Emails management one person\'s daily MIS now, from their mailbox; only an admin decides when a report about someone goes.' },
  { method: 'GET', path: '/api/mis-reports/mine', access: signedIn, restrictions: ['self-only'] },
  { method: 'GET', path: '/api/mis-reports/mine/:id/pdf', access: signedIn, restrictions: ['self-only'] },
  { method: 'POST', path: '/api/mis-reports/mine/notice', access: signedIn, restrictions: ['self-only'] },
  { method: 'POST', path: '/api/mis-reports/sender/test', access: mustBeAdmin, why: 'Sends real mail from the reports\' sender (to the caller only); trying the company\'s sending path is an admin\'s act.' },
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
  { method: 'GET', path: '/api/import/travel/template.xlsx', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'POST', path: '/api/import/travel', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'GET', path: '/api/import/travel', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'GET', path: '/api/import/travel/:id', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'PATCH', path: '/api/import/travel/:id', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'DELETE', path: '/api/import/travel/:id', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'PATCH', path: '/api/import/travel/:id/items/:itemId', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'POST', path: '/api/import/travel/:id/items/:itemId/split', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'POST', path: '/api/import/travel/:id/duplicates', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'POST', path: '/api/import/travel/:id/commit', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'POST', path: '/api/import/travel/:id/documents', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },
  { method: 'POST', path: '/api/import/travel/documents', access: mustBeAdmin, why: 'The travel importer (#196 §5) is for whoever keeps the travel desk: an administrator, or HR through HR_ROUTES. A commit writes trips, agency invoices and credit notes in bulk.' },

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
  { method: 'GET', path: '/api/emails', access: signedIn, restrictions: ['record-owner'], note: 'A sales user sees only the client emails on records they own; an admin sees every email.' },
  { method: 'GET', path: '/api/emails/:id', access: signedIn, restrictions: ['record-owner'], note: 'An email that is not a client email on one of the caller\'s records is a 404 for a sales user.' },
  { method: 'POST', path: '/api/emails/test', access: mustBeAdmin, why: 'It sends real mail to an address the caller names — an effect outside the application.' },
  { method: 'GET', path: '/api/client-emails', access: signedIn, restrictions: ['record-owner'], note: 'An admin sees every client email and whose record it is on; a sales user only the client emails on records they own. HR is refused.' },
  { method: 'PUT', path: '/api/client-emails', access: mustBeAdmin, why: 'Holding or releasing client email decides whether clients hear from the company at all.' },

  // ------------------------------------------------------------- pipeline
  { method: 'GET', path: '/api/pipeline', access: signedIn },
  { method: 'POST', path: '/api/pipeline/:key/move', access: signedIn },

  // ------------------------------------------------------------- timeline
  { method: 'GET', path: '/api/timeline', access: signedIn, restrictions: ['record-owner', 'mailbox-owner'], note: 'The record itself must be reachable (404 otherwise), and the email threads listed on it come only from mailboxes the caller may read: their own, shared ones, or a thread on a record they own.' },
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
  { method: 'PATCH', path: '/api/mailboxes/:id', access: signedIn, restrictions: ['mailbox-owner', 'protected-fields'], note: 'is_shared is an admin\'s to change; a sales user may change only how their own mailbox syncs.' },
  { method: 'PATCH', path: '/api/mailboxes/:id/owner', access: mustBeAdmin, why: 'Decides whose records a personal mailbox\'s mail makes from now on, and who may read it; recorded in the activity log.' },
  { method: 'POST', path: '/api/mailboxes/:id/sync', access: signedIn, restrictions: ['mailbox-owner'] },
  { method: 'POST', path: '/api/mailboxes/:id/refresh-bodies', access: signedIn, restrictions: ['mailbox-owner'] },
  { method: 'POST', path: '/api/mailboxes/:id/disconnect', access: signedIn, restrictions: ['mailbox-owner'] },
  { method: 'GET', path: '/api/mailboxes/auto-entry', access: mustBeAdmin, why: 'What the email readers entered, sent to review and spent each day, across every mailbox.' },
  { method: 'GET', path: '/api/mailboxes/auto-enquiries', access: mustBeAdmin, why: 'Counts what every mailbox\'s mail was judged to be, the whole team\'s included.' },
  { method: 'POST', path: '/api/mailboxes/:id/auto-enquiries/rerun', access: mustBeAdmin, why: 'Has a mailbox\'s mail judged again for enquiries, or read again for POs or invoices, which spends the AI budget everybody shares.' },
  { method: 'GET', path: '/api/mailboxes/blocklist', access: signedIn },
  { method: 'POST', path: '/api/mailboxes/blocklist', access: mustBeAdmin, why: 'The blocklist decides whose mail the application will never sync, for everybody.' },
  { method: 'DELETE', path: '/api/mailboxes/blocklist/:id', access: mustBeAdmin, why: 'The blocklist decides whose mail the application will never sync, for everybody; removing an entry starts that mail flowing again.' },

  // ---------------------------------------------------------- mail threads
  { method: 'GET', path: '/api/mail/origin', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'GET', path: '/api/mail/threads', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'GET', path: '/api/mail/threads/:id', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'PATCH', path: '/api/mail/threads/:id', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'POST', path: '/api/mail/threads/:id/reply', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  // Reading mail as Outlook shows it (docs/inbox-outlook-plan.md §3.3). Every
  // route answers 404 for a mailbox or message the caller may not read.
  { method: 'GET', path: '/api/mail/mailboxes', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'], note: 'The caller\'s own mailboxes and the shared ones they are named on, with their folders; an admin sees every mailbox\'s folder list.' },
  { method: 'GET', path: '/api/mail/folders/:accountId/:folderId/messages', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'] },
  { method: 'GET', path: '/api/mail/messages/:id', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'], note: 'What is stored, under the mailbox\'s visibility. The owner of a personal mailbox that stores less reads the body live from the provider; nothing is stored.' },
  { method: 'GET', path: '/api/mail/messages/:id/attachments/:attId/view', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'], note: 'For the Inbox\'s viewer only (X-Tracker-View), never a download: a PDF or picture streamed inline from the provider with nosniff and a 25 MB cap, a sheet or text file as data. From a personal mailbox that stores metadata or subjects only, the owner alone; a shared mailbox\'s attachments to whoever reads its mail. Each view is logged.' },
  { method: 'GET', path: '/api/mail/messages/:id/inline/:contentId', access: signedIn, restrictions: ['mailbox-owner', 'mailbox-delegate'], note: 'A cid: image of the message, images only, under the same rule as attachments.' },

  // ---------------------------------------------------------------- inbox
  { method: 'GET', path: '/api/inbox', access: signedIn, restrictions: ['mailbox-delegate'] },
  { method: 'GET', path: '/api/inbox/summary', access: signedIn, restrictions: ['mailbox-delegate'] },
  { method: 'POST', path: '/api/inbox/sync', access: signedIn, note: 'Starts the same sweep the API runs every minute, at most once every 15 seconds; returns nothing from any mailbox.' },
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
  { method: 'GET', path: '/api/questionnaires', access: signedIn, note: 'The service questionnaires, to choose one to send (#208). Templates, not client data: every signed-in user reads them; only admins write.' },
  { method: 'POST', path: '/api/questionnaires', access: mustBeAdmin, why: 'Builds a service questionnaire (#208): what clients are asked before a quotation. Admin › Templates.' },
  { method: 'GET', path: '/api/questionnaires/:id', access: signedIn, note: 'One questionnaire and its versions (#208), as above.' },
  { method: 'PATCH', path: '/api/questionnaires/:id', access: mustBeAdmin, why: 'Renames a questionnaire or switches it off (#208).' },
  { method: 'POST', path: '/api/questionnaires/:id/versions', access: mustBeAdmin, why: 'A new draft of a questionnaire (#208); published versions are frozen.' },
  { method: 'PATCH', path: '/api/questionnaire-versions/:id', access: mustBeAdmin, why: 'Edits a draft questionnaire (#208).' },
  { method: 'POST', path: '/api/questionnaire-versions/:id/publish', access: mustBeAdmin, why: 'Publishes a draft questionnaire (#208) once it passes every check; the previous version is retired.' },
  { method: 'DELETE', path: '/api/questionnaire-versions/:id', access: mustBeAdmin, why: 'Discards a draft questionnaire version (#208).' },
  { method: 'POST', path: '/api/questionnaire-responses', access: signedIn, restrictions: ['parent-owner'], note: 'Sends a questionnaire from an enquiry (#208): only on an enquiry the caller can open.' },
  { method: 'GET', path: '/api/questionnaire-responses', access: signedIn, restrictions: ['parent-owner'], note: 'The questionnaires sent from one enquiry (#208), when the caller can open it.' },
  { method: 'GET', path: '/api/questionnaire-responses/:id', access: signedIn, restrictions: ['record-owner'], note: 'The answers a client gave (#208): the owner of the enquiry, and admins.' },
  { method: 'PATCH', path: '/api/questionnaire-responses/:id', access: signedIn, restrictions: ['record-owner'], note: 'Staff filling in a questionnaire for the client, on an enquiry they own (#208).' },
  { method: 'POST', path: '/api/questionnaire-responses/:id/files', access: signedIn, restrictions: ['record-owner'], note: 'A file for a file question, by staff filling in (#208).' },
  { method: 'POST', path: '/api/questionnaire-responses/:id/submit', access: signedIn, restrictions: ['record-owner'], note: 'Staff submitting what they filled in for the client (#208).' },
  { method: 'POST', path: '/api/questionnaire-responses/:id/link', access: signedIn, restrictions: ['record-owner'], note: 'A new link to the questionnaire, to copy or email (#208).' },
  { method: 'POST', path: '/api/questionnaire-responses/:id/remind', access: signedIn, restrictions: ['record-owner'], note: 'Emails the client a reminder with a new link (#208).' },
  { method: 'POST', path: '/api/questionnaire-responses/:id/revoke', access: signedIn, restrictions: ['record-owner'], note: 'Every open link to the questionnaire stops working (#208).' },
  { method: 'POST', path: '/api/questionnaire-responses/:id/reopen', access: signedIn, restrictions: ['record-owner'], note: 'A submitted questionnaire is open to changes again (#208).' },
  { method: 'GET', path: '/api/portal-admin/actions', access: signedIn, restrictions: ['record-owner'], note: 'What clients said in the portal (#198): queries and payment advice to act on. Scoped like the PO: an admin sees every client\'s, anyone else those on a PO they can open.' },
  { method: 'GET', path: '/api/portal-admin/actions/by-stage', access: signedIn, restrictions: ['record-owner'], note: 'The client\'s latest word on each invoice (#198), for the badges on Collections and Payment stages. Scoped like the PO.' },
  { method: 'POST', path: '/api/portal-admin/actions/:id/resolve', access: signedIn, restrictions: ['record-owner'], note: 'Resolve a client\'s query, or reject a query or a payment advice with a reason the client sees (#198). Only on a PO the caller can open.' },
  { method: 'GET', path: '/api/portal-admin/companies/:id/preview/:section', access: mustBeAdmin, why: 'Preview as client (#198): everything the client\'s portal shows of this company, invoices and GST included.' },

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
  // POs read from email that need a person (docs/email-po-plan.md §3.7).
  { method: 'GET', path: '/api/purchase-orders/review', access: signedIn, restrictions: ['record-owner'], note: 'A salesperson sees the items whose suggested quotation is theirs; an admin sees all.' },
  { method: 'POST', path: '/api/purchase-orders/review/:id/register', access: signedIn, restrictions: ['record-owner'], note: 'Reads the PO again for the Register PO dialog; saves nothing but an unattached upload.' },
  { method: 'POST', path: '/api/purchase-orders/review/:id/dismiss', access: signedIn, restrictions: ['record-owner'] },
  { method: 'POST', path: '/api/purchase-orders/:poNumber/email-read-checked', access: signedIn, restrictions: ['parent-owner'] },
  { method: 'POST', path: '/api/purchase-orders/:poNumber/undo-from-email', access: mustBeAdmin, why: 'Deletes a PO registered from email with its stages and project, and puts its quotation back.' },
  { method: 'POST', path: '/api/purchase-orders/:poNumber/stages', access: signedIn },
  {
    method: 'GET', path: '/api/travel-logs/:travelId/full', access: signedIn,
    restrictions: ['hr-travel-invoices-only'],
    note: 'A trip with its legs, the agency\'s bills and their lines, credit notes, claims, files \u2014 and since the read-through phase (#214 \u00a75.3) a `billing` block read from v_trip_billing: the travel invoice this trip is billed on, as named columns rather than the stage. That block is how HR sees the sales side at all, and the whole of it: the invoice, what has been received, when, its status and its PDF (\u00a74). It is the same block for every role, because there is nothing in it a salesperson may see and the travel desk may not. Reading it needs no new route \u2014 this one is already HR\'s \u2014 and grants no generic payment-stage access: /api/payment-stages and /api/payments stay closed to HR.',
  },
  { method: 'GET', path: '/api/vendor-invoices/:id/full', access: signedIn, note: 'A travel agency invoice with its lines, their trips, its credit notes and files (#196). Open as /api/vendor-invoices is.' },
  { method: 'POST', path: '/api/payment-stages/:id/invoice', access: signedIn },
  // Invoices we emailed that need a person (docs/email-po-plan.md §3.10.5).
  { method: 'GET', path: '/api/payment-stages/invoice-review', access: signedIn, restrictions: ['parent-owner'], note: 'A salesperson sees the items on POs they may open; one matched to no PO is an admin\'s.' },
  { method: 'POST', path: '/api/payment-stages/invoice-review/:id/record', access: signedIn, restrictions: ['parent-owner'], note: 'Reads the invoice again for the invoice dialog; saves nothing but an unattached upload.' },
  { method: 'POST', path: '/api/payment-stages/invoice-review/:id/split', access: signedIn, restrictions: ['parent-owner'], note: 'Splits the PO\'s one open 100% stage as the item suggests; records nothing.' },
  { method: 'POST', path: '/api/payment-stages/invoice-review/:id/dismiss', access: signedIn, restrictions: ['parent-owner'] },
  { method: 'POST', path: '/api/payment-stages/:id/undo-from-email', access: mustBeAdmin, why: 'Takes an invoice recorded from email back off its stage.' },
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
    method: 'POST', path: '/api/vendor-invoices/:id/pay', access: signedIn, restrictions: ['travel-desk-only'],
    note: 'Paying a travel agency: the travel desk\'s work and the administrator\'s, so the handler allows admin and HR and refuses sales (#214). Until then the gate was open to every signed-in role, which let a sales user pay an agency — not a decision anybody took, just an open door. The figure is still the absolute total settled and the route writes the difference as a row in travel_vendor_payments; amount_paid and payment_date are derived from those rows and move only through here, never through PATCH /api/vendor-invoices/:id.',
  },
  {
    method: 'POST', path: '/api/vendor-invoices/:id/pay/correct', access: mustBeAdmin,
    why: 'The only route that can take a vendor payment back off an invoice, or move its cash and TDS legs against each other, so it is the one place a figure already booked against an agency bill can be reduced (#214). It refuses to run without a reason, appends a row rather than editing the ledger — the original payment and the bank advice attached to it are never touched — and records the before and after in the same transaction. Paying is the travel desk\'s; deciding that what the travel desk recorded was wrong is not, for the same reason /api/expense-claims/:id/correct is the administrator\'s: this is the correction path for money, not a tidy-up.',
  },
  {
    method: 'POST', path: '/api/travel-invoices', access: signedIn,
    note: 'Raising the invoice that bills a trip to the client (#214 \u00a75.2): one transaction that creates a payment stage of kind \'travel\' and sets billed_stage_id on the trips it carries. Open to admin and sales, who own the PO side of a trip, and closed to HR by being absent from HR_ROUTES \u2014 the travel desk keeps the trips and the agency\'s bills, but raising a client invoice is not its work (\u00a79.3). It grants HR no generic payment-stage right: /api/payment-stages stays closed to them. The project is owner-scoped, so a salesperson raises invoices on their own projects only, and a 404 answers an id they do not own exactly as it answers one that does not exist.',
  },
  {
    method: 'POST', path: '/api/travel-logs/:travelId/billed-stage', access: signedIn,
    note: 'Which client invoice recovered a trip\'s cost (#214). Open to admin and sales, who own the PO side of a trip, and closed to HR by being absent from HR_ROUTES: HR runs the travel desk and may edit a trip, but deciding which invoice billed it is not the travel desk\'s call. billed_stage_id is `protectedFields` on travel-logs, so this is the only way in — the Trip screen used to reach it through PATCH /api/travel-logs/:id, where nothing but the hidden selector stopped an HR caller writing it.',
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
/** HR may read, write and delete it (#196 §3). */
const HR_ALL = Object.freeze({ read: true, write: true, delete: true });

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
  'travel-logs': {
    read: 'any', write: 'any', delete: 'any', hr: HR_ALL,
    why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2). The travel desk\'s own record too (#196).',
    protectedFields: ['billed_stage_id'],
    protectedBecause: 'Which client invoice recovered a trip\'s cost moves through POST /api/travel-logs/:travelId/billed-stage, which HR cannot reach and which writes an audit row naming the account. Leaving it on the generic form made the Trip screen\'s hidden selector the only restriction there was: HR has full write access to a trip (#196 §3), so an HR caller — or any other — could PATCH billed_stage_id straight through the API and mark a trip as billed on an invoice, or unmark one, with nothing recorded (#214).',
  },
  engagements: { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  tasks: { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  notes: { read: 'any', write: 'any', delete: 'any', why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2).' },
  attachments: { read: 'any', write: 'any', delete: 'any', hr: HR_ALL, restrictions: ['hr-travel-only'], why: 'A salesperson\'s own working record. Open until ownership and row scoping land (#18 Phase 2). HR reaches only the files on trips and vendor invoices (#196).' },
  'quotation-lines': { read: 'any', write: 'any', delete: 'any', why: 'The lines of a quotation, edited with it.' },
  // --- the travel desk (#196) -------------------------------------------
  'travel-segments': { read: 'any', write: 'any', delete: 'any', hr: HR_ALL, why: 'A trip\'s legs, kept with it: open as travel-logs is.' },
  'vendor-invoice-lines': { read: 'any', write: 'any', delete: 'any', hr: HR_ALL, why: 'The lines of a travel vendor invoice, edited with it: open as vendor-invoices is.' },
  'vendor-credit-notes': { read: 'any', write: 'any', delete: 'any', hr: HR_ALL, why: 'A travel vendor\'s credit and cancellation notes, entered with its invoices.' },

  // --- travel finance (#85) ---------------------------------------------
  'vendor-invoices': {
    read: 'any', write: 'any', delete: 'any', hr: HR_ALL,
    why: 'Sales enter vendor invoices as ordinary work.',
    protectedFields: ['amount_paid', 'payment_date'],
    protectedBecause: 'A payment is recorded through POST /api/vendor-invoices/:id/pay, which is the route that audits it. Letting an ordinary PATCH set amount_paid means a vendor invoice can be marked paid with no payment behind it (#85). Since #214 both columns are also *derived*: they are kept by a trigger from the travel_vendor_payments ledger, so a figure written here by hand would be silently undone by the next payment anyway.',
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
  'travel-vendors': { read: 'any', write: 'admin', delete: 'admin', hr: HR_ALL, why: 'A Settings catalogue: one edit re-labels every record that used the old value. HR owns the agency list (#196), so an administrator and HR change it (hrWrites).' },
  'expense-categories': { read: 'any', write: 'admin', delete: 'admin', why: 'A Settings catalogue: one edit re-labels every record that used the old value.' },
  'trip-types': { read: 'any', write: 'admin', delete: 'admin', hr: HR_ALL, why: 'A Settings catalogue (#196): a type\'s chargeable flag decides which trips may be billed to a client. Kept by an administrator and the travel desk (hrWrites).' },
  'exchange-rates': { read: 'any', write: 'admin', delete: 'admin', why: 'One rate re-values every historical deal in every report.' },
  'document-profiles': { read: 'any', write: 'admin', delete: 'admin', why: 'A client\'s document note goes into every AI reading of that client\'s POs or invoices, and its PO-number pattern sends a PO that does not fit to review: one edit changes what the readers register.' },
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

// ---------------------------------------------------------------------
// The HR role (#196 §3)
// ---------------------------------------------------------------------

/**
 * The explicit routes the HR role may use, on top of the CRUD resources
 * whose entry above carries `hr`. Everything else answers 403 to HR
 * (hrGate in auth/middleware.js), whatever its `access` says: HR is the
 * travel desk, not a sales user with fewer rows.
 *
 * Its own account, notifications and saved views; the dropdowns (lookups
 * answers HR with the travel lists only); uploading and opening documents;
 * the travel dashboard and payables; a trip in full; paying a vendor
 * invoice, which stays open to every signed-in role as before.
 */
export const HR_ROUTES = [
  'GET /api/auth/account', 'PATCH /api/auth/account', 'POST /api/auth/account/password',
  'DELETE /api/auth/account/identities/:provider', 'DELETE /api/auth/account/sessions/:id', 'POST /api/auth/account/sessions/revoke-all',
  'GET /api/notifications', 'GET /api/notifications/summary', 'POST /api/notifications/read-all', 'POST /api/notifications/:id/read',
  'GET /api/views', 'POST /api/views', 'PATCH /api/views/:id', 'DELETE /api/views/:id', 'POST /api/views/order',
  'GET /api/lookups', 'GET /api/lookups/next-id/:kind', 'GET /api/settings',
  'POST /api/documents', 'GET /api/documents/:id',
  'GET /api/dashboard/travel', 'GET /api/dashboard/payables', 'GET /api/export/payables.csv',
  'GET /api/travel-logs/:travelId/full', 'GET /api/vendor-invoices/:id/full', 'POST /api/vendor-invoices/:id/pay',
  // The travel importer (#196 §5).
  'GET /api/import/travel/template.xlsx', 'POST /api/import/travel', 'GET /api/import/travel',
  'GET /api/import/travel/:id', 'PATCH /api/import/travel/:id', 'DELETE /api/import/travel/:id',
  'PATCH /api/import/travel/:id/items/:itemId', 'POST /api/import/travel/:id/items/:itemId/split', 'POST /api/import/travel/:id/duplicates',
  'POST /api/import/travel/:id/commit', 'POST /api/import/travel/:id/documents', 'POST /api/import/travel/documents',
];

const OPERATION_NEEDS = { list: 'read', read: 'read', create: 'write', update: 'write', delete: 'delete' };

/** Every declared route HR may use: HR_ROUTES and the CRUD routes of the resources marked `hr`. */
export function hrRoutes() {
  const explicit = new Set(HR_ROUTES);
  return policyRoutes().filter((r) => (r.resource
    ? Boolean(resourceAccess[r.resource]?.hr?.[OPERATION_NEEDS[r.operation]])
    : explicit.has(`${r.method} ${r.path}`)));
}

const pattern = (path) => new RegExp(`^${path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`);
let compiledHr = null;

/** May the HR role make this request? method: GET, POST…; path: as requested, without the query string. */
export function hrMayUse(method, path) {
  compiledHr ??= hrRoutes().map((r) => ({ method: r.method, re: pattern(r.path) }));
  const m = method === 'HEAD' ? 'GET' : method;
  return compiledHr.some((r) => r.method === m && r.re.test(path));
}
