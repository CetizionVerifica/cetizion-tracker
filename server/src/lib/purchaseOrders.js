import { ApiError } from '../middleware/error.js';

const WON = 'Won - PO Received';

/**
 * The warning for a PO whose currency differs from the quotation it fulfils,
 * or null when they agree. Only the currency is compared, never the amount:
 * a quotation billed 50/50 or 30/70 has POs worth part of it, and that is
 * normal. A different currency is allowed — a client can order in another
 * one — but it is usually the currency dropdown left at its INR default, and
 * then every report reads the amount as rupees.
 */
export function currencyMismatch(poCurrency, quotation) {
  if (!quotation?.currency || !poCurrency || poCurrency === quotation.currency) return null;
  return `Quotation ${quotation.quotation_no} is in ${quotation.currency}, but this PO is in ${poCurrency}. ` +
    'Check the currency: the reports convert the PO value from the currency saved here.';
}

const replacesError = (message) =>
  new ApiError(422, 'Please check the highlighted fields', { fields: { replaces_po_number: message } });

/**
 * A revision names the PO it takes the place of. That PO must be another one
 * on the same project, not already replaced by a different revision, and not
 * one that — following its own "replaces" back — leads to this PO again,
 * which would leave neither counted. Only a new or changed link is checked,
 * like the quotation link below.
 */
async function checkReplaces(client, { before, after }) {
  const target = after.replaces_po_number;
  if (!target || (before && before.replaces_po_number === target && before.project_id === after.project_id)) return;
  if (target === after.po_number) throw replacesError('A purchase order cannot replace itself');

  const { rows: [replaced] } = await client.query(
    'SELECT po_number, project_id FROM purchase_orders WHERE po_number = $1',
    [target]
  );
  if (!replaced) throw replacesError(`There is no purchase order ${target}`);
  if (replaced.project_id !== after.project_id) {
    throw replacesError(`${target} is on project ${replaced.project_id}: pick a purchase order of project ${after.project_id}`);
  }
  const { rows: [other] } = await client.query(
    'SELECT po_number FROM purchase_orders WHERE replaces_po_number = $1 AND po_number <> $2',
    [target, after.po_number]
  );
  if (other) throw replacesError(`${target} is already replaced by ${other.po_number}: pick ${other.po_number} instead`);

  // Walk back from the target; reaching this PO means a loop.
  let current = target;
  for (let hops = 0; current && hops < 100; hops += 1) {
    const { rows: [row] } = await client.query('SELECT replaces_po_number FROM purchase_orders WHERE po_number = $1', [current]);
    current = row?.replaces_po_number;
    if (current === after.po_number) throw replacesError(`${target} already leads back to this purchase order`);
  }
}

/**
 * A purchase order counts, in revenue, towards the won quotation it names.
 * That quotation must be a won one on the PO's own project. A new PO saved
 * without one is linked automatically when its project has exactly one won
 * quotation; otherwise it stays unlinked until someone picks the quotation,
 * and the revenue report flags it.
 *
 * Returns { save_warning } when the PO's currency differs from its
 * quotation's. The save still goes through; the form shows the warning.
 */
export async function linkPurchaseOrder(client, { before, after }) {
  await checkReplaces(client, { before, after });

  let quotationNo = after.quotation_no;
  if (quotationNo) {
    // Forms send every field back, so an unchanged link arrives on every
    // edit. Its quotation may since have moved project or stopped being won;
    // that must not block saving a delivery date. Only a new or re-pointed
    // link is checked.
    const unchanged = before && before.quotation_no === after.quotation_no && before.project_id === after.project_id;
    if (!unchanged) {
      const { rows } = await client.query(
        'SELECT project_id, status FROM quotations WHERE quotation_no = $1',
        [after.quotation_no]
      );
      if (!rows.length || rows[0].project_id !== after.project_id || rows[0].status !== WON) {
        throw new ApiError(422, 'Please check the highlighted fields', {
          fields: { quotation_no: `Pick a won quotation of project ${after.project_id}` },
        });
      }
    }
  } else if (!before) {
    // Only a new PO is linked for you; clearing the link on an existing one is left alone.
    const { rows } = await client.query(
      'SELECT quotation_no FROM quotations WHERE project_id = $1 AND status = $2',
      [after.project_id, WON]
    );
    if (rows.length === 1) {
      quotationNo = rows[0].quotation_no;
      await client.query('UPDATE purchase_orders SET quotation_no = $1 WHERE id = $2', [quotationNo, after.id]);
    }
  }

  // Checked on every save, not only when the link changes: the currency is
  // the field most likely to be edited on its own.
  if (!quotationNo) return undefined;
  const { rows: [quotation] } = await client.query(
    'SELECT quotation_no, currency FROM quotations WHERE quotation_no = $1',
    [quotationNo]
  );
  const warning = currencyMismatch(after.currency, quotation);
  return warning ? { save_warning: warning } : undefined;
}
