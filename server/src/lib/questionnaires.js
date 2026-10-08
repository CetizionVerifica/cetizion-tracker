/**
 * Service questionnaires in the database (#208 phase 1): the client's
 * link, who may reach a response, sending and reminding.
 *
 * A link is a random token of which only the SHA-256 is stored, with an
 * expiry and a revoke, as an acceptance link is (#53). Because the token
 * itself is never kept, a reminder or a "copy link" makes a new link to
 * the same response rather than resending the old one; every link of a
 * response reaches the same answers, until it expires or is revoked.
 *
 * A response belongs to the enquiry it was sent from: a sales user reaches
 * it when they own that enquiry (its owner today, not when it was sent).
 */
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { documentStorageReady, uploadDocument } from './documents.js';
import { questionnaireInvite, questionnaireSubmitted } from './emailTemplates.js';
import { sendMail } from './mail.js';
import { notify } from './notify.js';
import { allQuestions, checkAnswers, fileIds } from './questionnaireDefinition.js';

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const OPEN_STATUSES = ['not_started', 'in_progress', 'reopened'];

/** A yes/no or number setting; a missing row is the fallback. */
export async function settingNumber(db, key, fallback) {
  const { rows: [r] } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  const n = Number(r?.value);
  return r && Number.isFinite(n) ? n : fallback;
}

/**
 * The address a client's link is built on: the public address in Settings,
 * else CORS_ORIGIN. Never the request's own headers, which the caller
 * chooses (the same rule as acceptance links, routes/acceptance.js).
 */
export async function publicBase(db = { query }) {
  const { rows: [r] } = await db.query(`SELECT value FROM settings WHERE key = 'public_app_url'`);
  const set = String(r?.value || '').trim().replace(/\/+$/, '');
  if (set) return set;
  const configured = config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean)[0];
  if (configured) return configured.replace(/\/+$/, '');
  throw new ApiError(422, 'Set the public address of the tracker in Settings before sending a questionnaire');
}

/**
 * The SQL that keeps a response to the people who may reach it: '' for an
 * admin; otherwise the owner of its enquiry (or, with no enquiry, the
 * person who sent it).
 */
export function responseClause(scope, params, alias = 'r') {
  if (scope.unrestricted) return '';
  params.push(scope.ownerId ?? 0);
  return `COALESCE((SELECT qe.owner_user_id FROM enquiries qe WHERE qe.id = ${alias}.enquiry_id), ${alias}.requested_by_user_id) = $${params.length}`;
}

