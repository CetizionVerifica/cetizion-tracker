/**
 * The client's questionnaire link (#208 phase 1, §3.1): no sign-in, a
 * token in the address, mounted at /api/public/questionnaire.
 *
 *   GET  /:token          the form, the answers so far, and who is asking
 *   PUT  /:token/answers  { step, answers } saved as the client goes
 *   POST /:token/files    multipart { question_key, file }
 *   POST /:token/submit   { name, email, answers? }
 *
 * A token reaches one response only: its questions, its own answers and
 * the names of its own files. Nothing else about the enquiry, its
 * quotation or the company goes out. Every failure of the link itself is
 * the same message, so a guessed token learns nothing. Rate limited.
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { hashToken, keepAnswers, oneFile, OPEN_STATUSES, storeResponseFile, submitResponse } from '../lib/questionnaires.js';

export const publicQuestionnaireRouter = Router();

publicQuestionnaireRouter.use(rateLimit({
  windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please wait a few minutes.' } },
}));
const writes = rateLimit({ windowMs: 60 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many changes in a short time. Please wait a few minutes.' } } });

const DEAD = 'This link is no longer valid. Please ask Cetizion Verifica for a new one.';

/** The response a token opens, or the one dead-link answer. */
async function openLink(token) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token))) throw new ApiError(404, DEAD);
  const { rows: [l] } = await query(
    `SELECT l.id AS link_id, l.expires_at, l.revoked_at, r.*, v.definition
       FROM questionnaire_links l JOIN questionnaire_responses r ON r.id = l.response_id JOIN questionnaire_versions v ON v.id = r.version_id
      WHERE l.token_hash = $1`, [hashToken(token)]);
  if (!l || l.revoked_at || new Date(l.expires_at) < new Date() || l.status === 'withdrawn') throw new ApiError(404, DEAD);
  return l;
}

publicQuestionnaireRouter.get('/:token', async (req, res) => {
  const r = await openLink(req.params.token);
  await query(
    `UPDATE questionnaire_links SET open_count = open_count + 1, last_opened_at = now(), first_opened_at = COALESCE(first_opened_at, now()) WHERE id = $1`, [r.link_id]);
  const [{ rows: [about] }, { rows: files }, { rows: [seller] }] = await Promise.all([
    query(
      `SELECT q.name AS questionnaire, s.name AS service, COALESCE(co.name, e.client_name) AS client_name,
              COALESCE(u.name, e.sales_person) AS requested_by
         FROM questionnaire_versions v JOIN questionnaires q ON q.id = v.questionnaire_id JOIN services s ON s.id = q.service_id
         LEFT JOIN enquiries e ON e.id = $2 LEFT JOIN companies co ON co.id = COALESCE($3, e.company_id)
         LEFT JOIN users u ON u.id = COALESCE(e.owner_user_id, $4)
        WHERE v.id = $1`, [r.version_id, r.enquiry_id, r.company_id, r.owner_user_id]),
    query(`SELECT f.document_id, f.question_key, d.file_name FROM questionnaire_response_files f JOIN documents d ON d.id = f.document_id
            WHERE f.response_id = $1 ORDER BY f.id`, [r.id]),
    query(`SELECT value AS name FROM settings WHERE key = 'company_name'`),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    data: {
      questionnaire: about.questionnaire, service: about.service, client_name: about.client_name, requested_by: about.requested_by,
      seller: seller?.name || 'Cetizion Verifica',
      definition: r.definition, answers: r.answers, current_step: r.current_step,
      status: r.status, submitted: r.status === 'submitted', submitted_at: r.submitted_at, submitted_by_name: r.submitted_by_name,
      expires_at: r.expires_at, files,
    },
  });
});

/** The response again, locked, for a write: the link still good and the response still open. */
async function openForWrite(db, token) {
  const l = await openLink(token);
  const { rows: [r] } = await db.query(
    `SELECT r.*, v.definition FROM questionnaire_responses r JOIN questionnaire_versions v ON v.id = r.version_id WHERE r.id = $1 FOR UPDATE OF r`, [l.id]);
  if (!OPEN_STATUSES.includes(r.status)) throw new ApiError(409, 'This questionnaire has been submitted. Ask us to reopen it if something needs changing.');
  return r;
}

const saveSchema = z.object({ step: z.number().int().min(0).max(50).optional(), answers: z.record(z.string(), z.any()) }).strict();

publicQuestionnaireRouter.put('/:token/answers', writes, async (req, res) => {
  const parsed = saveSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check your answers');
  const saved = await transaction(async (db) => {
    const r = await openForWrite(db, req.params.token);
    const { values, errors } = await keepAnswers(db, r, parsed.data.answers);
    if (Object.keys(errors).length) throw new ApiError(422, 'Please check the highlighted answers', { fields: errors });
    const steps = r.definition.steps?.length || 1;
    const step = Math.min(parsed.data.step ?? r.current_step, steps - 1);
    await db.query(
      `UPDATE questionnaire_responses SET answers = $2, current_step = $3, status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END WHERE id = $1`,
      [r.id, JSON.stringify(values), step]);
    return { current_step: step };
  });
  res.json({ data: { saved: true, ...saved } });
});

publicQuestionnaireRouter.post('/:token/files', writes, oneFile('file'), async (req, res) => {
  const out = await transaction(async (db) => {
    const r = await openForWrite(db, req.params.token);
    return storeResponseFile(db, r, { questionKey: String(req.body?.question_key || ''), file: req.file, uploadedBy: 'client' });
  });
  res.status(201).json({ data: out });
});

const submitSchema = z.object({
  name: z.string().trim().min(1, 'Your name, please').max(200),
  email: z.string().trim().toLowerCase().email('Your email address, please').max(200),
  answers: z.record(z.string(), z.any()).optional(),
}).strict();

publicQuestionnaireRouter.post('/:token/submit', writes, async (req, res) => {
  const parsed = submitSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const l = await openLink(req.params.token);
  await submitResponse(l.id, { answers: parsed.data.answers, name: parsed.data.name, email: parsed.data.email, filledBy: 'client' });
  res.json({ data: { submitted: true, message: 'Thank you. Your answers are with our team, who will be in touch with your quotation.' } });
});
