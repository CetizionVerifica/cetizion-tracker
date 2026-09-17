import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';

import { config } from './config.js';
import { query } from './db.js';
import { resources } from './lib/resources.js';
import { crudRouter } from './lib/crud.js';
import { errorHandler, notFound } from './middleware/error.js';
import { authRouter } from './auth/routes.js';
import { authConfig } from './auth/config.js';
import { requireAuth } from './auth/middleware.js';
import { mountWebApp } from './web.js';
import { dashboardRouter } from './routes/dashboard.js';
import { lookupRouter, settingsRouter } from './routes/lookups.js';
import { exportRouter } from './routes/export.js';
import { importRouter } from './routes/import.js';
import { documentRouter } from './routes/documents.js';
import { userRouter } from './routes/users.js';
import { companyRouter } from './routes/companies.js';
import { emailRouter, jobRouter } from './routes/emails.js';
import { quotationDocRouter } from './routes/quotations.js';
import { pipelineRouter } from './routes/pipeline.js';
import { registerRouter } from './routes/register.js';
import { approvalRouter } from './routes/approvals.js';
import { taskSummaryRouter, timelineRouter } from './routes/timeline.js';
import { collectionsRouter } from './routes/collections.js';
import { renewalsRouter } from './routes/renewals.js';
import { cashflowRouter } from './routes/cashflow.js';
import { notificationsRouter } from './routes/notifications.js';
import { communicationsRouter } from './routes/communications.js';
import { acceptanceRouter, publicAcceptanceRouter } from './routes/acceptance.js';
import { deliverablesRouter } from './routes/deliverables.js';
import { mailboxRouter, mailThreadRouter, mailWebhookRouter } from './routes/mailboxes.js';
import { inboxRouter } from './routes/inbox.js';
import { profitabilityRouter } from './routes/profitability.js';
import { visitsRouter } from './routes/visits.js';
import { incomingHooksRouter, webhooksRouter } from './routes/webhooks.js';
import { portalAdminRouter, portalRouter } from './routes/portal.js';
import { accountingRouter } from './routes/accounting.js';
import { apiTokenRouter, mcpRouter } from './routes/mcp.js';
import { clientErrorRouter, healthHandler, metricsRouter } from './routes/ops.js';
import { requestLogger } from './lib/ops/logger.js';
import { httpMetrics } from './lib/ops/metrics.js';
import { appEnv, stagingGate } from './lib/ops/environment.js';
import {
  projectRouter, poRouter, quotationRouter, stageRouter,
  vendorInvoiceRouter, claimRouter, travelRouter,
} from './routes/workflow.js';

const app = express();

// Behind Traefik or nginx this is what makes req.ip the visitor rather than
// the proxy. Left off by default: trusting a proxy that is not there lets a
// caller forge their own address.
app.set('trust proxy', config.trustProxy);

// The other half of that setting: if a proxy IS in front of us and this says
// there is not, req.ip is the proxy's address for every visitor. Rate limits
// then share one bucket for the whole internet and the IP recorded against a
// client's acceptance is Traefik's, not theirs. It only shows in production
// and it shows as something else, so say it once and say it plainly.
let proxyWarned = false;
app.use((req, _res, next) => {
  if (!proxyWarned && !config.trustProxy && req.headers['x-forwarded-for']) {
    proxyWarned = true;
    console.warn('[config] Requests carry X-Forwarded-For but TRUST_PROXY=0, so every caller looks like the proxy: rate limits are one shared bucket and recorded IP addresses are wrong. Set TRUST_PROXY to the number of proxies in front of this API (1 behind Dokploy or Traefik).');
  }
  next();
});