/** A new link to a response. Returns { url, expires_at }; the token itself is never stored. */
export async function createLink(db, { responseId, sentTo = null, createdBy = null, expiresAt = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const days = await settingNumber(db, 'questionnaire_link_days', 30);
  const { rows: [l] } = await db.query(
    `INSERT INTO questionnaire_links (response_id, token_hash, sent_to, expires_at, created_by)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now() + make_interval(days => $5)), $6) RETURNING id, expires_at`,
    [responseId, hashToken(token), sentTo, expiresAt, Math.max(1, Math.round(days)), createdBy]);
  return { id: l.id, token, url: `${await publicBase(db)}/q/${token}`, expires_at: l.expires_at };
}

/** Everything one email about a response needs: the client, the form's name, and who is asking. */
export async function inviteContext(db, responseId) {
  const { rows: [r] } = await db.query(
    `SELECT r.id, q.name AS questionnaire, s.name AS service, e.enquiry_no,
            COALESCE(co.name, e.client_name) AS company, COALESCE(ct.name, e.contact_person) AS contact_name, ct.email AS contact_email,
            COALESCE(u.name, e.sales_person) AS from_name
       FROM questionnaire_responses r
       JOIN questionnaire_versions v ON v.id = r.version_id
       JOIN questionnaires q ON q.id = v.questionnaire_id
       JOIN services s ON s.id = q.service_id
       LEFT JOIN enquiries e ON e.id = r.enquiry_id
       LEFT JOIN companies co ON co.id = COALESCE(r.company_id, e.company_id)
       LEFT JOIN contacts ct ON ct.id = COALESCE(r.contact_id, e.contact_id)
       LEFT JOIN users u ON u.id = COALESCE(e.owner_user_id, r.requested_by_user_id)
      WHERE r.id = $1`, [responseId]);
  return r;
}

/**
 * Email the client a link to the response: a new one, so the email can
 * carry it. A reminder says so and counts against the reminder limit.
 * Returns the email log row and the link.
 */
export async function emailLink(db, { responseId, to, message = '', reminder = false, sentBy = 'system', expiresAt = null }) {
  const ctx = await inviteContext(db, responseId);
  if (!ctx) throw new ApiError(404, 'Questionnaire not found');
  const link = await createLink(db, { responseId, sentTo: to, createdBy: sentBy, expiresAt });
  const mail = questionnaireInvite({
    contactName: ctx.contact_name, company: ctx.company || 'your company', questionnaire: ctx.questionnaire,
    url: link.url, expiresAt: link.expires_at, from: ctx.from_name ? `${ctx.from_name}, Cetizion Verifica` : 'Cetizion Verifica', message, reminder,
  });
  const log = await sendMail({
    ...mail, to, template: reminder ? 'questionnaire_reminder' : 'questionnaire_invite',
    entity: ctx.enquiry_no ? 'enquiry' : null, entityId: ctx.enquiry_no || null, sentBy, secrets: [link.token],
  }, db);
  return { link, log };
}

/**
 * The daily reminder run. A response still open, with a live link sent to
 * an address, whose last email (the invite or a reminder) is older than
 * questionnaire_reminder_days, gets one more, at most twice, never after
 * the links expire. 0 days switches reminders off.
 */
export async function runQuestionnaireReminders({ db = { query }, startedBy = 'schedule' } = {}) {
  const days = await settingNumber(db, 'questionnaire_reminder_days', 3);
  if (!(days > 0)) return { reminded: [], skipped: 'switched off in Settings' };
  const { rows } = await db.query(
    `SELECT r.id, latest.sent_to, latest.expires_at, latest.reminders
       FROM questionnaire_responses r
       CROSS JOIN LATERAL (
         SELECT (array_agg(l.sent_to ORDER BY l.created_at DESC) FILTER (WHERE l.sent_to IS NOT NULL))[1] AS sent_to,
                max(l.expires_at) AS expires_at, max(l.created_at) FILTER (WHERE l.sent_to IS NOT NULL) AS last_sent,
                max(l.reminder_count) AS reminders
           FROM questionnaire_links l
          WHERE l.response_id = r.id AND l.revoked_at IS NULL AND l.expires_at > now()) latest
      WHERE r.status = ANY($1) AND latest.sent_to IS NOT NULL
        AND latest.last_sent < now() - make_interval(days => $2)
        AND COALESCE(latest.reminders, 0) < 2
      ORDER BY r.id LIMIT 200`, [OPEN_STATUSES, Math.round(days)]);
  const reminded = [];
  for (const r of rows) {
    // A reminder never outlives the links it follows.
    const { link, log } = await emailLink(db, { responseId: r.id, to: r.sent_to, reminder: true, sentBy: startedBy, expiresAt: r.expires_at });
    await db.query('UPDATE questionnaire_links SET reminder_count = $2 WHERE id = $1', [link.id, Number(r.reminders || 0) + 1]);
    await db.query('UPDATE questionnaire_links SET reminded_at = now() WHERE response_id = $1 AND revoked_at IS NULL', [r.id]);
    reminded.push({ response_id: r.id, to: r.sent_to, status: log.status });
  }
  return { reminded, days };
}

// ------------------------------------------------------------ answers, files, submitting

/** What a client may upload into a file question: PDF, image, Word or Excel, within the document size cap. */
export const UPLOAD_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
export const safeFileName = (name) => String(name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 200);

const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.documentMaxBytes, files: 1 } });
/** One file, with a file over the cap said in words rather than as a server error. */
export const oneFile = (field) => (req, res, next) => fileUpload.single(field)(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return next(new ApiError(422, `That file is larger than ${Math.round(config.documentMaxBytes / 1024 / 1024)} MB`));
  return next(err);
});

/** Answers kept as checked; a file must be one uploaded into this response. */
export async function keepAnswers(db, r, input, { submit = false } = {}) {
  const { values, errors } = checkAnswers(r.definition, input, { submit });
  const ids = fileIds(r.definition, values);
  if (ids.length) {
    const { rows } = await db.query('SELECT document_id FROM questionnaire_response_files WHERE response_id = $1 AND document_id = ANY($2::int[])', [r.id, ids]);
    const mine = new Set(rows.map((x) => x.document_id));
    for (const q of allQuestions(r.definition).filter((x) => x.type === 'file')) {
      if ((values[q.key] || []).some((d) => !mine.has(d))) errors[q.key] = 'Upload the file again';
    }
  }
  return { values, errors };
}

