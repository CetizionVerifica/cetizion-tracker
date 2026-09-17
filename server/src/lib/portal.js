/**
 * What a client may see in the portal (#47). Every query here is scoped to
 * one company id taken from the portal session, never from the request.
 * Internal fields (notes, owners, margins, costs, probabilities, tasks) are
 * simply never selected.
 */
import pdfmake from './pdf.js';
import { query } from '../db.js';
import { money as formatMoney } from './reportFormat.js';

const money = (n, currency = 'INR') => formatMoney(n, currency, { decimals: 2 });

export const SECTIONS = ['projects', 'documents', 'invoices', 'certificates', 'contact'];

export async function portalProjects(companyId) {
  const { rows: projects } = await query(
    `SELECT p.project_id, p.primary_service, p.planned_start_date, p.planned_delivery_date, p.project_stage,
            p.actual_initiation_date, p.actual_delivery_date, p.onboarding_done, p.onboarding_total
       FROM v_projects p WHERE p.company_id = $1 ORDER BY p.project_id DESC`, [companyId]);
  const { rows: visits } = await query(
    `SELECT v.project_id, v.type, v.title, v.starts_at, v.ends_at, v.all_day, v.city, v.status
       FROM visits v JOIN projects p ON p.project_id = v.project_id
      WHERE p.company_id = $1 AND v.status IN ('planned','confirmed') AND v.ends_at >= now() ORDER BY v.starts_at`, [companyId]);
  const { rows: steps } = await query(
    `SELECT o.project_id, o.step, o.completed_date IS NOT NULL AS done FROM onboarding_tasks o JOIN projects p ON p.project_id = o.project_id
      WHERE p.company_id = $1 ORDER BY o.project_id, o.id`, [companyId]);
  return projects.map((p) => ({ ...p, visits: visits.filter((v) => v.project_id === p.project_id), checklist: steps.filter((s) => s.project_id === p.project_id).map(({ step, done }) => ({ step, done })) }));
}

export async function portalInvoices(companyId) {
  const { rows } = await query(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.invoice_due_date, s.po_number, s.stage_name, s.currency,
            s.stage_amount AS amount, s.amount_received AS received,
            GREATEST(s.stage_amount - s.amount_received, 0) AS outstanding,
            CASE WHEN s.stage_status = 'Paid' THEN 'Paid' WHEN s.stage_status = 'Overdue' THEN 'Overdue' ELSE 'Due' END AS status,
            s.document_id
       FROM v_payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
      WHERE p.company_id = $1 AND s.invoice_no IS NOT NULL ORDER BY s.invoice_date DESC NULLS LAST`, [companyId]);
  return rows;
}

export async function portalDocuments(companyId) {
  const [quotations, pos, invoices, deliverables] = await Promise.all([
    query(`SELECT quotation_no, revision, quotation_date, service_quoted, COALESCE(total, quotation_value) AS amount, currency, status, document_id
             FROM quotations WHERE company_id = $1 AND (sent_at IS NOT NULL OR status IN ('Won - PO Received','Under Negotiation')) ORDER BY quotation_date DESC NULLS LAST`, [companyId]),
    query(`SELECT po.po_number, po.po_date, po.po_value AS amount, po.currency, po.document_id, po.project_id
             FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE p.company_id = $1 ORDER BY po.po_date DESC NULLS LAST`, [companyId]),
    portalInvoices(companyId),
    query(`SELECT id, type, reference, title, issued_on, valid_until, status, document_id FROM deliverables
            WHERE company_id = $1 AND status IN ('issued','expired','superseded') ORDER BY issued_on DESC NULLS LAST`, [companyId]),
  ]);
  return { quotations: quotations.rows, purchase_orders: pos.rows, invoices: invoices.filter((i) => i.document_id), deliverables: deliverables.rows };
}

export async function portalCertificates(companyId) {
  const { rows } = await query(
    `SELECT d.id, d.type, d.reference, d.title, d.service_name, d.scope, d.issuing_body, d.issued_on, d.valid_from, d.valid_until, d.status,
            (d.valid_until - CURRENT_DATE) AS days_left, d.document_id, e.next_due_on AS renewal_due
       FROM deliverables d LEFT JOIN engagements e ON e.id = d.engagement_id AND e.status IN ('active','renewal_open')
      WHERE d.company_id = $1 AND d.status IN ('issued','expired') ORDER BY d.valid_until NULLS LAST`, [companyId]);
  return rows;
}

/** A stored file belongs to the company only through one of its records. */
export async function companyOwnsDocument(companyId, documentId) {
  const { rowCount } = await query(
    `SELECT 1 FROM quotations q WHERE q.document_id = $2 AND q.company_id = $1
     UNION ALL SELECT 1 FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE po.document_id = $2 AND p.company_id = $1
     UNION ALL SELECT 1 FROM payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
                WHERE s.document_id = $2 AND s.invoice_no IS NOT NULL AND p.company_id = $1
     UNION ALL SELECT 1 FROM deliverables d WHERE d.document_id = $2 AND d.company_id = $1 AND d.status <> 'draft'`, [companyId, documentId]);
  return rowCount > 0;
}

/** A statement of account: every invoice, what was received, what is open. */
export async function statementPdf(company, invoices, today) {
  const byCurrency = {};
  for (const i of invoices) byCurrency[i.currency] = (byCurrency[i.currency] || 0) + Number(i.outstanding);
  const doc = {
    pageSize: 'A4', pageMargins: [40, 40, 40, 40],
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#0f172a' },
    content: [
      { text: 'Cetizion Verifica', color: '#0f766e', bold: true, fontSize: 14 },
      { text: `Statement of account for ${company.name}`, fontSize: 12, margin: [0, 6, 0, 0] },
      { text: `As on ${today}`, color: '#64748b', margin: [0, 2, 0, 12] },
      {
        table: {
          headerRows: 1, widths: ['auto', 'auto', 'auto', '*', 'auto', 'auto', 'auto', 'auto'],
          body: [
            ['Invoice', 'Date', 'Due', 'PO / stage', 'Amount', 'Received', 'Outstanding', 'Status'].map((t) => ({ text: t, bold: true })),
            ...invoices.map((i) => [i.invoice_no, i.invoice_date || '', i.invoice_due_date || '', `${i.po_number} · ${i.stage_name}`,
              { text: money(i.amount, i.currency), alignment: 'right' }, { text: money(i.received, i.currency), alignment: 'right' },
              { text: money(i.outstanding, i.currency), alignment: 'right' }, i.status]),
          ],
        },
        layout: 'lightHorizontalLines',
      },
      { text: Object.entries(byCurrency).map(([c, v]) => `Total outstanding (${c}): ${money(v, c)}`).join('\n') || 'Nothing outstanding.', bold: true, margin: [0, 12, 0, 0] },
      { text: 'If a payment has already been made, please share the transaction reference.', color: '#64748b', margin: [0, 12, 0, 0] },
    ],
  };
  return pdfmake.createPdf(doc).getBuffer();
}
