import { query } from '../../db.js';
import { splitInclusive } from './gst.js';

/**
 * The GST inside a payment stage's amount, the one way the accounting module
 * works it out (#48): the invoice draft, GSTR-1 and the GST summary, and
 * reconciliation with the books all use this, so they cannot drift apart.
 *
 * A stage amount INCLUDES GST: it is a share of the PO value, which is the
 * quotation's total grossed up at the quotation's own rates. The client
 * portal takes the same GST out in SQL (views.sql, po_gst_split), from the
 * same lines, found the same way:
 *   1. the PO's own quotation, else the won quotations of its project when
 *      the PO names none;
 *   2. no lines at all: the gst_rate_default setting, marked estimated;
 *   3. a PO in another currency (an export): no GST.
 * The two agree to the paisa, because po_gst_split's effective rate over a
 * mix of rates gives the same taxable value as splitting per rate.
 */

/**
 * SQL for a json array of {rate, amount} (pre-tax line amounts per GST
 * rate), for the purchase order aliased `po` in the surrounding query.
 */
export const RATE_MIX_SQL = `(SELECT json_agg(m) FROM (
     SELECT COALESCE(l.gst_rate, 0) AS rate, SUM(l.amount) AS amount
       FROM quotations qt JOIN quotation_lines l ON l.quotation_id = qt.id
      WHERE (qt.quotation_no = po.quotation_no
             OR (po.quotation_no IS NULL AND qt.project_id = po.project_id AND qt.status = 'Won - PO Received'))
        AND l.amount > 0
      GROUP BY COALESCE(l.gst_rate, 0)) m)`;

/** The gst_rate_default setting, else 18. */
export async function defaultGstRate(db = { query }) {
  const { rows: [r] } = await db.query(`SELECT value FROM settings WHERE key = 'gst_rate_default'`);
  const n = Number(r?.value);
  return Number.isFinite(n) && n >= 0 && String(r?.value ?? '').trim() !== '' ? n : 18;
}

const paisa = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Split one stage. `stage` needs stage_amount, currency and rate_mix (from
 * RATE_MIX_SQL).
 *
 * @returns {{ parts: {rate, total, taxable, gst}[], taxable, gst, rate, estimated, exported }}
 *   `rate` is the single GST rate, or null when the invoice mixes rates:
 *   an average of them is not a rate an invoice may carry.
 */
export function stageGst(stage, fallbackRate = 18) {
  const exported = (stage.currency || 'INR') !== 'INR';
  const mix = exported ? [] : (stage.rate_mix || []);
  const estimated = !exported && !mix.some((m) => Number(m.amount) > 0);
  const parts = splitInclusive(stage.stage_amount, mix, exported ? 0 : fallbackRate);
  return {
    parts,
    taxable: paisa(parts.reduce((n, p) => n + p.taxable, 0)),
    gst: paisa(parts.reduce((n, p) => n + p.gst, 0)),
    rate: parts.length === 1 ? parts[0].rate : null,
    estimated,
    exported,
  };
}
