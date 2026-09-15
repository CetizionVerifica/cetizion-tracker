import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';

import { config } from './config.js';
import { query } from './db.js';
import { resources } from './lib/resources.js';
import { crudRouter } from './lib/crud.js';
import { errorHandler, notFound } from './middleware/error.js';
import { authRouter } from './auth/routes.js';
import { requireAuth } from './auth/middleware.js';
import { mountWebApp } from './web.js';
import { dashboardRouter } from './routes/dashboard.js';
import { lookupRouter, settingsRouter } from './routes/lookups.js';
import { exportRouter } from './routes/export.js';
import { documentRouter } from './routes/documents.js';
import {
  projectRouter, poRouter, quotationRouter, stageRouter,
  vendorInvoiceRouter, claimRouter, travelRouter,
} from './routes/workflow.js';

const app = express();

// Behind Traefik or nginx this is what makes req.ip the visitor rather than
// the proxy. Left off by default: trusting a proxy that is not there lets a
// caller forge their own address.
app.set('trust proxy', config.trustProxy);

app.use(helmet());
app.use(compression());
app.use(cors({
  origin: config.corsOrigin.split(',').map((s) => s.trim()),
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
if (config.nodeEnv !== 'test') app.use(morgan('dev'));

// When this process started. The deploy job watches it change to know the
// new container is serving, which also means its migrations went through.
const STARTED_AT = new Date().toISOString();

// Public: the platform needs somewhere to point a health check, and this
// says nothing beyond "the database answered" and when the API started.
app.get('/api/health', async (req, res) => {
  const { rows } = await query('SELECT now() AS now');
  res.json({ status: 'ok', time: rows[0].now, started_at: STARTED_AT });
});

app.use('/api/auth', authRouter);

// Everything past this line needs a session.
app.use('/api', requireAuth);

app.use('/api/dashboard', dashboardRouter);
app.use('/api/lookups', lookupRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/export', exportRouter);
app.use('/api/documents', documentRouter);

// Workflow routes are mounted ahead of the generic CRUD ones so their
// two-segment paths (/:id/full, /:id/convert) are matched first.
app.use('/api/projects', projectRouter);
app.use('/api/purchase-orders', poRouter);
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
mountWebApp(app);
app.use(notFound);
app.use(errorHandler);

export default app;
