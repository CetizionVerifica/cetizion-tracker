/**
 * What a client may see in the portal (#47). Every query here is scoped to
 * one company id taken from the portal session, never from the request.
 * Internal fields (notes, owners, margins, costs, probabilities, tasks) are
 * simply never selected.
 *
 * The staff preview (#198 §5, "preview as client") calls these same
 * functions with `{ staff: true }`, so it cannot drift from what the client
 * sees; staff get one thing more, the source of each GST split, so finance
 * can see where the GST was only estimated.
 *
 * Phase 2 (#198 §4) lets the client answer: confirm an invoice, raise a
 * query, tell us they paid. Each is recorded as a claim in
 * portal_client_actions and never writes over our facts; finance matches a
 * payment advice to a receipt with the tools they already use. Files go both
 * ways: a staff file ticked "shared with client", and the client's uploads.
 */
import pdfmake from './pdf.js';
import { query } from '../db.js';
import { money as formatMoney } from './reportFormat.js';

const money = (n, currency = 'INR') => formatMoney(n, currency, { decimals: 2 });

export const SECTIONS = ['projects', 'documents', 'invoices', 'certificates', 'contact'];

/** What only staff see: where a GST split came from ('books', 'quotation', 'estimated', 'export'). */
const forClient = (rows, staff) => (staff ? rows : rows.map(({ gst_source, ...row }) => row));

// A PO the client should see as live: not cancelled, and not replaced by a
// revision that is (§3: a revised PO shows only the revision).
const LIVE_PO = `NOT po.cancelled AND NOT EXISTS (
  SELECT 1 FROM purchase_orders r WHERE r.replaces_po_number = po.po_number AND NOT r.cancelled)`;

/**
 * An invoice's state in the client's words, from the money alone: paid when
 * what was received (paid + TDS) covers the total, overdue past its due date,
 * part paid, or due. The staff stage status also weighs the stage's trigger
 * ("Not Due" until the PO date or delivery is recorded), which is no
 * concern of a client holding the invoice.
 */
const INVOICE_STATE = `CASE WHEN s.stage_amount > 0 AND s.amount_received >= s.stage_amount THEN 'Paid'
  WHEN EXISTS (SELECT 1 FROM portal_client_actions ra JOIN portal_client_action_stages rx ON rx.action_id = ra.id
                WHERE rx.stage_id = s.id AND ra.kind = 'payment_advice' AND ra.status = 'open') THEN 'Payment reported'
  WHEN s.invoice_due_date < CURRENT_DATE THEN 'Overdue' WHEN s.amount_received > 0 THEN 'Part paid' ELSE 'Due' END`;
// "Payment reported": the client told us they paid (§4) and finance has not
// matched it yet. Shown to the client in place of "Overdue"; our own
// collections figures do not change until finance records the payment.

