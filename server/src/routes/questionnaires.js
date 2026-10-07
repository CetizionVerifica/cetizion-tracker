/**
 * Service questionnaires, the staff side (#208 phase 1).
 *
 *   Admin › Templates (admins write, everybody signed in reads)
 *     GET    /api/questionnaires                    every form, with its versions' state
 *     POST   /api/questionnaires                    { service_id, name } → with a first draft
 *     GET    /api/questionnaires/:id                the form and its versions
 *     PATCH  /api/questionnaires/:id                { name?, active? }
 *     POST   /api/questionnaires/:id/versions       a new draft, copied from the latest
 *     PATCH  /api/questionnaire-versions/:id        { definition } (a draft only)
 *     POST   /api/questionnaire-versions/:id/publish
 *     DELETE /api/questionnaire-versions/:id        (a draft only)
 *
 *   From an enquiry (its owner, or an admin)
 *     POST   /api/questionnaire-responses           { enquiry_no, questionnaire_id, to?, message?, send_email }
 *     GET    /api/questionnaire-responses?enquiry=  the responses of an enquiry
 *     GET    /api/questionnaire-responses/:id       answers, files, links, what differs from the records
 *     PATCH  /api/questionnaire-responses/:id       { step?, answers } staff filling in for the client
 *     POST   /api/questionnaire-responses/:id/files multipart { question_key, file }
 *     POST   /api/questionnaire-responses/:id/submit   { name?, email? } staff submitting what they filled
 *     POST   /api/questionnaire-responses/:id/link     a new link to copy (or email, with { to })
 *     POST   /api/questionnaire-responses/:id/remind   email the client a reminder now
 *     POST   /api/questionnaire-responses/:id/revoke   every open link stops working
 *     POST   /api/questionnaire-responses/:id/reopen   a submitted response is open again
 *
 * A response not reachable by the caller is the same 404 as one that does
 * not exist.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { assertRecordReachable, scopeOf } from '../auth/ownership.js';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { allQuestions, checkDefinition, prefillAnswers, prefillDifferences } from '../lib/questionnaireDefinition.js';
import { createLink, emailLink, keepAnswers, oneFile, OPEN_STATUSES, responseClause, storeResponseFile, submitResponse } from '../lib/questionnaires.js';

export const questionnaireRouter = Router();
export const questionnaireVersionRouter = Router();
export const questionnaireResponseRouter = Router();

const who = (req) => req.user?.username || req.user?.name || 'staff';
const fieldsOf = (error) => Object.fromEntries(error.issues.map((i) => [i.path.join('.') || 'body', i.message]));
const parse = (schema, body) => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: fieldsOf(r.error) });
  return r.data;
};
const intParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new ApiError(404, 'Not found'); return n; };

// ------------------------------------------------------------ the forms (Admin › Templates)

questionnaireRouter.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT q.id, q.service_id, s.name AS service_name, q.name, q.active, q.updated_at,
            (SELECT json_build_object('id', v.id, 'version', v.version, 'published_at', v.published_at)
               FROM questionnaire_versions v WHERE v.questionnaire_id = q.id AND v.status = 'published') AS published,
            (SELECT json_build_object('id', v.id, 'version', v.version, 'updated_at', v.updated_at)
               FROM questionnaire_versions v WHERE v.questionnaire_id = q.id AND v.status = 'draft' ORDER BY v.version DESC LIMIT 1) AS draft,
            (SELECT count(*)::int FROM questionnaire_responses r JOIN questionnaire_versions v ON v.id = r.version_id WHERE v.questionnaire_id = q.id) AS responses
       FROM questionnaires q JOIN services s ON s.id = q.service_id
      ORDER BY s.sort_order, s.name, q.name`);
  res.json({ data: rows });
});

const formSchema = z.object({
  service_id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Give it a name').max(200),
});

questionnaireRouter.post('/', requireAdmin, async (req, res) => {
  const v = parse(formSchema, req.body);
  const created = await transaction(async (db) => {
    const { rows: [s] } = await db.query('SELECT id FROM services WHERE id = $1', [v.service_id]);
    if (!s) throw new ApiError(422, 'Please check the highlighted fields', { fields: { service_id: 'Choose a service' } });
    const { rows: [q] } = await db.query(
      `INSERT INTO questionnaires (service_id, name, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (service_id, name) DO NOTHING RETURNING id`, [v.service_id, v.name, who(req)]);
    if (!q) throw new ApiError(422, 'Please check the highlighted fields', { fields: { name: 'This service already has a questionnaire by that name' } });
    await db.query(
      `INSERT INTO questionnaire_versions (questionnaire_id, version, definition, created_by)
       VALUES ($1, 1, $2, $3)`, [q.id, JSON.stringify({ steps: [{ key: 'about_you', title: 'About you', questions: [] }] }), who(req)]);
    return q;
  });
  res.status(201).json({ data: await formWithVersions(created.id) });
});

async function formWithVersions(id) {
  const { rows: [q] } = await query(
    `SELECT q.*, s.name AS service_name FROM questionnaires q JOIN services s ON s.id = q.service_id WHERE q.id = $1`, [id]);
  if (!q) throw new ApiError(404, 'Questionnaire not found');
  const { rows: versions } = await query(
    `SELECT v.id, v.version, v.status, v.definition, v.published_at, v.published_by, v.created_at, v.updated_at,
            (SELECT count(*)::int FROM questionnaire_responses r WHERE r.version_id = v.id) AS responses
       FROM questionnaire_versions v WHERE v.questionnaire_id = $1 ORDER BY v.version DESC`, [id]);
  return { ...q, versions: versions.map((v) => ({ ...v, problems: v.status === 'draft' ? checkDefinition(v.definition).errors : [] })) };
}

questionnaireRouter.get('/:id', async (req, res) => {
  res.json({ data: await formWithVersions(intParam(req.params.id)) });
});

questionnaireRouter.patch('/:id', requireAdmin, async (req, res) => {
  const v = parse(z.object({ name: formSchema.shape.name.optional(), active: z.boolean().optional() }).strict(), req.body);
  const id = intParam(req.params.id);
  const { rowCount } = await query(
    'UPDATE questionnaires SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1', [id, v.name ?? null, v.active ?? null])
    .catch((err) => { if (err.code === '23505') throw new ApiError(422, 'Please check the highlighted fields', { fields: { name: 'This service already has a questionnaire by that name' } }); throw err; });
  if (!rowCount) throw new ApiError(404, 'Questionnaire not found');
  res.json({ data: await formWithVersions(id) });
});

// A new draft starts from the latest version, so editing a published form never touches it.
questionnaireRouter.post('/:id/versions', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id);
  await transaction(async (db) => {
    const { rows: [q] } = await db.query('SELECT id FROM questionnaires WHERE id = $1 FOR UPDATE', [id]);
    if (!q) throw new ApiError(404, 'Questionnaire not found');
    const { rows: [draft] } = await db.query(`SELECT id FROM questionnaire_versions WHERE questionnaire_id = $1 AND status = 'draft'`, [id]);
    if (draft) return;
    await db.query(
      `INSERT INTO questionnaire_versions (questionnaire_id, version, definition, pricing, created_by)
       SELECT $1, max(version) + 1, (array_agg(definition ORDER BY version DESC))[1], (array_agg(pricing ORDER BY version DESC))[1], $2
         FROM questionnaire_versions WHERE questionnaire_id = $1`, [id, who(req)]);
  });
  res.status(201).json({ data: await formWithVersions(id) });
});

// ------------------------------------------------------------ versions

/** A draft may be saved half-built; what it lacks is listed, and publishing waits for it. */
const draftSchema = z.object({
  definition: z.object({ intro: z.string().max(4000).optional(), steps: z.array(z.any()).max(20) }).passthrough(),
}).strict();

