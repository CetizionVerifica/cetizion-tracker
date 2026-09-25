/**
 * A quotation as a document (#23):
 *
 *   GET  /api/quotations/:key/full      quotation, lines, revisions, company, contact, enquiry, project, POs
 *   GET  /api/quotations/:key/pdf       the quotation as a PDF
 *   POST /api/quotations/:key/revise    { note } snapshot the current version, bump the revision, reopen validity
 *   POST /api/quotations/:key/send      { to?, message? } stamp sent_at; email the PDF to the contact when asked
 *   POST /api/quotations/:key/accept    { accepted_by_name } the client said yes
 *
 * :key is the quotation number or the internal id. Mounted before the
 * workflow router so these paths win.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { businessToday } from '../lib/businessDate.ts';
import { sendMail } from '../lib/mail.js';
import { quotationPdf } from '../lib/quotationPdf.js';
import { documentStorageReady, uploadDocument } from '../lib/documents.js';
import { checkGstin, gstBreakdown } from '../lib/accounting/gst.js';

export const quotationDocRouter = Router();

async function loadQuotation(key, client = { query }) {
  const { rows } = await client.query('SELECT * FROM v_quotations WHERE quotation_no = $1 OR (id::text = $1 AND NOT EXISTS (SELECT 1 FROM quotations WHERE quotation_no = $1))', [decodeURIComponent(key)]);
  if (!rows.length) throw new ApiError(404, 'Quotation not found');
  return rows[0];
}

export async function fullQuotation(key) {
  const q = await loadQuotation(key);
  const [lines, revisions, company, contact, enquiry, project, pos, settings] = await Promise.all([
    query('SELECT ql.*, s.name AS service_name, s.sac_code FROM quotation_lines ql LEFT JOIN services s ON s.id = ql.service_id WHERE quotation_id = $1 ORDER BY sort_order, id', [q.id]),
    query('SELECT id, revision, note, created_by, created_at, snapshot FROM quotation_revisions WHERE quotation_id = $1 ORDER BY revision DESC', [q.id]),
    q.company_id ? query('SELECT * FROM companies WHERE id = $1', [q.company_id]) : { rows: [] },
    q.contact_id ? query('SELECT * FROM contacts WHERE id = $1', [q.contact_id]) : { rows: [] },
    query('SELECT enquiry_no, enquiry_date, status FROM enquiries WHERE quotation_no = $1', [q.quotation_no]),
    q.project_id ? query('SELECT * FROM v_projects WHERE project_id = $1', [q.project_id]) : { rows: [] },
    query('SELECT * FROM v_purchase_orders WHERE quotation_no = $1 ORDER BY po_date', [q.quotation_no]),
    query(`SELECT key, value FROM settings WHERE key IN ('company_name','company_address','company_gstin','company_state_code','quotation_validity_days','gst_rate_default','quotation_terms_default','discount_approval_threshold_percent')`),
  ]);
  const set = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
  const theirs = company.rows[0] || null;
  // Where the supply is made decides CGST + SGST against IGST. The client's
  // own GSTIN is the most reliable answer; the place of supply typed on the
  // quotation is the fallback, and it carries its state code at the front
  // ("27-Maharashtra"). The same order accounting/providers.js uses.
  const ourState = set.company_state_code || checkGstin(set.company_gstin).state_code || null;
  const buyer = checkGstin(theirs?.gstin);
  const theirState = (buyer.valid && buyer.state_code)
    || (q.place_of_supply_state || '').match(/^\d{2}/)?.[0]
    || null;
  return {
    ...q, lines: lines.rows, revisions: revisions.rows, company: theirs, contact: contact.rows[0] || null,
    enquiry: enquiry.rows[0] || null, project: project.rows[0] || null, purchase_orders: pos.rows,
    gst: gstBreakdown(lines.rows, { ourState, theirState, currency: q.currency }),
    settings: set,
  };
}

quotationDocRouter.get('/:key/full', async (req, res) => {
  res.json({ data: await fullQuotation(req.params.key) });
});

quotationDocRouter.get('/:key/pdf', async (req, res) => {
  const q = await fullQuotation(req.params.key);
  const pdf = await quotationPdf(q);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${q.quotation_no.replace(/\//g, '-')}${q.revision ? `-R${q.revision}` : ''}.pdf"`);
  res.send(pdf);
});

const reviseSchema = z.object({ note: z.string().trim().max(1000).optional().default('') });

quotationDocRouter.post('/:key/revise', async (req, res) => {
  const body = reviseSchema.parse(req.body || {});
  const data = await transaction(async (client) => {
    // Lock first, then read: two clicks must not both snapshot the same revision.
    const { id } = await loadQuotation(req.params.key, client);
    await client.query('SELECT 1 FROM quotations WHERE id = $1 FOR UPDATE', [id]);
    const q = await loadQuotation(String(id), client);
    if (q.status === 'Won - PO Received') throw new ApiError(422, 'A won quotation is not revised; raise a new quotation for extra scope');
    const { rows: lines } = await client.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [q.id]);
    const snapshot = { quotation_no: q.quotation_no, revision: q.revision, quotation_date: q.quotation_date, valid_until: q.valid_until, quotation_value: q.quotation_value, subtotal: q.subtotal, tax_total: q.tax_total, total: q.total, currency: q.currency, terms: q.terms, sent_at: q.sent_at, lines };
    await client.query('INSERT INTO quotation_revisions (quotation_id, revision, snapshot, note, created_by) VALUES ($1,$2,$3,$4,$5)', [q.id, q.revision, JSON.stringify(snapshot), body.note || null, req.user?.username || null]);
    const { rows: [{ value: days }] } = await client.query(`SELECT value FROM settings WHERE key = 'quotation_validity_days'`).then((r) => ({ rows: r.rows.length ? r.rows : [{ value: '30' }] }));
    const today = businessToday();
    const { rows: [updated] } = await client.query(
      `UPDATE quotations SET revision = revision + 1, quotation_date = $2, valid_until = ($2::date + ($3::int || ' days')::interval)::date,
              sent_at = NULL, accepted_at = NULL, accepted_by_name = NULL,
              status = CASE WHEN status = 'Lost' THEN 'Submitted' ELSE status END,
              -- a new version is a new approval round
              approval_status = 'not_needed', approval_reason = NULL, approval_requested_at = NULL,
              approval_requested_by = NULL, approval_decided_at = NULL, approved_by = NULL,
              approval_note = NULL, approved_discount_percent = NULL
        WHERE id = $1 RETURNING revision, valid_until, quotation_date`,
      [q.id, today, Number(days) || 30]
    );
    // The discount check runs again on the new version.
    await client.query('SELECT quotation_totals($1)', [q.id]);
    return updated;
  });
  res.json({ data });
});

const sendSchema = z.object({
  to: z.string().trim().email().optional(),
  message: z.string().trim().max(2000).optional().default(''),
  email: z.boolean().optional().default(false),
});

quotationDocRouter.post('/:key/send', async (req, res) => {
  const body = sendSchema.parse(req.body || {});
  const q = await fullQuotation(req.params.key);
  if (q.approval_status === 'pending') throw new ApiError(422, 'The discount on this quotation is awaiting approval');
  if (q.approval_status === 'rejected') throw new ApiError(422, 'The discount on this quotation was rejected; revise it first');
  let email = null;
  const to = body.email ? body.to || q.contact?.email : null;
  if (body.email && !to) throw new ApiError(422, 'No email address: add one on the contact, or type one', { fields: { to: 'Required' } });
  // The PDF that goes out is the one kept on the quotation (#23), emailed or not.
  const pdf = await quotationPdf(q);
  if (body.email) {
    const subject = `Quotation ${q.quotation_no}${q.revision ? ` (rev ${q.revision})` : ''} from Cetizion Verifica`;
    const text = `Dear ${q.contact?.name || q.client_name},\n\n${body.message || `Please find attached our quotation ${q.quotation_no} for ${q.service_quoted || 'the services discussed'}.`}${q.valid_until ? `\n\nThis quotation is valid until ${q.valid_until}.` : ''}\n\nRegards,\n${q.sales_person || 'Cetizion Verifica'}`;
    email = await sendMail({
      to, subject, text, html: `<p>${text.replace(/\n/g, '<br>')}</p>`, template: 'quotation', entity: 'quotation', entityId: q.quotation_no,
      sentBy: req.user?.username || 'admin', attachments: [{ filename: `${q.quotation_no.replace(/\//g, '-')}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
  }
  const fileName = `${q.quotation_no.replace(/\//g, '-')}${q.revision ? `-R${q.revision}` : ''}-sent.pdf`;
  const doc = documentStorageReady
    ? await uploadDocument({ buffer: pdf, fileName, contentType: 'application/pdf', owner: 'attachments' }).catch(() => null)
    : null;
  const updated = await transaction(async (db) => {
    const { rows: [u] } = await db.query(`UPDATE quotations SET sent_at = COALESCE(sent_at, now()) WHERE id = $1 RETURNING sent_at`, [q.id]);
    if (doc) {
      // Kept on the quotation, on its timeline as a file; the client copy slot stays theirs.
      await db.query(`INSERT INTO attachments (entity, entity_id, document_id, label, uploaded_by) VALUES ('quotation', $1, $2, $3, $4)`,
        [q.quotation_no, doc.id, `Quotation as sent${q.revision ? ` (rev ${q.revision})` : ''}${to ? ` to ${to}` : ''}`, req.user?.name || req.user?.username || null]);
    }
    return u;
  });
  res.json({ data: { sent_at: updated.sent_at, email, document_id: doc?.id ?? null } });
});

const acceptSchema = z.object({ accepted_by_name: z.string().trim().min(1, 'Who accepted it?').max(160) });

quotationDocRouter.post('/:key/accept', async (req, res) => {
  const parsed = acceptSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: { accepted_by_name: parsed.error.issues[0].message } });
  const q = await loadQuotation(req.params.key);
  const { rows: [updated] } = await query(
    `UPDATE quotations SET accepted_at = now(), accepted_by_name = $2,
            status = CASE WHEN status IN ('Submitted','On Hold') THEN 'Under Negotiation' ELSE status END
      WHERE id = $1 RETURNING accepted_at, accepted_by_name, status`,
    [q.id, parsed.data.accepted_by_name]
  );
  res.json({ data: updated });
});