/** An attachment that hangs on one of the company's records: the company, a project, a PO or an invoice. */
const attachmentOf = (a, company) => `(
     (${a}.entity = 'company' AND ${a}.entity_id = (${company})::int::text)
  OR (${a}.entity = 'project' AND EXISTS (SELECT 1 FROM projects ap WHERE ap.project_id = ${a}.entity_id AND ap.company_id = (${company})::int))
  OR (${a}.entity = 'purchase_order' AND EXISTS (SELECT 1 FROM purchase_orders apo JOIN projects app ON app.project_id = apo.project_id
                                                 WHERE apo.po_number = ${a}.entity_id AND app.company_id = (${company})::int))
  OR (${a}.entity = 'payment_stage' AND EXISTS (SELECT 1 FROM payment_stages aps JOIN purchase_orders apo2 ON apo2.po_number = aps.po_number
                                                JOIN projects app2 ON app2.project_id = apo2.project_id
                                               WHERE aps.id::text = ${a}.entity_id AND aps.invoice_no IS NOT NULL AND app2.company_id = (${company})::int)))`;

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Projects and the purchase orders under them (#198 §3, G1): each live PO's
 * value with its GST, its services, its payment schedule stage by stage, and
 * what has been billed, received and is still to bill. Every figure includes
 * GST; billed + still to bill is the PO value.
 */
export async function portalProjects(companyId, { staff = false } = {}) {
  const [{ rows: projects }, { rows: visits }, { rows: steps }, { rows: pos }, { rows: services }, { rows: stages }] = await Promise.all([
    query(
      `SELECT p.project_id, p.primary_service, p.planned_start_date, p.planned_delivery_date, p.project_stage,
              p.actual_initiation_date, p.actual_delivery_date, p.onboarding_done, p.onboarding_total
         FROM v_projects p WHERE p.company_id = $1 ORDER BY p.project_id DESC`, [companyId]),
    query(
      `SELECT v.project_id, v.type, v.title, v.starts_at, v.ends_at, v.all_day, v.city, v.status
         FROM visits v JOIN projects p ON p.project_id = v.project_id
        WHERE p.company_id = $1 AND v.status IN ('planned','confirmed') AND v.ends_at >= now() ORDER BY v.starts_at`, [companyId]),
    query(
      `SELECT o.project_id, o.step, o.completed_date IS NOT NULL AS done FROM onboarding_tasks o JOIN projects p ON p.project_id = o.project_id
        WHERE p.company_id = $1 ORDER BY o.project_id, o.id`, [companyId]),
    query(
      `SELECT po.po_number, po.project_id, po.po_date, po.po_value AS value, po.currency, po.document_id IS NOT NULL AS has_file,
              po.replaces_po_number AS revised_from, g.taxable, g.gst, g.source AS gst_source
         FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id
        CROSS JOIN LATERAL po_gst_split(po.po_number, po.po_value) g
        WHERE p.company_id = $1 AND ${LIVE_PO}
        ORDER BY po.po_date DESC NULLS LAST, po.po_number`, [companyId]),
    query(
      `SELECT sv.po_number, sv.service FROM po_services sv JOIN purchase_orders po ON po.po_number = sv.po_number
         JOIN projects p ON p.project_id = po.project_id WHERE p.company_id = $1 ORDER BY sv.id`, [companyId]),
    // Internal fields of a stage (hold, reminders, promises, remarks) are not selected.
    query(
      `SELECT s.id, s.po_number, s.stage_no, s.stage_name, s.stage_percent, s.trigger_event, s.milestone_name,
              s.invoice_no, s.invoice_date, s.stage_amount AS amount, s.amount_received AS received,
              CASE WHEN s.invoice_no IS NULL THEN 'Not yet invoiced' ELSE ${INVOICE_STATE} END AS state,
              s.document_id IS NOT NULL AND s.invoice_no IS NOT NULL AS has_pdf
         FROM v_payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
        WHERE p.company_id = $1 ORDER BY s.po_number, s.stage_no`, [companyId]),
  ]);
  const ordersOf = (projectId) => pos.filter((po) => po.project_id === projectId).map((po) => {
    const schedule = stages.filter((s) => s.po_number === po.po_number);
    const invoiced = schedule.filter((s) => s.invoice_no);
    const billed = r2(invoiced.reduce((n, s) => n + Number(s.amount), 0));
    const received = r2(invoiced.reduce((n, s) => n + Number(s.received), 0));
    return {
      ...po,
      services: services.filter((sv) => sv.po_number === po.po_number).map((sv) => sv.service),
      billed, received,
      outstanding: r2(Math.max(billed - received, 0)),
      to_bill: r2(Math.max(Number(po.value) - billed, 0)),
      schedule: schedule.map(({ po_number, received: _received, ...s }) => s),
    };
  });
  return projects.map((p) => ({
    ...p,
    visits: visits.filter((v) => v.project_id === p.project_id),
    checklist: steps.filter((s) => s.project_id === p.project_id).map(({ step, done }) => ({ step, done })),
    orders: forClient(ordersOf(p.project_id), staff),
  }));
}

/**
 * Each invoice with taxable value, GST and total including GST (#198 §3,
 * G2), what was received split into paid and TDS deducted, and whether its
 * PDF can be opened (G3). Invoices on a revised or cancelled PO stay: they
 * were raised, and are still billed as usual.
 */
export async function portalInvoices(companyId, { staff = false } = {}) {
  const { rows } = await query(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.invoice_due_date, s.po_number, po.project_id, s.stage_name, s.currency,
            g.taxable, g.gst, s.stage_amount AS amount, g.source AS gst_source,
            s.amount_received AS received, COALESCE(pay.paid, 0) AS paid, COALESCE(pay.tds, 0) AS tds,
            GREATEST(s.stage_amount - s.amount_received, 0) AS outstanding,
            ${INVOICE_STATE} AS status,
            s.document_id, s.document_id IS NOT NULL AS has_pdf,
            (SELECT json_build_object('kind', a.kind, 'status', a.status, 'at', a.created_at)
               FROM portal_client_actions a JOIN portal_client_action_stages x ON x.action_id = a.id
              WHERE x.stage_id = s.id ORDER BY a.created_at DESC LIMIT 1) AS last_action
       FROM v_payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
      CROSS JOIN LATERAL po_gst_split(s.po_number, s.stage_amount, s.id) g
       LEFT JOIN LATERAL (SELECT SUM(amount) AS paid, SUM(tds_amount) AS tds FROM payments WHERE stage_id = s.id) pay ON true
      WHERE p.company_id = $1 AND s.invoice_no IS NOT NULL ORDER BY s.invoice_date DESC NULLS LAST, s.invoice_no`, [companyId]);
  return forClient(rows, staff);
}

/** Totals per currency: taxable, GST, total, received and outstanding. */
export function invoiceTotals(invoices) {
  const out = {};
  for (const i of invoices) {
    const t = (out[i.currency || 'INR'] ||= { taxable: 0, gst: 0, amount: 0, paid: 0, tds: 0, outstanding: 0 });
    for (const k of Object.keys(t)) t[k] = r2(t[k] + Number(i[k] || 0));
  }
  return out;
}

export async function portalDocuments(companyId, { staff = false, contactId = null } = {}) {
  const [quotations, pos, invoices, deliverables, files, targets] = await Promise.all([
    query(`SELECT quotation_no, revision, quotation_date, service_quoted, COALESCE(total, quotation_value) AS amount, currency, status, document_id
             FROM quotations WHERE company_id = $1 AND (sent_at IS NOT NULL OR status IN ('Won - PO Received','Under Negotiation')) ORDER BY quotation_date DESC NULLS LAST`, [companyId]),
    // Live POs only (G4): a cancelled or superseded PO's value is not the client's figure any more.
    query(`SELECT po.po_number, po.po_date, po.po_value AS amount, po.currency, po.document_id, po.project_id
             FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE p.company_id = $1 AND ${LIVE_PO}
            ORDER BY po.po_date DESC NULLS LAST`, [companyId]),
    portalInvoices(companyId, { staff }),
    query(`SELECT id, type, reference, title, issued_on, valid_until, status, document_id FROM deliverables
            WHERE company_id = $1 AND status IN ('issued','expired','superseded') ORDER BY issued_on DESC NULLS LAST`, [companyId]),
    // Two-way files (G10): staff files ticked "shared with client", and the client's own uploads.
    query(`SELECT a.id, a.entity, a.entity_id, a.label, a.created_at, a.document_id, d.file_name,
                  a.uploaded_by_contact_id IS NOT NULL AS from_client, a.seen_by_staff_at IS NOT NULL AS seen,
                  COALESCE(a.uploaded_by_contact_id = $2, false) AS mine,
                  (SELECT ct.name FROM contacts ct WHERE ct.id = a.uploaded_by_contact_id) AS by_name
             FROM attachments a JOIN documents d ON d.id = a.document_id
            WHERE (a.shared_with_client OR a.uploaded_by_contact_id IS NOT NULL) AND ${attachmentOf('a', '$1')}
            ORDER BY a.created_at DESC`, [companyId, contactId]),
    // Where a client may file an upload: one of their projects, or one of their live POs.
    query(`SELECT 'project' AS entity, p.project_id AS entity_id, COALESCE(p.primary_service, p.project_id) AS label, p.project_id AS sort_key
             FROM projects p WHERE p.company_id = $1
           UNION ALL
           SELECT 'purchase_order', po.po_number, 'PO ' || po.po_number, po.project_id || ' ' || po.po_number
             FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE p.company_id = $1 AND ${LIVE_PO}
            ORDER BY sort_key DESC`, [companyId]),
  ]);
  return {
    quotations: quotations.rows, purchase_orders: pos.rows, invoices: invoices.filter((i) => i.document_id), deliverables: deliverables.rows,
    shared: files.rows.filter((x) => !x.from_client).map(({ mine, seen, from_client, by_name, ...x }) => x),
    uploads: files.rows.filter((x) => x.from_client).map(({ from_client, ...x }) => x),
    targets: targets.rows.map(({ sort_key, ...t }) => t),
  };
}

/** The client's own answers (§4), newest first: what each was about and where it stands. */
export async function portalActions(companyId) {
  const { rows } = await query(
    `SELECT a.id, a.kind, a.po_number, a.note, a.amount, a.tds_amount, a.paid_on, a.reference, a.status, a.resolution,
            a.created_at, a.resolved_at, a.document_id IS NOT NULL AS has_file,
            COALESCE(json_agg(json_build_object('id', s.id, 'invoice_no', s.invoice_no, 'po_number', s.po_number)
                     ORDER BY s.invoice_no) FILTER (WHERE s.id IS NOT NULL), '[]') AS invoices
       FROM portal_client_actions a
       LEFT JOIN portal_client_action_stages x ON x.action_id = a.id
       LEFT JOIN payment_stages s ON s.id = x.stage_id
      WHERE a.company_id = $1
      GROUP BY a.id ORDER BY a.created_at DESC LIMIT 200`, [companyId]);
  return rows;
}

/**
 * Which of these invoices (stage ids) and which PO belong to the company.
 * Returns null when any of them does not: "not yours" and "not there" are
 * the same 404.
 */
export async function ownedInvoices(companyId, stageIds, poNumber) {
  const ids = [...new Set(stageIds)];
  const { rows } = ids.length ? await query(
    `SELECT s.id, s.po_number, s.invoice_no FROM payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number
       JOIN projects p ON p.project_id = po.project_id
      WHERE s.id = ANY($2::int[]) AND p.company_id = $1 AND s.invoice_no IS NOT NULL`, [companyId, ids]) : { rows: [] };
  if (rows.length !== ids.length) return null;
  if (poNumber) {
    const { rowCount } = await query(
      `SELECT 1 FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE po.po_number = $2 AND p.company_id = $1`,
      [companyId, poNumber]);
    if (!rowCount) return null;
  }
  return rows;
}

/** Whether a project or PO the client names for an upload is theirs. */
export async function ownsUploadTarget(companyId, entity, entityId) {
  const sql = entity === 'project'
    ? 'SELECT 1 FROM projects p WHERE p.project_id = $2 AND p.company_id = $1'
    : `SELECT 1 FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE po.po_number = $2 AND p.company_id = $1 AND ${LIVE_PO}`;
  const { rowCount } = await query(sql, [companyId, entityId]);
  return rowCount > 0;
}

/**
 * Who to tell about something a client did on a PO: the owner of its project.
 * A notification is addressed by the name the session carries, which in
 * database mode is the account's email.
 */
export async function poOwners(poNumbers, projectIds = []) {
  const { rows } = await query(
    `SELECT DISTINCT u.email AS username FROM projects p JOIN users u ON u.id = p.owner_user_id
      WHERE (p.project_id = ANY($2::text[]) OR p.project_id IN (SELECT po.project_id FROM purchase_orders po WHERE po.po_number = ANY($1::text[])))
        AND u.active AND u.email IS NOT NULL`,
    [[...new Set(poNumbers.filter(Boolean))], [...new Set(projectIds.filter(Boolean))]]);
  return rows.map((r) => r.username);
}

/**
 * Who hears of what a client did. A payment report is finance's work, and
 * there is no finance role, so everyone; anything else the owner of the PO
 * or project, or everyone when it has none. Never both: null already
 * reaches the owner, who would otherwise see it twice.
 */
export async function portalAudience(kind, poNumbers, projectIds = []) {
  if (kind === 'payment_advice') return [null];
  const owners = await poOwners(poNumbers, projectIds);
  return owners.length ? owners : [null];
}

export async function portalCertificates(companyId) {
  const { rows } = await query(
    `SELECT d.id, d.type, d.reference, d.title, d.service_name, d.scope, d.issuing_body, d.issued_on, d.valid_from, d.valid_until, d.status,
            (d.valid_until - CURRENT_DATE) AS days_left, d.document_id, e.next_due_on AS renewal_due
       FROM deliverables d LEFT JOIN engagements e ON e.id = d.engagement_id AND e.status IN ('active','renewal_open')
      WHERE d.company_id = $1 AND d.status IN ('issued','expired') ORDER BY d.valid_until NULLS LAST`, [companyId]);
  return rows;
}

/** The section's data for the client, or for the staff preview. */
export const SECTION_DATA = {
  projects: portalProjects,
  documents: portalDocuments,
  invoices: portalInvoices,
  certificates: (companyId) => portalCertificates(companyId),
};

/** A stored file belongs to the company only through one of its records. */
export async function companyOwnsDocument(companyId, documentId) {
  const { rowCount } = await query(
    `SELECT 1 FROM quotations q WHERE q.document_id = $2 AND q.company_id = $1
     UNION ALL SELECT 1 FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE po.document_id = $2 AND p.company_id = $1
     UNION ALL SELECT 1 FROM payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
                WHERE s.document_id = $2 AND s.invoice_no IS NOT NULL AND p.company_id = $1
     UNION ALL SELECT 1 FROM deliverables d WHERE d.document_id = $2 AND d.company_id = $1 AND d.status <> 'draft'
     UNION ALL SELECT 1 FROM attachments a WHERE a.document_id = $2 AND (a.shared_with_client OR a.uploaded_by_contact_id IS NOT NULL)
                AND ${attachmentOf('a', '$1')}
     UNION ALL SELECT 1 FROM portal_client_actions pa WHERE pa.document_id = $2 AND pa.company_id = $1`, [companyId, documentId]);
  return rowCount > 0;
}

/** The PDF behind one of the company's invoices (a stage with an invoice number), or null. */
export async function invoiceDocument(companyId, stageId) {
  const { rows } = await query(
    `SELECT s.document_id, s.invoice_no FROM payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number
       JOIN projects p ON p.project_id = po.project_id
      WHERE s.id = $2 AND p.company_id = $1 AND s.invoice_no IS NOT NULL AND s.document_id IS NOT NULL`, [companyId, stageId]);
  return rows[0] || null;
}

/** The file behind one of the company's live purchase orders, or null. */
export async function poDocument(companyId, poNumber) {
  const { rows } = await query(
    `SELECT po.document_id FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id
      WHERE po.po_number = $2 AND p.company_id = $1 AND po.document_id IS NOT NULL AND ${LIVE_PO}`, [companyId, poNumber]);
  return rows[0] || null;
}

/**
 * A statement of account: every invoice with taxable value, GST and the
 * total including GST, what was paid and what TDS was deducted, what is
 * open; totals per currency (#198 §3).
 */
export async function statementPdf(company, invoices, today) {
  const totals = invoiceTotals(invoices);
  const right = (v, c) => ({ text: money(v, c), alignment: 'right' });
  const doc = {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [36, 36, 36, 36],
    defaultStyle: { font: 'Roboto', fontSize: 8.5, color: '#0f172a' },
    content: [
      { text: 'Cetizion Verifica', color: '#0f766e', bold: true, fontSize: 14 },
      { text: `Statement of account for ${company.name}`, fontSize: 12, margin: [0, 6, 0, 0] },
      { text: `As on ${today}. Total, paid and outstanding include GST; received is paid plus TDS deducted.`, color: '#64748b', margin: [0, 2, 0, 12] },
      {
        table: {
          headerRows: 1, widths: ['auto', 'auto', 'auto', '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
          body: [
            ['Invoice', 'Date', 'Due', 'PO / stage', 'Taxable', 'GST', 'Total', 'Paid', 'TDS', 'Outstanding', 'Status'].map((t) => ({ text: t, bold: true })),
            ...invoices.map((i) => [i.invoice_no, i.invoice_date || '', i.invoice_due_date || '', `${i.po_number} · ${i.stage_name}`,
              right(i.taxable, i.currency), right(i.gst, i.currency), right(i.amount, i.currency),
              right(i.paid, i.currency), right(i.tds, i.currency), right(i.outstanding, i.currency), i.status]),
            ...Object.entries(totals).map(([c, t]) => [{ text: `Total (${c})`, bold: true, colSpan: 4 }, '', '', '',
              right(t.taxable, c), right(t.gst, c), right(t.amount, c), right(t.paid, c), right(t.tds, c), { ...right(t.outstanding, c), bold: true }, '']),
          ],
        },
        layout: 'lightHorizontalLines',
      },
      { text: Object.entries(totals).map(([c, t]) => `Total outstanding (${c}, including GST): ${money(t.outstanding, c)}`).join('\n') || 'Nothing outstanding.', bold: true, margin: [0, 12, 0, 0] },
      { text: 'If a payment has already been made, please share the transaction reference.', color: '#64748b', margin: [0, 12, 0, 0] },
    ],
  };
  return pdfmake.createPdf(doc).getBuffer();
}
