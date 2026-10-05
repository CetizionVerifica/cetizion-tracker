#!/usr/bin/env node
/**
 * A demo database full of made-up data, for showing the tracker to a client
 * (5 Oct 2026: "dummy data not associated with Cetizion client data, strictly").
 *
 *   DEMO_DATABASE_URL=postgres://user:pass@localhost:5432/cetizion_demo npm run demo:data
 *
 * Drops and rebuilds that database from schema.sql and views.sql (as
 * `npm run migrate` does). It never loads seed.sql, which is the real
 * workbook. Then it fills the database through the app's own API, so every
 * record is one the app made: fictional companies and contacts, enquiries
 * from every source, quotations at every pipeline stage, POs with payment
 * stages, invoices (some overdue), payments, projects with milestones,
 * visits, tasks, travel and expense claims, a renewal. Every company,
 * person, GSTIN and address is invented; email addresses are on
 * example.com, which cannot receive mail. Dates are relative to today, so
 * the dashboards, the follow-ups and the daily briefing all have something
 * to show whenever it is run.
 *
 * It refuses a database whose name does not end in _demo, and a host that
 * is not this machine. It signs in with a login it makes up for this run
 * only (shared mode, in this process); nobody's own password is used.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const target = process.env.DEMO_DATABASE_URL;
if (!target) {
  console.error('Set DEMO_DATABASE_URL to the demo database, e.g. postgres://user:pass@localhost:5432/cetizion_demo');
  process.exit(1);
}
const url = new URL(target);
const dbName = decodeURIComponent(url.pathname.slice(1));
if (!/_demo$/.test(dbName)) { console.error(`✗ refusing "${dbName}": a demo database's name ends in _demo.`); process.exit(1); }
if (!['localhost', '127.0.0.1', '::1', ''].includes(url.hostname)) { console.error(`✗ refusing ${url.hostname}: the demo database is built on this machine only.`); process.exit(1); }

// ---------------------------------------------------------------- dates
const DAY = 864e5;
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10); // IST
const d = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
// The working day on or after d(n): visits are refused on a day the team is off.
const wd = (n) => { let k = n; while ([0, 6].includes(new Date(`${d(k)}T00:00:00Z`).getUTCDay())) k += n < 0 ? -1 : 1; return d(k); };

// ---------------------------------------------------------------- the build
async function rebuild() {
  const admin = new pg.Client({ connectionString: Object.assign(new URL(target), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const db = new pg.Client({ connectionString: target });
  await db.connect();
  for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));
  console.log(`✓ ${dbName}: schema and views`);
  return db;
}

const db = await rebuild();

// The app, in this process, on the demo database, with a login made up for this run.
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'development';
process.env.AUTH_MODE = 'shared';
process.env.AUTH_USERNAME = 'demo-seeder';
process.env.AUTH_PASSWORD = randomBytes(18).toString('base64url');
process.env.EMAIL_MODE = 'log';
process.env.OPENROUTER_API_KEY = ''; // no AI call while seeding
process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
const { markMigrationsApplied } = await import('../src/migrations.js');
await markMigrationsApplied({ connectionString: target });
const { default: app } = await import('../src/app.js');
const { default: request } = await import('supertest');
const agent = request.agent(app);
await agent.post('/api/auth/login').send({ username: process.env.AUTH_USERNAME, password: process.env.AUTH_PASSWORD }).expect(200);

async function api(method, path, body, ok = [200, 201]) {
  const res = await agent[method](`/api${path}`).send(body ?? {});
  if (!ok.includes(res.status)) throw new Error(`${method.toUpperCase()} ${path} → ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body?.data;
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

// ---------------------------------------------------------------- settings and lists
await db.query(`UPDATE settings SET value = $2 WHERE key = $1`, ['company_name', 'Cetizion Verifica']);
for (const [key, value] of [['finance_email', 'finance@demo.example.com'], ['hr_email', 'hr@demo.example.com'], ['internal_email_domains', 'demo.example.com']]) {
  await db.query(`INSERT INTO settings (key, value, notes) VALUES ($1, $2, 'Demo') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}
// Cetizion's own service catalogue and expense heads: what the company sells, not client data.
const SERVICES = ['Ecovadis Assessment (consulting)', 'Assurance', 'GHG report preparation', 'Sustainability report Preparation', 'ESG project',
  'ISO audits', 'PSCI audits', 'ASI audit', 'Supply chain audit', 'CBAM verification'];
for (const [i, name] of SERVICES.entries()) await db.query('INSERT INTO services (name, sort_order) VALUES ($1, $2) ON CONFLICT DO NOTHING', [name, i + 1]);
for (const name of ['Airfare', 'Train fare', 'Local transport / cab', 'Hotel / lodging', 'Meals', 'Per diem / allowance', 'Miscellaneous']) {
  await db.query('INSERT INTO expense_categories (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
}
await db.query(`INSERT INTO travel_vendors (name) VALUES ('Skyline Travels (demo)'), ('Metro Stays (demo)') ON CONFLICT DO NOTHING`);
const serviceId = async (name) => (await one('SELECT id FROM services WHERE name = $1', [name]))?.id ?? null;
const sourceId = async (name) => (await one('SELECT id FROM lead_sources WHERE name = $1', [name]))?.id ?? null;
const stageId = async (name) => (await one('SELECT id FROM pipeline_stages WHERE name = $1', [name])).id;
const lostReason = async (name) => (await one('SELECT id FROM lost_reasons WHERE name = $1', [name])).id;
// Rates for the foreign-currency deals, as the daily ECB feed would hold them (demo values).
for (const [from_currency, rate] of [['EUR', 103.2], ['USD', 88.4], ['GBP', 117.5], ['AED', 24.07], ['SGD', 68.6]]) {
  await api('post', '/exchange-rates', { from_currency, rate, effective_from: d(-120), source: 'manual', note: 'Demo rate' });
}
console.log('✓ settings, services, expense categories, exchange rates');

// ---------------------------------------------------------------- people
const SALES = [{ name: 'Neha Kapoor', email: 'neha.kapoor@demo.example.com' }, { name: 'Arjun Mehta', email: 'arjun.mehta@demo.example.com' }];
const staff = {};
for (const [name, role] of [['Ritu Sharma', 'Lead auditor'], ['Vikram Rao', 'Auditor'], ['Kabir Singh', 'ESG consultant'], ['Ananya Iyer', 'Project manager']]) {
  staff[name] = (await api('post', '/visits/staff', { name, role, email: `${name.toLowerCase().replace(' ', '.')}@demo.example.com` })).id;
}

// The salespeople as user accounts, so records have owners (Insights by owner, the owner columns).
// Their passwords are random and kept nowhere: in shared sign-in nobody signs in as them.
const users = {};
// The app keeps at least one admin account before any other: one for the demo first.
await api('post', '/users', { name: 'Demo Admin', email: 'admin@demo.example.com', role: 'admin', password: randomBytes(18).toString('base64url') });
for (const s of SALES) users[s.name] = (await api('post', '/users', { name: s.name, email: s.email, role: 'sales', password: randomBytes(18).toString('base64url') })).id;

// ---------------------------------------------------------------- companies and contacts (all invented)
const COMPANIES = [
  { key: 'nw', name: 'Northwind Polymers Pvt Ltd', sector: 'Chemicals', city: 'Pune', gstin: '27AAZCN0101K1Z3', contact: ['Priya Nair', 'Head of Sustainability'] },
  { key: 'bp', name: 'Bluepeak Textiles Ltd', sector: 'Textiles', city: 'Tiruppur', gstin: '33AAZCB0102K1Z1', contact: ['Rohan Desai', 'Compliance Manager'] },
  { key: 'gf', name: 'Greenfield Agro Foods Pvt Ltd', sector: 'Food Processing', city: 'Indore', gstin: '23AAZCG0103K1Z9', contact: ['Meera Joshi', 'EHS Head'] },
  { key: 'va', name: 'Vantage Auto Components Ltd', sector: 'Automotive', city: 'Chennai', gstin: '33AAZCV0104K1Z7', contact: ['Sanjay Kulkarni', 'Quality Head'] },
  { key: 'sl', name: 'Silverline Pharma Pvt Ltd', sector: 'Pharmaceutical', city: 'Hyderabad', gstin: '36AAZCS0105K1Z5', contact: ['Farah Siddiqui', 'Sustainability Lead'] },
  { key: 'cw', name: 'Crestwave Steel Ltd', sector: 'Metal Industry', city: 'Jamshedpur', gstin: '20AAZCC0106K1Z3', contact: ['Aditya Bose', 'GM Exports'] },
  { key: 'lp', name: 'Lotus Packaging Solutions Pvt Ltd', sector: 'Packaging', city: 'Ahmedabad', gstin: '24AAZCL0107K1Z1', contact: ['Tanvi Shah', 'Purchase Manager'] },
  { key: 'ml', name: 'Meridian Logistics Pvt Ltd', sector: 'Logistics', city: 'Mumbai', gstin: '27AAZCM0108K1Z9', contact: ['Imran Qureshi', 'CSR Manager'] },
  { key: 'sc', name: 'Sunrise Ceramics Ltd', sector: 'Ceramics', city: 'Morbi', gstin: '24AAZCS0109K1Z7', contact: ['Kavita Reddy', 'Director'] },
  { key: 'ae', name: 'Aurora Electronics Pvt Ltd', sector: 'Electronics', city: 'Noida', gstin: '09AAZCA0110K1Z5', contact: ['Harish Gupta', 'Plant Head'] },
  { key: 'kl', name: 'Kestrel Leather Exports', sector: 'Leather', city: 'Kanpur', gstin: '09AAZFK0111K1Z3', contact: ['Nikhil Jain', 'Partner'] },
  { key: 'eh', name: 'Evergreen Hotels & Resorts Ltd', sector: 'Hospitality', city: 'Panaji', gstin: '30AAZCE0112K1Z1', contact: ['Lakshmi Menon', 'Sustainability Manager'] },
  { key: 'nm', name: 'Nordlicht Maschinen GmbH', sector: 'Machinery', city: 'Stuttgart', gstin: null, contact: ['Daniel Weber', 'Procurement'], country: 'Germany' },
  { key: 'pc', name: 'Pacific Coast Apparel Inc', sector: 'Apparel', city: 'Portland', gstin: null, contact: ['Emily Carter', 'Sourcing Director'], country: 'United States' },
];
const co = {};
for (const c of COMPANIES) {
  const slug = c.name.toLowerCase().split(' ')[0];
  const company = await api('post', '/companies', { name: c.name, sector: c.sector, city: c.city, gstin: c.gstin, website: `https://${slug}.example.com`, address: `${c.city} (demo address)`, notes: 'Demo company: invented for the demo.' });
  const email = `${c.contact[0].toLowerCase().replace(' ', '.')}@${slug}.example.com`;
  const contact = await api('post', '/contacts', { company_id: company.id, name: c.contact[0], role: c.contact[1], email, phone: '+91 90000 00000', is_billing: true });
  co[c.key] = { ...c, id: company.id, contactId: contact.id, email, country: c.country || 'India' };
}
console.log(`✓ ${COMPANIES.length} companies, each with a contact`);

// ---------------------------------------------------------------- enquiries
const ENQUIRIES = [
  { k: 'nw', at: -82, source: 'Website', service: 'Ecovadis Assessment (consulting)', value: 450000, sales: 0 },
  { k: 'bp', at: -75, source: 'Referral', service: 'GHG report preparation', value: 600000, sales: 1 },
  { k: 'gf', at: -70, source: 'Event or webinar', service: 'Sustainability report Preparation', value: 800000, sales: 0 },
  { k: 'va', at: -60, source: 'Existing client', service: 'ISO audits', value: 350000, sales: 1 },
  { k: 'sl', at: -55, source: 'Website', service: 'PSCI audits', value: 500000, sales: 0 },
  { k: 'cw', at: -50, source: 'Partner or certification body', service: 'CBAM verification', value: 700000, sales: 1 },
  { k: 'lp', at: -45, source: 'Website', service: 'Supply chain audit', value: 300000, sales: 0 },
  { k: 'ml', at: -40, source: 'Inbound email or call', service: 'ESG project', value: 900000, sales: 1 },
  { k: 'sc', at: -30, source: 'Website', service: 'Ecovadis Assessment (consulting)', value: 400000, sales: 0, followUp: -4 },
  { k: 'ae', at: -20, source: 'Referral', service: 'ASI audit', value: 650000, sales: 1 },
  { k: 'nm', at: -25, source: 'Website', service: 'CBAM verification', value: 18000, currency: 'EUR', sales: 1 },
  { k: 'pc', at: -15, source: 'Outreach', service: 'Ecovadis Assessment (consulting)', value: 9000, currency: 'USD', sales: 0 },
  { k: 'kl', at: -12, source: 'Website', service: 'Supply chain audit', value: 250000, sales: 0, followUp: -2, status: 'Contacted' },
  { k: 'eh', at: -6, source: 'Event or webinar', service: 'Sustainability report Preparation', value: 550000, sales: 1, followUp: 2, status: 'Contacted' },
  { k: 'gf', at: -3, source: 'Existing client', service: 'Assurance', value: 300000, sales: 0, followUp: 1 },
  { k: 'va', at: -1, source: 'Inbound email or call', service: 'GHG report preparation', value: 420000, sales: 1, followUp: 3 },
  { k: 'lp', at: -2, source: 'Existing client', service: 'GHG report preparation', value: 380000, sales: 0, followUp: 2 },
];
const enq = [];
for (const e of ENQUIRIES) {
  const c = co[e.k];
  const s = SALES[e.sales];
  enq.push({ ...e, row: await api('post', '/enquiries', {
    enquiry_date: d(e.at), client_name: c.name, source_id: await sourceId(e.source), sector: c.sector, country: c.country,
    contact_person: c.contact[0], contact_email: c.email, sales_person: s.name, sales_person_email: s.email, service: e.service,
    estimated_value: e.value, currency: e.currency || 'INR', status: e.status || (e.at <= -15 ? 'Qualified' : 'New'), next_follow_up_at: e.followUp != null ? d(e.followUp) : null,
    notes: 'Demo enquiry.',
  }) });
}
console.log(`✓ ${enq.length} enquiries`);

// ---------------------------------------------------------------- quotations
async function quotation(e, { lines, stage, sentAfter = 2, lost = null, nextStep = null, close = null }) {
  const c = co[e.k];
  const s = SALES[e.sales];
  const q = await api('post', '/quotations', {
    client_name: c.name, contact_person: c.contact[0], contact_email: c.email, service_quoted: e.service, sector: c.sector, country: c.country,
    sales_person: s.name, sales_person_email: s.email, quotation_date: d(e.at + sentAfter), currency: e.currency || 'INR', valid_until: d(e.at + sentAfter + 90), expected_close_date: close === null ? undefined : d(close),
    terms: '50% advance on PO, balance on submission of the final report. GST extra as applicable.',
    next_step: nextStep,
  });
  for (const [i, [service, qty, rate]] of lines.entries()) {
    await api('post', '/quotation-lines', { quotation_id: q.id, service_id: await serviceId(service), description: service, qty, rate, gst_rate: c.country === 'India' ? 18 : 0, sort_order: i + 1 });
  }
  await api('patch', `/enquiries/${e.row.id}`, { quotation_no: q.quotation_no });
  if (stage) await api('patch', `/quotations/${q.id}`, { stage_id: await stageId(stage), ...(lost ? { lost_reason_id: await lostReason(lost), lost_notes: 'Demo: lost on price.' } : {}) });
  if (stage && stage !== 'Draft') await db.query('UPDATE quotations SET sent_at = $2 WHERE id = $1 AND sent_at IS NULL', [q.id, `${d(e.at + sentAfter)}T11:00:00+05:30`]);
  return q;
}
const Q = {};
Q.nw = await quotation(enq[0], { lines: [['Ecovadis Assessment (consulting)', 1, 380000]], stage: 'Sent' });
Q.bp = await quotation(enq[1], { lines: [['GHG report preparation', 1, 420000], ['Assurance', 1, 120000]], stage: 'Sent' });
Q.gf = await quotation(enq[2], { lines: [['Sustainability report Preparation', 1, 600000], ['GHG report preparation', 1, 150000]], stage: 'Sent' });
Q.va = await quotation(enq[3], { lines: [['ISO audits', 3, 95000]], stage: 'Sent' });
Q.sl = await quotation(enq[4], { lines: [['PSCI audits', 2, 210000]], stage: 'Verbal yes, awaiting PO', nextStep: 'Collect the PO from purchase', close: 10 });
Q.cw = await quotation(enq[5], { lines: [['CBAM verification', 1, 640000]], stage: 'Negotiation', nextStep: 'Send the revised scope', close: 21 });
Q.lp = await quotation(enq[6], { lines: [['Supply chain audit', 4, 70000]], stage: 'Sent', nextStep: 'Follow up on the decision', close: 14 });
Q.ml = await quotation(enq[7], { lines: [['ESG project', 1, 850000]], stage: 'Lost', lost: 'Price' });
Q.sc = await quotation(enq[8], { lines: [['Ecovadis Assessment (consulting)', 1, 360000]], stage: 'Sent', close: 30 });
Q.ae = await quotation(enq[9], { lines: [['ASI audit', 1, 580000]], stage: 'Draft', close: 45 });
Q.nm = await quotation(enq[10], { lines: [['CBAM verification', 1, 16500]], stage: 'Sent' });
Q.pc = await quotation(enq[11], { lines: [['Ecovadis Assessment (consulting)', 1, 8500]], stage: 'Sent', sentAfter: 14, close: 35 });
// What months of real use leave behind: owners, first replies, and how long each deal has sat in its stage.
for (const s of SALES) {
  await db.query('UPDATE enquiries SET owner_user_id = $1 WHERE sales_person = $2', [users[s.name], s.name]);
  await db.query('UPDATE quotations SET owner_user_id = $1 WHERE sales_person = $2', [users[s.name], s.name]);
}
await db.query(`UPDATE enquiries SET first_responded_at = (enquiry_date + 1)::timestamp + interval '11 hours' WHERE enquiry_date < $1`, [d(-1)]);
await db.query(`UPDATE quotations SET stage_changed_at = sent_at + interval '3 days' WHERE sent_at IS NOT NULL`);
// The later-stage deals moved recently: two left to go stale, to show the board flagging them.
await db.query(`UPDATE quotations SET stage_changed_at = now() - interval '6 days' WHERE status = 'Under Negotiation'`);
console.log(`✓ ${Object.keys(Q).length} quotations, Draft to Lost, with owners`);

// ---------------------------------------------------------------- POs, stages, invoices, payments
const register = (q, body) => api('post', `/quotations/${encodeURIComponent(q.quotation_no)}/register`, body);
const stagesOf = async (po) => (await db.query('SELECT id, stage_no, stage_name, stage_amount::float8 AS amount FROM v_payment_stages WHERE po_number = $1 ORDER BY stage_no', [po])).rows;
const invoice = (stage, date) => api('post', `/payment-stages/${stage.id}/invoice`, { invoice_date: date });
const pay = (stage, amount, date, mode = 'bank_transfer') => api('post', `/payment-stages/${stage.id}/payment`, { amount_received: amount, payment_received_date: date, payment_mode: mode, reference: 'Demo receipt' });

// Northwind: 50/50, advance invoiced and paid, delivered this week (balance to invoice).
await register(Q.nw, { po_number: 'NWP/PO/2026/0412', po_date: d(-58), payment_terms_days: 30, project_manager: 'Ananya Iyer', project_manager_email: 'ananya.iyer@demo.example.com', planned_start_date: d(-55), planned_delivery_date: d(-3),
  stages: [{ stage_name: 'Advance (50%)', trigger_event: 'On PO Registration', percent: 50 }, { stage_name: 'On delivery (50%)', trigger_event: 'On Delivery', percent: 50 }] });
let st = await stagesOf('NWP/PO/2026/0412');
await invoice(st[0], d(-55));
await pay(st[0], st[0].amount, d(-38));
await api('patch', `/purchase-orders/${encodeURIComponent('NWP/PO/2026/0412')}`, { actual_initiation_date: d(-52), actual_delivery_date: d(-3) });
st = await stagesOf('NWP/PO/2026/0412');
await invoice(st[1], d(-2));

// Bluepeak: 50/50, advance invoiced and not paid: overdue.
await register(Q.bp, { po_number: '4500088123', po_date: d(-50), payment_terms_days: 30, project_manager: 'Kabir Singh', project_manager_email: 'kabir.singh@demo.example.com', planned_delivery_date: d(20),
  stages: [{ stage_name: 'Advance (50%)', trigger_event: 'On PO Registration', percent: 50 }, { stage_name: 'On delivery (50%)', trigger_event: 'On Delivery', percent: 50 }] });
st = await stagesOf('4500088123');
await invoice(st[0], d(-48));
await api('patch', '/purchase-orders/4500088123', { actual_initiation_date: d(-45) });

// Greenfield: 30 / 40 on the draft report / 30, advance paid, draft reached: the milestone invoice is to raise.
await register(Q.gf, { po_number: 'GAF/WO/2026/77', po_date: d(-45), payment_terms_days: 45, project_manager: 'Ananya Iyer', project_manager_email: 'ananya.iyer@demo.example.com', planned_delivery_date: d(25),
  stages: [{ stage_name: 'Advance (30%)', trigger_event: 'On PO Registration', percent: 30 }, { stage_name: 'Draft report (40%)', trigger_event: 'On Milestone', percent: 40, milestone_name: 'Draft report' },
    { stage_name: 'On delivery (30%)', trigger_event: 'On Delivery', percent: 30 }] });
st = await stagesOf('GAF/WO/2026/77');
await invoice(st[0], d(-43));
await pay(st[0], st[0].amount, d(-30), 'cheque');
await api('patch', `/purchase-orders/${encodeURIComponent('GAF/WO/2026/77')}`, { actual_initiation_date: d(-40) });
const gfProject = (await one('SELECT project_id FROM purchase_orders WHERE po_number = $1', ['GAF/WO/2026/77'])).project_id;
const milestone = await one('SELECT id FROM project_milestones WHERE project_id = $1 AND name = $2', [gfProject, 'Draft report']);
if (milestone) await api('patch', `/project-milestones/${milestone.id}`, { reached_on: d(-5) });
else await api('post', '/project-milestones', { project_id: gfProject, name: 'Draft report', target_date: d(-7), reached_on: d(-5) });

// Vantage: 100% on delivery, work under way.
// Vantage: a PO that came in this month, 100% on delivery.
await register(Q.va, { po_number: '7100045566', po_date: d(-4), payment_terms_days: 60, project_manager: 'Ritu Sharma', project_manager_email: 'ritu.sharma@demo.example.com', planned_start_date: d(-2), planned_delivery_date: d(10),
  stages: [{ stage_name: 'On delivery (100%)', trigger_event: 'On Delivery', percent: 100 }] });

// Nordlicht (EUR): 50/50, advance invoiced, paid yesterday.
await register(Q.nm, { po_number: 'NM-2026-118', po_date: d(-20), payment_terms_days: 45, project_manager: 'Kabir Singh', project_manager_email: 'kabir.singh@demo.example.com', planned_delivery_date: d(30),
  stages: [{ stage_name: 'Advance (50%)', trigger_event: 'On PO Registration', percent: 50 }, { stage_name: 'On delivery (50%)', trigger_event: 'On Delivery', percent: 50 }] });
st = await stagesOf('NM-2026-118');
await invoice(st[0], d(-18));
await pay(st[0], st[0].amount, d(-1));
console.log('✓ 5 POs with stages, invoices and payments (one overdue, one to raise, one paid yesterday)');

// ---------------------------------------------------------------- visits, tasks, travel, renewal
const projectOf = async (po) => (await one('SELECT project_id FROM purchase_orders WHERE po_number = $1', [po])).project_id;
const visit = (body) => api('post', '/visits', body);
await visit({ project_id: await projectOf('NWP/PO/2026/0412'), po_number: 'NWP/PO/2026/0412', type: 'assessment', title: 'EcoVadis site assessment', starts_at: wd(-20), ends_at: wd(-20), city: 'Pune', state: 'Maharashtra', status: 'done', assignees: [{ staff_id: staff['Kabir Singh'], role: 'lead' }] });
await visit({ project_id: await projectOf('7100045566'), po_number: '7100045566', type: 'audit', title: 'ISO 14001 stage 2 audit', starts_at: wd(2), ends_at: wd(2), city: 'Chennai', state: 'Tamil Nadu', status: 'confirmed', assignees: [{ staff_id: staff['Ritu Sharma'], role: 'lead' }, { staff_id: staff['Vikram Rao'], role: 'member' }] });
await visit({ project_id: gfProject, po_number: 'GAF/WO/2026/77', type: 'meeting', title: 'Draft report review with the EHS team', starts_at: wd(6), ends_at: wd(6), city: 'Indore', state: 'Madhya Pradesh', status: 'planned', assignees: [{ staff_id: staff['Ananya Iyer'], role: 'lead' }] });

const task = (body) => api('post', '/tasks', { status: 'todo', priority: 'normal', created_by: 'Demo', ...body });
await task({ entity: 'quotation', entity_id: Q.sc.quotation_no, title: 'Call Kavita about the EcoVadis proposal', type: 'call', due_at: d(-2), assignee: 'Neha Kapoor', priority: 'high' });
await task({ entity: 'quotation', entity_id: Q.cw.quotation_no, title: 'Send the revised CBAM scope', type: 'email', due_at: d(0), assignee: 'Arjun Mehta' });
await task({ entity: 'quotation', entity_id: Q.sl.quotation_no, title: 'Collect the PO from Silverline purchase', type: 'follow_up', due_at: d(1), assignee: 'Neha Kapoor' });
await task({ entity: 'purchase_order', entity_id: '4500088123', title: 'Chase the Bluepeak advance payment', type: 'call', due_at: d(-1), assignee: 'Arjun Mehta', priority: 'high' });

await api('post', '/travel-logs', { travel_id: 'TL-2026-001', po_number: '7100045566', service_delivered: 'ISO audits', employee_name: 'Ritu Sharma', employee_email: 'ritu.sharma@demo.example.com', purpose: 'ISO 14001 stage 2 audit', destination: 'Chennai', travel_start_date: d(2), travel_end_date: d(3), arranged_by: 'HR', hr_owner: 'HR desk' });
await api('post', '/travel-logs', { travel_id: 'TL-2026-002', po_number: 'NWP/PO/2026/0412', service_delivered: 'Ecovadis Assessment (consulting)', employee_name: 'Kabir Singh', employee_email: 'kabir.singh@demo.example.com', purpose: 'EcoVadis site assessment', destination: 'Pune', travel_start_date: d(-20), travel_end_date: d(-19), arranged_by: 'HR', hr_owner: 'HR desk' });
await api('post', '/vendor-invoices', { vendor_invoice_id: 'VI-2026-001', travel_id: 'TL-2026-002', vendor_invoice_no: 'SKY/2026/551', invoice_date: d(-17), invoice_amount: 18400, payment_terms_days: 30 });
await api('post', '/expense-claims', { claim_id: 'EC-2026-001', travel_id: 'TL-2026-002', expense_category: 'Local transport / cab', claim_month: d(-19).slice(0, 7), amount_claimed: 2350, submission_date: d(-15) });

await api('post', '/engagements', { client_name: co.nw.name, service_name: 'Ecovadis Assessment (consulting)', valid_until: d(310), next_due_on: d(40), status: 'active', owner: 'Neha Kapoor', notes: 'Annual EcoVadis reassessment (demo).' }).catch((err) => console.warn('  (renewal not added:', err.message, ')'));
console.log('✓ visits, tasks, travel, an expense claim and a renewal');

// ---------------------------------------------------------------- a demo inbox
// A shared test mailbox with a few client conversations about the deals above, so the Inbox
// and each record's email show something. The readers are off while it syncs: no AI call,
// no record made from it. Every address is on example.com.
await db.query(`UPDATE settings SET value = 'false' WHERE key IN ('auto_enquiries_enabled', 'auto_po_enabled', 'auto_invoice_enabled')`);
const box = await api('post', '/mailboxes/test', { email: 'sales@demo.example.com', shared: true, display_name: 'Sales (demo)' });
await api('patch', `/mailboxes/${box.id}`, { visibility: 'share_everything', import_days: 60 });
// The team inbox the Inbox page triages: new client mail lands there, assigned to the client's owner.
await api('post', '/inbox/inboxes', { name: 'Sales', account_id: box.id, default_assignment: 'owner_of_company', members: SALES.map((s) => s.name), first_response_hours: 24 });
const at = (n, hour = 10) => new Date(Date.parse(`${d(n)}T00:00:00+05:30`) + hour * 3600e3).toISOString();
let seq = 0;
const mail = (conv, { from, to, subject, body, when, out = false }) => {
  seq += 1;
  return {
    provider_id: `demo-${seq}`, conversation_id: conv, internet_message_id: `<demo-${seq}@demo.example.com>`, folder: out ? 'sentitems' : 'inbox',
    from: { email: from.email, name: from.name }, to: to.map((t) => ({ email: t.email, name: t.name })), cc: [],
    subject, body_html: `<p>${body.split('\n').join('</p><p>')}</p>`, sent_at: when, has_attachments: false,
  };
};
const us = { email: 'sales@demo.example.com', name: 'Neha Kapoor' };
const them = (k) => ({ email: co[k].email, name: co[k].contact[0] });
const msgs = [
  mail('demo-sc', { from: them('sc'), to: [us], subject: `Re: ${Q.sc.quotation_no} EcoVadis proposal`, body: 'Dear Neha,\nThanks for the proposal. Our board meets next week; could you share two references from the ceramics sector?\nRegards,\nKavita', when: at(-9, 11) }),
  mail('demo-sc', { from: us, to: [them('sc')], subject: `Re: ${Q.sc.quotation_no} EcoVadis proposal`, body: 'Dear Kavita,\nCertainly, I will send two references by Friday.\nBest regards,\nNeha', when: at(-9, 15), out: true }),
  mail('demo-cw', { from: them('cw'), to: [us], subject: `${Q.cw.quotation_no}: CBAM scope for our EU exports`, body: 'Hello,\nWe would like the scope to cover all three plants. Please revise the quotation.\nAditya', when: at(-6, 10) }),
  mail('demo-sl', { from: them('sl'), to: [us], subject: `${Q.sl.quotation_no} PSCI audits: approval received`, body: 'Hi Neha,\nManagement has approved the PSCI audits. Purchase will issue the PO this week.\nFarah', when: at(-5, 12) }),
  mail('demo-bp', { from: us, to: [them('bp')], subject: 'Reminder: advance payment for PO 4500088123', body: 'Dear Rohan,\nA gentle reminder that the advance invoice for PO 4500088123 is past its due date. Could you share the payment status?\nRegards,\nArjun', when: at(-2, 10), out: true }),
  mail('demo-eh', { from: them('eh'), to: [us], subject: 'Sustainability report for our resorts', body: 'Dear team,\nWe are planning our first sustainability report for FY 2026-27 and would like a proposal covering our four resorts.\nLakshmi Menon', when: at(-6, 9) }),
  mail('demo-va', { from: them('va'), to: [us], subject: 'GHG report preparation: enquiry', body: 'Hello,\nFollowing the ISO audit, we would also like help with our GHG inventory. Please call me.\nSanjay', when: at(-1, 16) }),
];
const { pushTestMessages, syncAccount } = await import('../src/lib/mailbox/sync.js');
pushTestMessages(box.id, msgs);
await syncAccount(box.id);
// The readers stay off in the demo: nothing in it makes AI calls or records by itself while it is shown.
console.log(`✓ a demo inbox: ${msgs.length} emails in sales@demo.example.com`);

const counts = await one(`SELECT (SELECT count(*) FROM companies)::int AS companies, (SELECT count(*) FROM enquiries)::int AS enquiries,
  (SELECT count(*) FROM quotations)::int AS quotations, (SELECT count(*) FROM purchase_orders)::int AS pos, (SELECT count(*) FROM payment_stages)::int AS stages,
  (SELECT count(*) FROM payments)::int AS payments, (SELECT count(*) FROM visits)::int AS visits, (SELECT count(*) FROM tasks)::int AS tasks`);
console.log('✓ demo data:', counts);
const { pool } = await import('../src/db.js');
await pool.end().catch(() => {});
await db.end();
process.exit(0);