async function draftVersion(db, id) {
  const { rows: [v] } = await db.query('SELECT * FROM questionnaire_versions WHERE id = $1 FOR UPDATE', [id]);
  if (!v) throw new ApiError(404, 'Version not found');
  if (v.status !== 'draft') throw new ApiError(409, `Version ${v.version} is ${v.status}: make a new version to change it`);
  return v;
}

questionnaireVersionRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { definition } = parse(draftSchema, req.body);
  const text = JSON.stringify(definition);
  if (text.length > 400_000) throw new ApiError(422, 'This questionnaire is too large');
  const id = intParam(req.params.id);
  await transaction(async (db) => {
    await draftVersion(db, id);
    await db.query('UPDATE questionnaire_versions SET definition = $2 WHERE id = $1', [id, text]);
  });
  res.json({ data: { id, problems: checkDefinition(definition).errors } });
});

questionnaireVersionRouter.post('/:id/publish', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id);
  const published = await transaction(async (db) => {
    const v = await draftVersion(db, id);
    const check = checkDefinition(v.definition);
    if (!check.ok) throw new ApiError(422, 'This questionnaire is not ready to publish', { problems: check.errors });
    if (!allQuestions(check.definition).length) throw new ApiError(422, 'Add at least one question before publishing', { problems: ['No questions yet'] });
    await db.query(`UPDATE questionnaire_versions SET status = 'retired' WHERE questionnaire_id = $1 AND status = 'published'`, [v.questionnaire_id]);
    // Stored as checked: trimmed, unknown fields refused.
    await db.query(`UPDATE questionnaire_versions SET definition = $2 WHERE id = $1`, [id, JSON.stringify(check.definition)]);
    await db.query(`UPDATE questionnaire_versions SET status = 'published', published_at = now(), published_by = $2 WHERE id = $1`, [id, who(req)]);
    return v.questionnaire_id;
  });
  res.json({ data: await formWithVersions(published) });
});

