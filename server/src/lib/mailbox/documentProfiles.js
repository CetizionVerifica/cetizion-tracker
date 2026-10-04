/**
 * What is particular about one client's POs or invoices
 * (docs/email-po-invoice-prompt-plan.md §6): a note for the model, the
 * labels the client uses, and the shape of its PO numbers.
 *
 *   loadProfiles(db, docType)        the approved profiles, with each client's name and GSTIN
 *   pickProfile(profiles, facts)     the one for this email: by the sender's
 *                                    domain, the thread's client, then a
 *                                    client GSTIN in the document. No AI call.
 *   profileNote(profile)             "Notes on documents from <client>: …", for the prompt
 *   fitsPattern(profile, poNumber)   a PO number of the shape the client uses
 *   noteCorrection(db, facts)        a reviewer settled one of the client's
 *                                    items by hand; after three in 90 days
 *                                    with no profile, one is suggested for an
 *                                    admin to write and approve
 *
 * Only an approved profile is used. An admin approves by saving it in
 * Settings → Client document notes, or with Approve on a suggested one.
 */
import { gstinOf } from './ourParties.js';

export const CORRECTIONS_FOR_A_SUGGESTION = 3;

export async function loadProfiles(db, docType) {
  const { rows } = await db.query(
    `SELECT p.id, p.company_id, p.doc_type, p.sender_domains, p.po_number_pattern, p.label_aliases, p.hint, c.name AS company_name, c.gstin AS company_gstin
       FROM company_document_profiles p JOIN companies c ON c.id = p.company_id
      WHERE p.doc_type = $1 AND p.approved_at IS NOT NULL`, [docType]);
  return rows;
}

/** facts: { senderEmail, companyId, text } */
export function pickProfile(profiles, { senderEmail = null, companyId = null, text = '' } = {}) {
  if (!profiles?.length) return null;
  const domain = String(senderEmail || '').toLowerCase().split('@')[1] || null;
  const flat = String(text || '').toUpperCase().replace(/\s/g, '');
  return (domain && profiles.find((p) => (p.sender_domains || []).some((d) => d && (domain === d || domain.endsWith(`.${d}`)))))
    || (companyId && profiles.find((p) => p.company_id === companyId))
    || profiles.find((p) => gstinOf(p.company_gstin).length === 15 && flat.includes(gstinOf(p.company_gstin)))
    || null;
}

export function profileNote(p) {
  if (!p || (!p.hint && !p.label_aliases)) return null;
  return [`Notes on documents from ${p.company_name}:`, p.hint, p.label_aliases ? `The labels it prints: ${p.label_aliases}.` : null].filter(Boolean).join(' ');
}

/** True when there is no pattern, or a pattern that is not valid (an admin's typo never holds a PO back). */
export function fitsPattern(p, poNumber) {
  if (!p?.po_number_pattern) return true;
  let re;
  try { re = new RegExp(p.po_number_pattern, 'i'); } catch { return true; }
  return re.test(String(poNumber || '').trim());
}

const DOCS = { po: 'POs', invoice: 'invoices' };

export async function noteCorrection(db, { companyId, docType, reason = null, by = null }) {
  if (!companyId) return null;
  await db.query('INSERT INTO document_profile_corrections (company_id, doc_type, review_reason, decided_by) VALUES ($1, $2, $3, $4)', [companyId, docType, reason, by]);
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n, string_agg(DISTINCT review_reason, ', ') AS reasons
       FROM document_profile_corrections WHERE company_id = $1 AND doc_type = $2 AND created_at > now() - interval '90 days'`, [companyId, docType]);
  if (r.n < CORRECTIONS_FOR_A_SUGGESTION) return null;
  const { rows: [made] } = await db.query(
    `INSERT INTO company_document_profiles (company_id, doc_type, hint)
     VALUES ($1, $2, $3) ON CONFLICT (company_id, doc_type) DO NOTHING RETURNING id`,
    [companyId, docType, `Suggested: ${r.n} of this client's ${DOCS[docType]} needed a person in 90 days${r.reasons ? ` (${r.reasons})` : ''}. Write what is particular about them, then approve.`]);
  return made?.id ?? null;
}
