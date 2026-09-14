import { ApiError } from '../middleware/error.js';

const WON = 'Won - PO Received';

/**
 * A purchase order counts, in revenue, towards the won quotation it names.
 * That quotation must be a won one on the PO's own project. A new PO saved
 * without one is linked automatically when its project has exactly one won
 * quotation; otherwise it stays unlinked until someone picks the quotation,
 * and the revenue report flags it.
 */
export async function linkPurchaseOrder(client, { before, after }) {
  if (after.quotation_no) {
    // Forms send every field back, so an unchanged link arrives on every
    // edit. Its quotation may since have moved project or stopped being won;
    // that must not block saving a delivery date. Only a new or re-pointed
    // link is checked.
    if (before && before.quotation_no === after.quotation_no && before.project_id === after.project_id) return;
    const { rows } = await client.query(
      'SELECT project_id, status FROM quotations WHERE quotation_no = $1',
      [after.quotation_no]
    );
    if (!rows.length || rows[0].project_id !== after.project_id || rows[0].status !== WON) {
      throw new ApiError(422, 'Please check the highlighted fields', {
        fields: { quotation_no: `Pick a won quotation of project ${after.project_id}` },
      });
    }
    return;
  }

  // Only a new PO is linked for you; clearing the link on an existing one is left alone.
  if (before) return;
  const { rows } = await client.query(
    'SELECT quotation_no FROM quotations WHERE project_id = $1 AND status = $2',
    [after.project_id, WON]
  );
  if (rows.length === 1) {
    await client.query('UPDATE purchase_orders SET quotation_no = $1 WHERE id = $2', [rows[0].quotation_no, after.id]);
  }
}