questionnaireVersionRouter.delete('/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id);
  await transaction(async (db) => {
    const v = await draftVersion(db, id);
    const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM questionnaire_versions WHERE questionnaire_id = $1', [v.questionnaire_id]);
    if (n === 1) throw new ApiError(409, 'A questionnaire keeps at least one version; switch it off instead');
    await db.query('DELETE FROM questionnaire_versions WHERE id = $1', [id]);
  });
  res.status(204).end();
});

// ------------------------------------------------------------ responses

/** A response the caller may reach, locked when `forUpdate`; the same 404 as one that does not exist. */
async function reachableResponse(req, id, db = { query }, { forUpdate = false } = {}) {
  const params = [id];
  const scope = responseClause(scopeOf(req), params, 'r');
  const { rows: [r] } = await db.query(
    `SELECT r.*, v.definition, v.status AS version_status FROM questionnaire_responses r JOIN questionnaire_versions v ON v.id = r.version_id
      WHERE r.id = $1 ${scope ? `AND ${scope}` : ''}${forUpdate ? ' FOR UPDATE OF r' : ''}`, params);
  if (!r) throw new ApiError(404, 'Questionnaire not found');
  return r;
}

const sendSchema = z.object({
  enquiry_no: z.string().trim().min(1).max(60),
  questionnaire_id: z.coerce.number().int().positive(),
  to: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().toLowerCase().email('An email address').max(200).optional()),
  message: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(2000).optional()),
  send_email: z.boolean().optional().default(true),
});

