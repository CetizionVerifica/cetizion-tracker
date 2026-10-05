#!/usr/bin/env node
/**
 * The live model over the sample documents (docs/email-po-invoice-prompt-plan.md §7),
 * run by hand before turning automatic registration back on:
 *
 *   npm run readers:accuracy
 *   npm run eval:email-docs -- --model anthropic/claude-opus-5.5
 *
 * Each fixture in test/fixtures/email-docs is read once, with the prompt the
 * reader sends (one AI call each, on the configured OpenRouter model), and
 * the answer is scored field by field against the fixture's recorded answer;
 * then the checks run on it, as the reader would. Nothing is written
 * anywhere. Needs OPENROUTER_API_KEY.
 *
 * docs/email-auto-entry-plan.md §5: a fixture with a "pdf" file beside it
 * is sent as the PDF itself to a model that reads PDFs, as the reader does;
 * an "image" fixture is checked with nothing to find its amounts in. A
 * model switch needs every KEY field right on every fixture: the script
 * exits 1 otherwise. --model reads with that model alone.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/config.js';
import { aiConfig, chatJSON, readsPdf } from '../src/lib/ai.js';
import { PO_SCHEMA, buildPoPrompt, parsePoVerdict } from '../src/lib/mailbox/poDetect.js';
import { checkPo } from '../src/lib/mailbox/pdfPurchaseOrder.js';
import { INVOICE_SCHEMA, buildInvoicePrompt, checkInvoice, parseInvoiceVerdict } from '../src/lib/mailbox/invoiceDetect.js';
import { near } from '../src/lib/mailbox/pdfQuotation.js';
import { DOCUMENT_MAX_TOKENS, DOCUMENT_TIMEOUT_MS, OCR_TIMEOUT_MS } from '../src/lib/mailbox/readLimits.js';
import { loadFixtures, readerParties } from '../test/fixtures/email-docs/fixtures.mjs';

const FIELDS = {
  po: ['po_number', 'po_date', 'revision_marks', 'our_quotation_ref', 'client_reference', 'vendor.gstin', 'buyer.contact_name', 'lines.length',
    'basic_value', 'tax_value', 'total_value', 'tax_breakup.igst', 'tax_breakup.cgst', 'tax_breakup.sgst', 'payment_terms_text', 'credit_days', 'remarks'],
  invoice: ['invoice_no', 'invoice_date', 'seller.gstin', 'po_reference', 'po_date', 'taxable_value', 'tax_value', 'total_value', 'tax_breakup.igst',
    'tax_breakup.cgst', 'tax_breakup.sgst', 'stage_hint'],
};

/** What must be right on every document before a model reads for real (§5). */
const KEY = ['po_number', 'po_date', 'invoice_no', 'invoice_date', 'po_reference', 'basic_value', 'taxable_value', 'total_value', 'vendor.gstin', 'seller.gstin'];
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'email-docs');
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };

const get = (o, path) => path.split('.').reduce((x, k) => (x === null || x === undefined ? null : k === 'length' ? x.length : x[k]), o) ?? null;
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
function same(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') return near(a, b);
  return words(a) === words(b);
}

async function main() {
  if (!aiConfig.enabled) {
    console.error('No AI key: set OPENROUTER_API_KEY to score the live model.');
    process.exit(1);
  }
  const model = arg('model');
  console.log(`Reading with ${model || aiConfig.model}${model ? '' : ` (then ${aiConfig.fallbacks.join(', ')})`}.`);
  const parties = readerParties();
  const tally = {};
  let checked = 0;
  for (const f of loadFixtures()) {
    const { system, user } = f.kind === 'po'
      ? buildPoPrompt({ pdfText: f.text, emailSubject: f.email.subject, emailText: '', receivedAt: f.email.sent_at, from: { email: f.email.from }, ...parties })
      : buildInvoicePrompt({ pdfText: f.text, emailSubject: f.email.subject, emailText: '', sentAt: f.email.sent_at, to: [{ email: f.email.to }], ...parties });
    const parse = f.kind === 'po' ? parsePoVerdict : parseInvoiceVerdict;
    const pdf = f.pdf && existsSync(join(FIXTURES, f.pdf)) && readsPdf(model || aiConfig.model) ? readFileSync(join(FIXTURES, f.pdf)) : null;
    const opts = { title: 'Cetizion Tracker reader accuracy', maxTokens: DOCUMENT_MAX_TOKENS, schema: f.kind === 'po' ? PO_SCHEMA : INVOICE_SCHEMA, ...(model ? { model } : {}) };
    let live;
    try {
      live = parse(pdf
        ? await chatJSON(system, [{ type: 'text', text: user }, { type: 'file', file: { filename: f.pdf, file_data: `data:application/pdf;base64,${pdf.toString('base64')}` } }],
          { ...opts, timeoutMs: OCR_TIMEOUT_MS, plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }] })
        : await chatJSON(system, user, { ...opts, timeoutMs: DOCUMENT_TIMEOUT_MS }));
    } catch (err) {
      console.log(`\n${f.name}: the call failed (${err.message})`);
      continue;
    }
    const want = parse(f.answer);
    const wrong = [];
    for (const field of FIELDS[f.kind]) {
      tally[field] ??= { right: 0, of: 0 };
      tally[field].of += 1;
      if (same(get(live, field), get(want, field))) tally[field].right += 1;
      else wrong.push(`  ${field}: read ${JSON.stringify(get(live, field))}, expected ${JSON.stringify(get(want, field))}`);
    }
    const r = f.kind === 'po'
      ? checkPo(live, { emailDate: f.email.sent_at, sourceText: f.image ? null : f.text, ...parties })
      : checkInvoice(live, { emailDate: f.email.sent_at, sourceText: f.image ? null : f.text, ...parties });
    const passed = r.ok === f.expect.ok;
    if (passed) checked += 1;
    console.log(`\n${f.name}: checks ${r.ok ? 'pass' : `refuse (${r.reason})`}${passed ? '' : `, expected ${f.expect.ok ? 'a pass' : 'a refusal'}`}`);
    console.log(wrong.length ? wrong.join('\n') : '  every field as expected');
  }
  console.log('\nAccuracy per field');
  for (const [field, t] of Object.entries(tally)) console.log(`  ${field.padEnd(22)} ${t.right}/${t.of}`);
  const all = Object.values(tally).reduce((n, t) => ({ right: n.right + t.right, of: n.of + t.of }), { right: 0, of: 0 });
  console.log(`  ${'all fields'.padEnd(22)} ${all.right}/${all.of} (${all.of ? Math.round((all.right / all.of) * 100) : 0}%)`);
  console.log(`  ${'checks as expected'.padEnd(22)} ${checked}/${loadFixtures().length}`);
  const missed = Object.entries(tally).filter(([field, t]) => KEY.includes(field) && t.right < t.of);
  if (missed.length || checked < loadFixtures().length) {
    console.log(`\nNot ready to read for real: ${missed.length ? `${missed.map(([f]) => f).join(', ')} not right on every document` : 'a check came out otherwise than expected'}.`);
    process.exitCode = 1;
  } else console.log('\nEvery key field right on every document.');
}

main().catch((err) => { console.error(err); process.exit(1); });
