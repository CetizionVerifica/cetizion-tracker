import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { loadFixtures, readerParties } from './fixtures/email-docs/fixtures.mjs';
import { parsePoVerdict } from '../src/lib/mailbox/poDetect.js';
import { checkPo, stagesFromTerms } from '../src/lib/mailbox/pdfPurchaseOrder.js';
import { checkInvoice, parseInvoiceVerdict, splitFor } from '../src/lib/mailbox/invoiceDetect.js';

/**
 * The sample documents of docs/email-po-invoice-prompt-plan.md §7, offline:
 * each fixture's recorded answer through the same parse and checks the
 * readers use, and what the plan pins for it. No AI, no database.
 */

const parties = readerParties();

describe('the sample documents, through the checks', () => {
  for (const f of loadFixtures()) {
    test(`${f.name}: ${f.pins}`, () => {
      if (f.kind === 'po') {
        const v = parsePoVerdict(f.answer);
        const r = checkPo(v, { emailDate: f.email.sent_at, sourceText: f.text, ...parties });
        assert.equal(r.ok, f.expect.ok, r.reason);
        const got = {
          po_number: r.po.po_number, addressed_gstin: r.po.addressed_gstin, partner_name: r.po.partner_name, our_quotation_ref: r.po.our_quotation_ref,
          client_reference: r.po.client_reference, total_value: r.po.total_value, tax_value: r.po.tax_value, credit_days: r.po.credit_days,
          lines: r.po.lines.length, contact_name: r.po.buyer?.contact_name, remarks: r.po.remarks,
        };
        for (const [k, want] of Object.entries(f.expect.fields)) assert.deepEqual(got[k], want, k);
        const terms = stagesFromTerms(v.payment_terms_text);
        if (f.expect.stages === null) assert.equal(terms.source, 'template', 'the terms name no stages: the template applies');
        else assert.deepEqual(terms.stages.map((s) => [s.trigger_event, s.percent]), f.expect.stages);
        return;
      }
      const v = parseInvoiceVerdict(f.answer);
      // An image PDF has nothing to check its amounts against: the reader reads it twice instead (docs/email-auto-entry-plan.md §3.7).
      const r = checkInvoice(v, { emailDate: f.email.sent_at, sourceText: f.image ? null : f.text, ...parties });
      assert.equal(r.ok, f.expect.ok, r.reason);
      for (const [k, want] of Object.entries(f.expect.fields)) assert.deepEqual(r.invoice[k], want, k);
      if (f.expect.split) {
        const s = splitFor([f.expect.split.po_stage], r.invoice);
        assert.deepEqual([s?.percent, s?.stage_name], [f.expect.split.percent, f.expect.split.stage_name]);
      }
    });
  }

  test('every sample is here', () => {
    assert.deepEqual(loadFixtures().map((f) => f.file).sort(), ['alembic-po.json', 'aragen-po.json', 'dasami-work-order.json', 'hindalco-po.json', 'invoice-cvpl-2026-27-037.json', 'invoice-cvpl-2026-27-074.json']);
  });
});
