#!/usr/bin/env node
/**
 * Apply a sales-sheet import spec to a running tracker through its API.
 *
 *   TRACKER_URL=https://tracker.example.com \
 *   TRACKER_USERNAME=admin TRACKER_PASSWORD='...' \
 *   node scripts/import-sales-sheet.js import/sales-sheet-2026-09.json --start-no 79 --dry-run
 *
 * Then the same command with --apply.  Every record goes through the normal
 * API, so it is validated exactly like a form entry; nothing is written
 * directly to the database.  For each deal the script:
 *
 *   1. creates the quotation, numbered CTZ/QT/<year>/<nnn> from --start-no
 *      upward, skipping numbers the target already uses.  A deal whose
 *      client + service already exists on the target is skipped entirely,
 *      unless --extend-existing is given, in which case steps 2-3 still run
 *      against the existing quotation;
 *   2. if the spec has a PO: converts the quotation into a project (next
 *      free project ID on the target), registers the PO (skipped if that PO
 *      number exists), and creates the payment split;
 *   3. records the invoice and receipt on the stages that have them.
 *
 * Nothing is deleted or overwritten.  Re-running is safe: existing records
 * are reported as skipped.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const specPath = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
const extendExisting = args.includes('--extend-existing');
const startArg = args[args.indexOf('--start-no') + 1];
const startNo = args.includes('--start-no') ? Number(startArg) : NaN;
if (!specPath || !Number.isInteger(startNo) || startNo < 1 || (!apply && !args.includes('--dry-run'))) {
  console.error('Usage: node scripts/import-sales-sheet.js <spec.json> --start-no <n> (--dry-run | --apply) [--extend-existing]');
  process.exit(1);
}

const BASE = (process.env.TRACKER_URL || 'http://localhost:4000').replace(/\/$/, '');
const USER = process.env.TRACKER_USERNAME || 'admin';
const PASS = process.env.TRACKER_PASSWORD;
if (!PASS) {
  console.error('Set TRACKER_PASSWORD (and TRACKER_URL, TRACKER_USERNAME) in the environment.');
  process.exit(1);
}

let cookie = '';
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const payload = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const fields = payload?.error?.fields ? ' ' + JSON.stringify(payload.error.fields) : '';
    throw new Error(`${method} ${path} -> ${res.status} ${payload?.error?.message || ''}${fields}`);
  }
  return payload?.data;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Look up by human key through the list endpoint rather than /<resource>/<key>:
// deployed builds may still misread an all-digit key such as PO 4530056073
// as an internal row id. The list search is safe on every version.
async function exists(resource, keyField, key) {
  const rows = await call(`/${resource}?q=${encodeURIComponent(key)}&limit=50`);
  return (rows || []).find((r) => String(r[keyField]) === String(key)) || null;
}

async function findQuotation(q) {
  const rows = await call(`/quotations?q=${encodeURIComponent(q.client_name)}&limit=200`);
  // Same client and either the same service text or the same proposal date:
  // the sheet and the tracker spell services differently ("LCA proposal" vs
  // "LCA", "JDD" vs "Joint Due Diligence") but agree on dates.
  return (rows || []).find(
    (r) => norm(r.client_name) === norm(q.client_name) &&
      (norm(r.service_quoted) === norm(q.service_quoted) ||
        (q.quotation_date && r.quotation_date && String(r.quotation_date).slice(0, 10) === q.quotation_date))
  );
}

// Next free quotation number at or after --start-no on the target.
const year = new Date().getFullYear();
let counter = startNo;
async function nextQuotationNo() {
  for (;;) {
    const candidate = `CTZ/QT/${year}/${String(counter).padStart(3, '0')}`;
    counter += 1;
    if (!(await exists('quotations', 'quotation_no', candidate))) return candidate;
  }
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const log = (...a) => console.log(...a);
const tally = { quotations: 0, projects: 0, pos: 0, stages: 0, invoices: 0, receipts: 0, skipped: 0 };
const failures = [];
const warnings = [];

await call('/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
log(`${apply ? 'APPLYING' : 'DRY RUN'} against ${BASE} — ${spec.deals.length} deals, numbering from ${startNo}\n`);

for (const deal of spec.deals) {
  const q = deal.quotation;
  const tag = `[S.No ${deal.sno}] ${q.client_name} — ${q.service_quoted}`;
  try {
    // 1. quotation
    let quotation = await findQuotation(q);
    if (quotation) {
      log(`${tag}\n   skip quotation: already present as ${quotation.quotation_no} (${quotation.status})`);
      tally.skipped += 1;
      if (!extendExisting) continue;
    } else {
      const quotation_no = await nextQuotationNo();
      log(`${tag}\n   create quotation ${quotation_no} ${q.currency} ${q.quotation_value ?? '—'} dated ${q.quotation_date ?? '—'}`);
      if (apply) quotation = await call('/quotations', { method: 'POST', body: { ...q, quotation_no } });
      tally.quotations += 1;
    }

    const po = deal.purchase_order;
    if (!po) continue;

    // 2. project (via convert) + PO
    let projectId = quotation?.project_id || null;
    if (!projectId) {
      const next = await call('/lookups/next-id/project');
      projectId = next.next;
      log(`   register project ${projectId} from the quotation`);
      if (apply) {
        const r = await call(`/quotations/${quotation.id}/convert`, {
          method: 'POST', body: { project_id: projectId, apply_onboarding_template: false },
        });
        projectId = r.project.project_id;
      }
      tally.projects += 1;
    } else {
      log(`   project already linked: ${projectId}`);
    }

    if (await exists('purchase-orders', 'po_number', po.po_number)) {
      log(`   skip PO ${po.po_number}: already present`);
      tally.skipped += 1;
      continue;
    }
    log(`   register PO ${po.po_number} ${po.currency} ${po.po_value} dated ${po.po_date ?? '—'}`);
    if (apply) await call('/purchase-orders', { method: 'POST', body: { ...po, project_id: projectId } });
    tally.pos += 1;

    // 3. payment split, then invoice + receipt on the stages that have them
    if (!deal.stages?.length) continue;
    const split = deal.stages.map(({ stage_name, trigger_event, stage_percent }) => ({ stage_name, trigger_event, stage_percent }));
    log(`   payment split ${split.map((s) => `${s.stage_name} [${s.trigger_event}]`).join(' / ')}`);
    let created = [];
    if (apply) created = await call(`/purchase-orders/${encodeURIComponent(po.po_number)}/stages`, { method: 'POST', body: { stages: split } });
    tally.stages += split.length;

    for (const [i, stage] of deal.stages.entries()) {
      if (stage.invoice && !stage.invoice.invoice_date) {
        log(`   WARNING: invoice ${stage.invoice.invoice_no} has no date in the sheet — not recorded; enter it by hand`);
        warnings.push(`[S.No ${deal.sno}] ${q.client_name}: invoice ${stage.invoice.invoice_no} needs a date`);
      } else if (stage.invoice) {
        log(`   invoice ${stage.invoice.invoice_no} dated ${stage.invoice.invoice_date} on stage ${i + 1}`);
        tally.invoices += 1;
        if (apply) await call(`/payment-stages/${created[i].id}/invoice`, { method: 'POST', body: stage.invoice });
      }
      if (stage.receipt) {
        log(`   receipt ${po.currency} ${stage.receipt.amount_received} on stage ${i + 1}`);
        tally.receipts += 1;
        if (apply) await call(`/payment-stages/${created[i].id}/payment`, { method: 'POST', body: { ...stage.receipt, mode: 'set' } });
      }
    }
  } catch (err) {
    log(`   FAILED: ${err.message}`);
    failures.push({ sno: deal.sno, client: q.client_name, error: err.message });
  }
}

log('\nSummary');
for (const [k, v] of Object.entries(tally)) log(`  ${k.padEnd(11)} ${v}`);
if (failures.length) {
  log(`\n${failures.length} deal(s) FAILED — fix and re-run; completed steps are skipped next time:`);
  for (const f of failures) log(`  [S.No ${f.sno}] ${f.client}: ${f.error}`);
}
if (warnings.length) {
  log('\nEnter by hand afterwards:');
  for (const w of warnings) log(`  ${w}`);
}
if (!apply) log('\nNothing was written. Re-run with --apply to make these changes.');
if (spec.review?.length) {
  log(`\n${spec.review.length} deal(s) were flagged for review in the spec:`);
  for (const r of spec.review) log(`  [S.No ${r.sno}] ${r.client} — ${r.proposal}: ${r.notes.join('; ')}`);
}
process.exit(failures.length ? 2 : 0);
