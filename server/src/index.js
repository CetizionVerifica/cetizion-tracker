import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';

import { config } from './config.js';
import { query } from './db.js';
import { resources } from './lib/resources.js';
import { crudRouter } from './lib/crud.js';
import { errorHandler, notFound } from './middleware/error.js';
import { dashboardRouter } from './routes/dashboard.js';
import { lookupRouter, settingsRouter } from './routes/lookups.js';
import { exportRouter } from './routes/export.js';
import {
  projectRouter, poRouter, quotationRouter, stageRouter,
  vendorInvoiceRouter, claimRouter, travelRouter,
} from './routes/workflow.js';

const app = express();

app.use(helmet());
app.use(compression());
app.use(cors({ origin: config.corsOrigin.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '1mb' }));
if (config.nodeEnv !== 'test') app.use(morgan('dev'));

app.get('/api/health', async (req, res) => {
  const { rows } = await query('SELECT now() AS now');
  res.json({ status: 'ok', time: rows[0].now });
});

app.use('/api/dashboard', dashboardRouter);
app.use('/api/lookups', lookupRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/export', exportRouter);

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

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`Cetizion API listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export default app;