/** A file into one of the response's file questions; the answer itself is saved with the rest. */
export async function storeResponseFile(db, r, { questionKey, file, uploadedBy }) {
  const q = allQuestions(r.definition).find((x) => x.key === questionKey && x.type === 'file');
  if (!q) throw new ApiError(422, 'Please check the highlighted fields', { fields: { question_key: 'Not a file question' } });
  if (!file) throw new ApiError(422, 'Please check the highlighted fields', { fields: { file: 'Choose a file' } });
  if (!UPLOAD_TYPES.has(file.mimetype)) throw new ApiError(422, 'Please check the highlighted fields', { fields: { file: 'PDF, image, Word or Excel files only' } });
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM questionnaire_response_files WHERE response_id = $1', [r.id]);
  if (n >= 50) throw new ApiError(422, 'Fifty files is the most one questionnaire takes');
  if (!documentStorageReady()) throw new ApiError(503, 'File storage is not set up on this server');
  const doc = await uploadDocument({ buffer: file.buffer, fileName: safeFileName(file.originalname), contentType: file.mimetype, owner: 'questionnaires' });
  await db.query('INSERT INTO questionnaire_response_files (response_id, question_key, document_id, uploaded_by) VALUES ($1,$2,$3,$4)',
    [r.id, questionKey, doc.id, uploadedBy]);
  return { document_id: doc.id, file_name: doc.file_name };
}

/**
 * Submit a response: every visible required question answered, files its
 * own. Afterwards it is read-only until staff reopen it. A client's
 * submission tells the enquiry's owner, in the bell and by email.
 */
export async function submitResponse(id, { answers, name = null, email = null, filledBy = 'client' }) {
  const r = await transaction(async (db) => {
    const { rows: [row] } = await db.query(
      `SELECT r.*, v.definition FROM questionnaire_responses r JOIN questionnaire_versions v ON v.id = r.version_id WHERE r.id = $1 FOR UPDATE OF r`, [id]);
    if (!row) throw new ApiError(404, 'Questionnaire not found');
    if (!OPEN_STATUSES.includes(row.status)) throw new ApiError(409, row.status === 'submitted' ? 'Already submitted' : 'This questionnaire was withdrawn');
    const { values, errors } = await keepAnswers(db, row, answers ?? row.answers, { submit: true });
    if (Object.keys(errors).length) throw new ApiError(422, 'Please answer the highlighted questions', { fields: errors });
    await db.query(
      `UPDATE questionnaire_responses SET answers = $2, status = 'submitted', submitted_at = now(), submitted_by_name = $3, submitted_by_email = $4,
              filled_by = CASE WHEN $5 = 'staff' THEN 'staff' ELSE filled_by END WHERE id = $1`,
      [id, JSON.stringify(values), name, email, filledBy]);
    return row;
  });
  if (filledBy === 'staff') return;
  const { rows: [o] } = await query(
    `SELECT r.enquiry_id, e.enquiry_no, COALESCE(co.name, e.client_name, 'A client') AS company, q.name AS questionnaire,
            COALESCE(u.email, e.sales_person_email) AS owner_email, COALESCE(u.name, e.sales_person) AS owner_name
       FROM questionnaire_responses r JOIN questionnaire_versions v ON v.id = r.version_id JOIN questionnaires q ON q.id = v.questionnaire_id
       LEFT JOIN enquiries e ON e.id = r.enquiry_id LEFT JOIN companies co ON co.id = COALESCE(r.company_id, e.company_id)
       LEFT JOIN users u ON u.id = COALESCE(e.owner_user_id, r.requested_by_user_id) WHERE r.id = $1`, [id]);
  if (!o) return;
  const path = o.enquiry_no ? `/enquiries?q=${encodeURIComponent(o.enquiry_no)}&questionnaire=${id}` : '/enquiries';
  await notify({
    username: o.owner_email || null, kind: 'questionnaire_submitted',
    title: `${o.company} submitted the ${o.questionnaire}`, body: name ? `By ${name}` : null,
    entity: o.enquiry_no ? 'enquiry' : null, entityId: o.enquiry_no || null, link: path, dedupeKey: `questionnaire-submitted:${id}:${r.updated_at?.toISOString?.() || ''}`,
  }).catch(() => {});
  if (o.owner_email) {
    let base = null;
    try { base = await publicBase(); } catch { base = null; }
    const mail = questionnaireSubmitted({ ownerName: o.owner_name, company: o.company, questionnaire: o.questionnaire, enquiryNo: o.enquiry_no, submittedBy: name, link: base ? `${base}${path}` : null });
    await sendMail({ ...mail, to: o.owner_email, template: 'questionnaire_submitted', entity: o.enquiry_no ? 'enquiry' : null, entityId: o.enquiry_no || null, sentBy: 'questionnaire' }).catch(() => {});
  }
}