questionnaireResponseRouter.post('/', async (req, res) => {
  const v = parse(sendSchema, req.body);
  await assertRecordReachable(scopeOf(req), 'enquiry', v.enquiry_no);
  const result = await transaction(async (db) => {
    const { rows: [e] } = await db.query(
      `SELECT e.id, e.enquiry_no, e.company_id, e.contact_id, e.owner_user_id, ct.email AS contact_email
         FROM enquiries e LEFT JOIN contacts ct ON ct.id = e.contact_id WHERE e.enquiry_no = $1 FOR UPDATE OF e`, [v.enquiry_no]);
    if (!e) throw new ApiError(404, 'Enquiry not found');
    const { rows: [ver] } = await db.query(
      `SELECT v.id, v.definition FROM questionnaire_versions v JOIN questionnaires q ON q.id = v.questionnaire_id
        WHERE q.id = $1 AND q.active AND v.status = 'published'`, [v.questionnaire_id]);
    if (!ver) throw new ApiError(422, 'Please check the highlighted fields', { fields: { questionnaire_id: 'That questionnaire is not published' } });
    const to = v.to || e.contact_email || null;
    if (v.send_email && !to) throw new ApiError(422, 'Please check the highlighted fields', { fields: { to: 'The contact has no email: type the address to send it to' } });

    // One open questionnaire per enquiry: an earlier one not yet submitted is withdrawn, and its links stop.
    const { rows: earlier } = await db.query(
      `UPDATE questionnaire_responses SET status = 'withdrawn' WHERE enquiry_id = $1 AND status = ANY($2) RETURNING id`, [e.id, OPEN_STATUSES]);
    if (earlier.length) await db.query('UPDATE questionnaire_links SET revoked_at = now() WHERE response_id = ANY($1) AND revoked_at IS NULL', [earlier.map((x) => x.id)]);

    const { rows: [company] } = await db.query('SELECT name, gstin, address FROM companies WHERE id = $1', [e.company_id]);
    const { rows: [contact] } = await db.query('SELECT name, email, phone FROM contacts WHERE id = $1', [e.contact_id]);
    const answers = prefillAnswers(ver.definition, { company: company || {}, contact: contact || {} });
    const { rows: [r] } = await db.query(
      `INSERT INTO questionnaire_responses (version_id, enquiry_id, company_id, contact_id, answers, requested_by_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ver.id, e.id, e.company_id, e.contact_id, JSON.stringify(answers), req.user?.id ?? e.owner_user_id ?? null, who(req)]);
    if (v.send_email) {
      const { link, log } = await emailLink(db, { responseId: r.id, to, message: v.message || '', sentBy: who(req) });
      return { id: r.id, url: link.url, email: { status: log.status, to } };
    }
    const link = await createLink(db, { responseId: r.id, createdBy: who(req) });
    return { id: r.id, url: link.url, email: null };
  });
  res.status(201).json({ data: { ...(await responseView(req, result.id)), url: result.url, email: result.email } });
});

questionnaireResponseRouter.get('/', async (req, res) => {
  const enquiry = String(req.query.enquiry || '').trim();
  if (!enquiry) throw new ApiError(422, 'Name the enquiry');
  await assertRecordReachable(scopeOf(req), 'enquiry', enquiry);
  const { rows } = await query(
    `SELECT id, status, questionnaire_id, questionnaire_name, service_name, version, current_step, step_count, filled_by,
            submitted_at, submitted_by_name, link_state, expires_at, last_sent_at, last_sent_to, first_opened_at, reminders, created_at
       FROM v_questionnaire_responses WHERE enquiry_no = $1 ORDER BY created_at DESC, id DESC`, [enquiry]);
  res.json({ data: rows });
});

/** Everything staff see of a response. */
async function responseView(req, id) {
  const params = [id];
  const scope = responseClause(scopeOf(req), params, 'r');
  const { rows: [r] } = await query(`SELECT r.* FROM v_questionnaire_responses r WHERE r.id = $1 ${scope ? `AND ${scope}` : ''}`, params);
  if (!r) throw new ApiError(404, 'Questionnaire not found');
  const [{ rows: [v] }, { rows: links }, { rows: files }, { rows: [company] }, { rows: [contact] }] = await Promise.all([
    query('SELECT definition FROM questionnaire_versions WHERE id = $1', [r.version_id]),
    query(`SELECT id, sent_to, expires_at, revoked_at, first_opened_at, last_opened_at, open_count, reminder_count, created_by, created_at
             FROM questionnaire_links WHERE response_id = $1 ORDER BY created_at DESC`, [id]),
    query(`SELECT f.document_id, f.question_key, f.uploaded_by, f.created_at, d.file_name, d.content_type, d.size_bytes
             FROM questionnaire_response_files f JOIN documents d ON d.id = f.document_id WHERE f.response_id = $1 ORDER BY f.id`, [id]),
    query('SELECT id, name, gstin, address FROM companies WHERE id = $1', [r.company_id]),
    query('SELECT id, name, email, phone FROM contacts WHERE id = $1', [r.contact_id]),
  ]);
  return {
    ...r, definition: v.definition, links, files,
    differences: r.status === 'submitted' ? prefillDifferences(v.definition, r.answers, { company: company || {}, contact: contact || {} }) : [],
  };
}

questionnaireResponseRouter.get('/:id', async (req, res) => {
  res.json({ data: await responseView(req, intParam(req.params.id)) });
});

const answersSchema = z.object({ step: z.number().int().min(0).max(50).optional(), answers: z.record(z.string(), z.any()) }).strict();

questionnaireResponseRouter.patch('/:id', async (req, res) => {
  const v = parse(answersSchema, req.body);
  const id = intParam(req.params.id);
  await transaction(async (db) => {
    const r = await reachableResponse(req, id, db, { forUpdate: true });
    if (!OPEN_STATUSES.includes(r.status)) throw new ApiError(409, r.status === 'submitted' ? 'Submitted: reopen it to change the answers' : 'This questionnaire was withdrawn');
    const { values, errors } = await keepAnswers(db, r, v.answers);
    if (Object.keys(errors).length) throw new ApiError(422, 'Please check the highlighted answers', { fields: errors });
    const steps = r.definition.steps?.length || 1;
    await db.query(
      `UPDATE questionnaire_responses SET answers = $2, current_step = $3, status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END,
              filled_by = CASE WHEN filled_by = 'client' AND status = 'not_started' THEN 'staff' ELSE filled_by END WHERE id = $1`,
      [id, JSON.stringify(values), Math.min(v.step ?? r.current_step, steps - 1)]);
  });
  res.json({ data: await responseView(req, id) });
});

questionnaireResponseRouter.post('/:id/files', oneFile('file'), async (req, res) => {
  const id = intParam(req.params.id);
  const r = await reachableResponse(req, id);
  if (!OPEN_STATUSES.includes(r.status)) throw new ApiError(409, 'Reopen it to add files');
  res.status(201).json({ data: await storeResponseFile({ query }, r, { questionKey: String(req.body?.question_key || ''), file: req.file, uploadedBy: who(req) }) });
});

questionnaireResponseRouter.post('/:id/submit', async (req, res) => {
  const v = parse(z.object({ name: z.string().trim().max(200).optional(), email: z.string().trim().email().max(200).optional(), answers: z.record(z.string(), z.any()).optional() }).strict(), req.body);
  const id = intParam(req.params.id);
  await reachableResponse(req, id);
  await submitResponse(id, { answers: v.answers, name: v.name || req.user?.name || who(req), email: v.email || null, filledBy: 'staff' });
  res.json({ data: await responseView(req, id) });
});

questionnaireResponseRouter.post('/:id/link', async (req, res) => {
  const v = parse(z.object({ to: z.string().trim().toLowerCase().email('An email address').max(200).optional(), message: z.string().trim().max(2000).optional() }).strict(), req.body);
  const id = intParam(req.params.id);
  const out = await transaction(async (db) => {
    const r = await reachableResponse(req, id, db, { forUpdate: true });
    if (!OPEN_STATUSES.includes(r.status)) throw new ApiError(409, r.status === 'submitted' ? 'Submitted: reopen it first' : 'This questionnaire was withdrawn');
    if (v.to) { const { link, log } = await emailLink(db, { responseId: id, to: v.to, message: v.message || '', sentBy: who(req) }); return { url: link.url, email: { status: log.status, to: v.to } }; }
    const link = await createLink(db, { responseId: id, createdBy: who(req) });
    return { url: link.url, email: null };
  });
  res.status(201).json({ data: { ...(await responseView(req, id)), ...out } });
});

questionnaireResponseRouter.post('/:id/remind', async (req, res) => {
  const id = intParam(req.params.id);
  const out = await transaction(async (db) => {
    const r = await reachableResponse(req, id, db, { forUpdate: true });
    if (!OPEN_STATUSES.includes(r.status)) throw new ApiError(409, 'Only an open questionnaire can be reminded');
    const { rows: [last] } = await db.query(
      `SELECT sent_to, expires_at, reminder_count FROM questionnaire_links WHERE response_id = $1 AND sent_to IS NOT NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`, [id]);
    if (!last) throw new ApiError(409, 'No open link was emailed: send a new link instead');
    const { link, log } = await emailLink(db, { responseId: id, to: last.sent_to, reminder: true, sentBy: who(req), expiresAt: last.expires_at });
    await db.query('UPDATE questionnaire_links SET reminder_count = $2 WHERE id = $1', [link.id, Number(last.reminder_count || 0) + 1]);
    await db.query('UPDATE questionnaire_links SET reminded_at = now() WHERE response_id = $1 AND revoked_at IS NULL', [id]);
    return { email: { status: log.status, to: last.sent_to } };
  });
  res.json({ data: { ...(await responseView(req, id)), ...out } });
});

questionnaireResponseRouter.post('/:id/revoke', async (req, res) => {
  const id = intParam(req.params.id);
  await reachableResponse(req, id);
  await query('UPDATE questionnaire_links SET revoked_at = now() WHERE response_id = $1 AND revoked_at IS NULL', [id]);
  res.json({ data: await responseView(req, id) });
});

questionnaireResponseRouter.post('/:id/reopen', async (req, res) => {
  const id = intParam(req.params.id);
  await transaction(async (db) => {
    const r = await reachableResponse(req, id, db, { forUpdate: true });
    if (r.status !== 'submitted') throw new ApiError(409, 'Only a submitted questionnaire can be reopened');
    await db.query(`UPDATE questionnaire_responses SET status = 'reopened' WHERE id = $1`, [id]);
  });
  res.json({ data: await responseView(req, id) });
});
