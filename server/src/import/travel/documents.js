/**
 * Many travel files at once, each filed by its name (#196 §5.4).
 *
 *   HT-2627-1877.pdf            the agency invoice HT/2627/1877: its PDF
 *   HT_2627_CN_349.pdf          the credit note HT/2627/CN/349: its PDF
 *   TRV-2026-014-ticket.pdf     trip TRV-2026-014, a ticket
 *   TRV-2026-014 boarding.jpg   the same trip, a boarding pass
 *
 * A number's "/" may be written "-", "_", " " or left out. An invoice or
 * credit note that already has its PDF keeps it: a second file for an
 * invoice is filed beside it as an attachment, a second one for a credit
 * note is listed back. What names nothing is listed back too, for HR to
 * attach by hand from the trip. Nothing is guessed from inside the file.
 */
import { query, transaction } from '../../db.js';
import { uploadDocument } from '../../lib/documents.js';
import { docTypeOf, matchFile } from './files.js';

export { docTypeOf, matchFile };

export async function attachTravelDocuments(files, { user }) {
  const [invoices, credits, trips] = await Promise.all([
    query('SELECT id, vendor_invoice_id, vendor_invoice_no, document_id FROM travel_vendor_invoices WHERE vendor_invoice_no IS NOT NULL'),
    query('SELECT id, credit_note_no, document_id FROM travel_vendor_credit_notes'),
    query('SELECT travel_id FROM travel_logs'),
  ]);
  const known = { invoices: invoices.rows, credits: credits.rows, trips: trips.rows };
  const attached = [];
  const unmatched = [];
  for (const file of files) {
    const name = file.originalname;
    const match = matchFile(name, known);
    if (!match) { unmatched.push({ file: name, reason: 'its name holds no invoice, credit note or Travel ID the tracker has' }); continue; }
    if (match.kind === 'credit_note' && match.record.document_id) {
      unmatched.push({ file: name, reason: `credit note ${match.record.credit_note_no} already has its PDF` });
      continue;
    }
    const owner = match.kind === 'credit_note' ? 'vendor-credit-notes' : match.kind === 'vendor_invoice' && !match.record.document_id ? 'vendor-invoices' : 'attachments';
    const doc = await uploadDocument({ buffer: file.buffer, fileName: name.slice(0, 200), contentType: file.mimetype || 'application/octet-stream', owner });
    await transaction(async (client) => {
      if (match.kind === 'credit_note') {
        await client.query('UPDATE travel_vendor_credit_notes SET document_id = $1 WHERE id = $2', [doc.id, match.record.id]);
        match.record.document_id = doc.id;
      } else if (owner === 'vendor-invoices') {
        await client.query('UPDATE travel_vendor_invoices SET document_id = $1 WHERE id = $2', [doc.id, match.record.id]);
        match.record.document_id = doc.id;
      } else {
        const entity = match.kind === 'trip' ? 'travel_log' : 'travel_vendor_invoice';
        const entityId = match.kind === 'trip' ? match.record.travel_id : String(match.record.id);
        await client.query(
          'INSERT INTO attachments (entity, entity_id, document_id, label, uploaded_by, doc_type) VALUES ($1, $2, $3, $4, $5, $6)',
          [entity, entityId, doc.id, name.slice(0, 200), user?.name || user?.username || null, match.kind === 'trip' ? docTypeOf(name) : 'vendor_invoice']);
      }
    });
    attached.push({
      file: name, document_id: doc.id,
      to: match.kind === 'trip' ? { trip: match.record.travel_id, doc_type: docTypeOf(name) }
        : match.kind === 'credit_note' ? { credit_note: match.record.credit_note_no }
          : { vendor_invoice: match.record.vendor_invoice_no, vendor_invoice_id: match.record.vendor_invoice_id, as: owner === 'vendor-invoices' ? 'its PDF' : 'an attachment' },
    });
  }
  return { attached, unmatched };
}