// Security headers (#34): HSTS where cookies are secure, no framing by other
// sites, no full referrer to other origins.
app.use(helmet({
  hsts: authConfig.secureCookie ? { maxAge: 31536000, includeSubDomains: true } : false,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
// Staging sits behind a shared credential (#35).
app.use(stagingGate);
app.use(compression());
app.use(cors({
  origin: config.corsOrigin.split(',').map((s) => s.trim()),
  credentials: true,
}));
// The raw bytes are kept for routes that check a signature over them.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(requestLogger);
app.use(httpMetrics);

// When this process started. The deploy job watches it change to know the
// new container is serving, which also means its migrations went through.
const STARTED_AT = new Date().toISOString();

// Public: the platform needs somewhere to point a health check, and this
// says nothing beyond "the database answered" and when the API started.
// auth_mode is here so a cutover can be confirmed with one request rather
// than a browser. It gives nothing away: /api/auth/config already tells any
// unauthenticated caller the same thing, because the sign-in form has to
// know which field to draw.
app.get('/api/health', async (req, res) => {
// ?deep=1 is for signed-in people only (#38); the plain answer stays public.
app.get('/api/health', healthHandler, async (req, res) => {
  const { rows } = await query('SELECT now() AS now');
  res.json({ status: 'ok', time: rows[0].now, started_at: STARTED_AT, auth_mode: authConfig.mode });
  res.json({ status: 'ok', time: rows[0].now, started_at: STARTED_AT, environment: appEnv() });
});

app.use('/api/auth', authRouter);

// Public by design: a client opens their own quotation with a single-use
// token (#53). The router rate-limits itself and shows nothing else.
app.use('/api/public/accept', publicAcceptanceRouter);
// Microsoft Graph posts mail notifications here; each is checked against its subscription's secret.
app.use('/api/mail', mailWebhookRouter);
// Signed incoming events (#49), off unless switched on in Settings.
app.use('/api/hooks', incomingHooksRouter);
// The client portal (#47) has its own sign-in and session; see routes/portal.js.
app.use('/api/portal', portalRouter);
// MCP clients authenticate with an API token instead of a session (#50).
app.use('/api/mcp', mcpRouter);

// Everything past this line needs a session.
app.use('/api', requireAuth);

app.use('/api/dashboard', dashboardRouter);
app.use('/api/lookups', lookupRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/export', exportRouter);
app.use('/api/import', importRouter);
app.use('/api/documents', documentRouter);
// Admin only, at its own router.
app.use('/api/users', userRouter);

// Workflow routes are mounted ahead of the generic CRUD ones so their
// two-segment paths (/:id/full, /:id/convert) are matched first.
app.use('/api/companies', companyRouter);
app.use('/api/emails', emailRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/timeline', timelineRouter);
app.use('/api/collections', collectionsRouter);
app.use('/api/renewals', renewalsRouter);
app.use('/api/cashflow', cashflowRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/communications', communicationsRouter);
app.use('/api/deliverables', deliverablesRouter);
app.use('/api/mailboxes', mailboxRouter);
app.use('/api/mail', mailThreadRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/profitability', profitabilityRouter);
app.use('/api/visits', visitsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/portal-admin', portalAdminRouter);
app.use('/api/accounting', accountingRouter);
app.use('/api/api-tokens', apiTokenRouter);
app.use('/api/client-errors', clientErrorRouter);
app.use('/api/tasks', taskSummaryRouter);
app.use('/api/jobs', jobRouter);
app.use('/api/projects', projectRouter);
app.use('/api/purchase-orders', poRouter);
app.use('/api/quotations', registerRouter);
app.use('/api/quotations', approvalRouter);
app.use('/api/quotations', acceptanceRouter);
app.use('/api/quotations', quotationDocRouter);
app.use('/api/quotations', quotationRouter);
app.use('/api/payment-stages', stageRouter);
app.use('/api/vendor-invoices', vendorInvoiceRouter);
app.use('/api/expense-claims', claimRouter);
app.use('/api/travel-logs', travelRouter);

for (const [name, def] of Object.entries(resources)) {
  app.use(`/api/${name}`, crudRouter(name, def));
}

// An unknown /api path is a 404 in JSON; anything else is a front-end route
// and belongs to the SPA.
app.use('/api', notFound);
// Prometheus metrics (#38): a bearer token or a staff session, never public.
app.use('/metrics', metricsRouter);

mountWebApp(app);
app.use(notFound);
app.use(errorHandler);

export default app;
