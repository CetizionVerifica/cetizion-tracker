#!/usr/bin/env node
/**
 * The live model over the sample documents (docs/email-po-invoice-prompt-plan.md §7),
 * run by hand before turning automatic registration back on:
 *
 *   npm run readers:accuracy
 *
 * Each fixture in test/fixtures/email-docs is read once, with the prompt the
 * reader sends (one AI call each, on the configured OpenRouter model), and
 * the answer is scored field by field against the fixture's recorded answer;
 * then the checks run on it, as the reader would. Nothing is written
 * anywhere. Needs OPENROUTER_API_KEY.
 */
import '../src/config.js';
import { aiConfig, chatJSON } from '../src/lib/ai.js';
import { buildPoPrompt, parsePoVerdict } from '../src/lib/mailbox/poDetect.js';
import { checkPo } from '../src/lib/mailbox/pdfPurchaseOrder.js';
import { buildInvoicePrompt, checkInvoice, parseInvoiceVerdict } from '../src/lib/mailbox/invoiceDetect.js';
import { near } from '../src/lib/mailbox/pdfQuotation.js';
import { DOCUMENT_MAX_TOKENS, DOCUMENT_TIMEOUT_MS } from '../src/lib/mailbox/readLimits.js';
import { loadFixtures, readerParties } from '../test/fixtures/email-docs/fixtures.mjs';

const FIELDS = {
  po: ['po_number', 'po_date', 'revision_marks', 'our_quotation_ref', 'client_reference', 'vendor.gstin', 'buyer.contact_name', 'lines.length',
    'basic_value', 'tax_value', 'total_value', 'tax_breakup.igst', 'tax_breakup.cgst', 'tax_breakup.sgst', 'payment_terms_text', 'credit_days', 'remarks'],
  invoice: ['invoice_no', 'invoice_date', 'seller.gstin', 'po_reference', 'po_date', 'taxable_value', 'tax_value', 'total_value', 'tax_breakup.igst',
    'tax_breakup.cgst', 'tax_breakup.sgst', 'stage_hint'],
};

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
  const parties = readerParties();
  const tally = {};
  let checked = 0;
  for (const f of loadFixtures()) {
    const { system, user } = f.kind === 'po'
      ? buildPoPrompt({ pdfText: f.text, emailSubject: f.email.subject, emailText: '', receivedAt: f.email.sent_at, from: { email: f.email.from }, ...parties })
      : buildInvoicePrompt({ pdfText: f.text, emailSubject: f.email.subject, emailText: '', sentAt: f.email.sent_at, to: [{ email: f.email.to }], ...parties });
    const parse = f.kind === 'po' ? parsePoVerdict : parseInvoiceVerdict;
    let live;
    try {
      live = parse(await chatJSON(system, user, { title: 'Cetizion Tracker reader accuracy', maxTokens: DOCUMENT_MAX_TOKENS, timeoutMs: DOCUMENT_TIMEOUT_MS }));
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
      ? checkPo(live, { emailDate: f.email.sent_at, sourceText: f.text, ...parties })
      : checkInvoice(live, { emailDate: f.email.sent_at, sourceText: f.text, ...parties });
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
}

main().catch((err) => { console.error(err); process.exit(1); });
