import { money } from './format.js';

/**
 * The PO form fields for a revised or cancelled order. A revision entered as
 * a new PO names the one it replaces; either way the old PO leaves the sales
 * figures (won POs, won value, repeat clients) but keeps its invoices and
 * payments. The server checks the link (purchaseOrders.js): same project,
 * not the PO itself, replaced once.
 *
 * projectId and poNumber fix the project and the PO being edited when the
 * form has no field of its own for them.
 */
export function poRevisionFields(purchaseOrders, { projectId, poNumber } = {}) {
  return [
    {
      name: 'replaces_po_number',
      label: 'Replaces PO',
      type: 'select',
      // Same project, not this PO, and not one another revision already
      // replaces — unless it is the one this PO replaces, so an edit shows it.
      options: (values) => purchaseOrders
        .filter((p) => p.project_id === (projectId ?? values.project_id) && p.po_number !== (poNumber ?? values.po_number))
        .filter((p) => !p.replaced_by_po_number || p.po_number === values.replaces_po_number)
        .map((p) => ({ value: p.po_number, label: `${p.po_number} — ${money(p.po_value, p.currency)}` })),
      hint: 'Only for a revised PO entered as a new one. The old PO leaves the sales figures but keeps its invoices and payments',
    },
    {
      name: 'cancelled',
      label: 'Cancelled',
      type: 'boolean',
      default: 'false',
      hint: 'A cancelled PO leaves the sales figures; its invoices and payments stay',
    },
  ];
}
