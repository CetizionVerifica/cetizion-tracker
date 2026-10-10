import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { QuestionnaireForm, answerText, visible } from './QuestionnaireForm.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';

/**
 * The questionnaire on an enquiry (#208 phase 1, §3.2): send it, see where
 * the client is, remind, revoke, reopen, fill it in for them on a call,
 * and read the answers. Enquiries have no page of their own, so this opens
 * from the enquiry list's Questionnaire column.
 */
export const RESPONSE_LABEL = { not_started: 'Not started', in_progress: 'In progress', submitted: 'Submitted', reopened: 'Reopened', withdrawn: 'Withdrawn' };
const RESPONSE_TONE = { not_started: 'info', in_progress: 'warning', submitted: 'success', reopened: 'warning', withdrawn: 'neutral' };
/** Where the client's links stand, in words. */
function linkWords(r) {
  if (r.link_state === 'sent' || r.link_state === 'opened') {
    return `Open until ${date(r.expires_at)}${r.link_state === 'opened' ? '' : ', not opened yet'}`;
  }
  return { expired: 'Expired', revoked: 'Revoked', none: 'None yet' }[r.link_state] || r.link_state;
}

export function QuestionnaireBadge({ status }) {
  return status ? <Badge tone={RESPONSE_TONE[status]}>{RESPONSE_LABEL[status] || status}</Badge> : null;
}

export function QuestionnaireCard({ enquiry, onClose, onChanged }) {
  const toast = useToast();
  const list = useFetch(() => api.raw(`/questionnaire-responses?enquiry=${encodeURIComponent(enquiry.enquiry_no)}`), [enquiry.enquiry_no]);
  const latest = (list.data?.data || []).find((r) => r.status !== 'withdrawn');
  const [sending, setSending] = useState(false);
  const detail = useFetch(() => (latest ? api.raw(`/questionnaire-responses/${latest.id}`) : Promise.resolve(null)), [latest?.id]);
  const r = detail.data?.data;
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(null);
  const [filling, setFilling] = useState(false);
  const refresh = () => { list.refetch(); detail.refetch(); onChanged?.(); };

  async function act(path, body, ok) {
    setBusy(true);
    try {
      const res = await api.action(`/questionnaire-responses/${r.id}/${path}`, body);
      if (res.data?.url) setLink(res.data.url);
      toast(typeof ok === 'function' ? ok(res.data) : ok, 'success');
      refresh();
    } catch (err) { toast(err.message, 'danger'); } finally { setBusy(false); }
  }
  async function copy(url) {
    try { await navigator.clipboard.writeText(url); toast('Link copied', 'success'); } catch { /* the link is shown to copy by hand */ }
  }

  const open = r && ['not_started', 'in_progress', 'reopened'].includes(r.status);
  return (
    <>
      <Modal
        title={`Questionnaire · ${enquiry.enquiry_no}`}
        subtitle={enquiry.client_name ? `${enquiry.client_name}${enquiry.service ? ` · ${enquiry.service}` : ''}` : undefined}
        size="lg"
        onClose={onClose}
        footer={<button type="button" className="btn" onClick={onClose}>Close</button>}
      >
        {list.loading && !list.data ? <div className="skeleton" style={{ height: 120 }} /> : list.error ? <Alert tone="danger"><span>{list.error}</span></Alert> : (!latest || sending) ? (
          <SendForm enquiry={enquiry} again={Boolean(latest)} onCancel={latest ? () => setSending(false) : null}
            onSent={(res) => { setSending(false); setLink(res.url); refresh(); toast(res.email ? `Sent to ${res.email.to}${res.email.status === 'sent' ? '' : ` (${res.email.status})`}` : 'Link created', 'success'); }} />
        ) : !r ? <div className="skeleton" style={{ height: 120 }} /> : (
          <div className="stack">
            <div className="flex flex-wrap items-center gap-2">
              <QuestionnaireBadge status={r.status} />
              <span className="strong">{r.questionnaire_name}</span>
              <span className="small muted">version {r.version}</span>
            </div>
            <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
              <div><dt className="muted inline">Link: </dt><dd className="inline">{linkWords(r)}</dd></div>
              <div><dt className="muted inline">Sent to: </dt><dd className="inline">{r.last_sent_to ? `${r.last_sent_to} on ${date(r.last_sent_at)}` : 'not emailed (link only)'}{r.reminders ? ` · ${r.reminders} reminder${r.reminders === 1 ? '' : 's'}` : ''}</dd></div>
              <div><dt className="muted inline">Progress: </dt><dd className="inline">{r.status === 'submitted' ? `Submitted ${date(r.submitted_at)} by ${r.submitted_by_name || 'the client'}${r.filled_by === 'staff' ? ' (filled in by staff)' : ''}` : r.status === 'not_started' ? 'Not started' : `Step ${r.current_step + 1} of ${r.step_count}`}</dd></div>
              <div><dt className="muted inline">First opened: </dt><dd className="inline">{r.first_opened_at ? new Date(r.first_opened_at).toLocaleString() : 'not yet'}</dd></div>
            </dl>
            {link && (
              <Alert tone="info">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="mono small" style={{ wordBreak: 'break-all' }}>{link}</span>
                  <button type="button" className="btn btn--sm" onClick={() => copy(link)}>Copy</button>
                </span>
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              {open && <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => setFilling(true)}>Fill in for the client</button>}
              {open && <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act('link', {}, 'New link ready to copy')}>Copy a link</button>}
              {open && r.link_state !== 'none' && r.last_sent_to && <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act('remind', {}, (d) => `Reminder sent to ${d.email?.to}`)}>Remind</button>}
              {open && r.open_links > 0 && <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => act('revoke', {}, 'Links revoked: the client can no longer open it')}>Revoke links</button>}
              {r.status === 'submitted' && <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act('reopen', {}, 'Reopened: the client can change their answers')}>Reopen</button>}
              <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setSending(true)}>Send another</button>
            </div>
            {r.differences?.length > 0 && (
              <Alert tone="warning">
                <span>
                  The client's answers differ from our records:{' '}
                  {r.differences.map((d) => `${d.label}: "${d.now}" (we have ${d.was ? `"${d.was}"` : 'nothing'})`).join('; ')}.{' '}
                  {r.company_id && <Link to={`/companies/${r.company_id}`}>Update the company</Link>}
                </span>
              </Alert>
            )}
            <div className="strong">{r.status === 'submitted' ? 'Answers' : 'Answers so far'}</div>
            <Answers response={r} />
          </div>
        )}
      </Modal>
      {filling && r && (
        <Modal title={`Fill in · ${r.questionnaire_name}`} subtitle={`For ${enquiry.client_name || enquiry.enquiry_no}. Saved as you go; submit when the client has answered everything.`} size="lg" onClose={() => { setFilling(false); refresh(); }}>
          <QuestionnaireForm
            definition={r.definition}
            initialAnswers={r.answers}
            initialStep={r.current_step}
            files={r.files}
            askContact={false}
            submitLabel="Submit for the client"
            onSave={(step, answers) => api.raw(`/questionnaire-responses/${r.id}`, { method: 'PATCH', body: { step, answers } })}
            onUpload={async (questionKey, file) => { const form = new FormData(); form.set('question_key', questionKey); form.set('file', file); return (await api.upload(`/questionnaire-responses/${r.id}/files`, form)).data; }}
            onSubmit={async ({ answers }) => { await api.action(`/questionnaire-responses/${r.id}/submit`, { answers }); setFilling(false); toast('Submitted', 'success'); refresh(); }}
          />
        </Modal>
      )}
    </>
  );
}

/** The answers so far, grouped by step, with the client's files. */
function Answers({ response: r }) {
  const steps = r.definition?.steps || [];
  const byKey = new Map(steps.flatMap((s) => s.questions).map((q) => [q.key, q]));
  const names = Object.fromEntries((r.files || []).map((f) => [f.document_id, f.file_name]));
  if (!Object.keys(r.answers || {}).length) return <p className="small muted">No answers yet.</p>;
  return (
    <div className="stack">
      {steps.map((s) => {
        const shown = s.questions.filter((q) => q.type !== 'info' && visible(q, r.answers, byKey) && r.answers[q.key] !== undefined);
        if (!shown.length) return null;
        return (
          <section key={s.key}>
            <div className="strong" style={{ marginBottom: 6 }}>{s.title}</div>
            <table className="table">
              <tbody>
                {shown.map((q) => (
                  <tr key={q.key}>
                    <td className="muted" style={{ width: '40%' }}>{q.label}</td>
                    <td className="wrap">
                      {q.type === 'table'
                        ? <ul style={{ margin: 0, paddingLeft: 18 }}>{r.answers[q.key].map((row, i) => <li key={i}>{q.columns.filter((c) => row[c.key] !== undefined && row[c.key] !== '').map((c) => `${c.label}: ${answerText(c, row[c.key])}`).join(' · ')}</li>)}</ul>
                        : q.type === 'file'
                          ? r.answers[q.key].map((id) => <div key={id}><a href={api.documentUrl(id)} target="_blank" rel="noopener noreferrer">{names[id] || 'File'}</a></div>)
                          : answerText(q, r.answers[q.key], names)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

/** Choose the questionnaire, the address and a note; email it, or just make a link to copy. */
function SendForm({ enquiry, again, onCancel, onSent }) {
  const toast = useToast();
  const forms = useFetch(() => api.raw('/questionnaires'), []);
  const published = (forms.data?.data || []).filter((q) => q.active && q.published);
  const guess = published.find((q) => q.service_name === enquiry.service) || published[0];
  const [v, setV] = useState({ questionnaire_id: '', to: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const chosen = v.questionnaire_id || (guess ? String(guess.id) : '');

  async function send(sendEmail) {
    setBusy(true); setErrors({});
    try {
      const res = await api.action('/questionnaire-responses', { enquiry_no: enquiry.enquiry_no, questionnaire_id: Number(chosen), to: v.to || undefined, message: v.message || undefined, send_email: sendEmail });
      onSent(res.data);
    } catch (err) { setErrors(err.fields || {}); toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); } finally { setBusy(false); }
  }

  if (forms.loading && !forms.data) return <div className="skeleton" style={{ height: 100 }} />;
  if (!published.length) {
    return <Alert tone="info"><span>No questionnaire is published yet. An admin builds one per service in Settings › Templates › Questionnaires.</span></Alert>;
  }
  return (
    <div className="stack">
      {again && <Alert tone="warning"><span>Sending another withdraws the one not yet submitted: its links stop working.</span></Alert>}
      <p className="small muted">The client gets a link to a short form for this service. Their answers come back here, and you are told when they submit.</p>
      <div className="form-grid">
        <Field label="Questionnaire" required error={errors.questionnaire_id}>
          <Select value={chosen} placeholder={null} options={published.map((q) => ({ value: String(q.id), label: `${q.name} (${q.service_name})` }))} onChange={(e) => setV({ ...v, questionnaire_id: e.target.value })} />
        </Field>
        <Field label="Send to" hint={enquiry.contact_email ? `Blank: ${enquiry.contact_email}` : 'Blank: the enquiry\'s contact'} error={errors.to}>
          <Input type="email" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} placeholder={enquiry.contact_email || 'client@company.com'} />
        </Field>
        <div className="span-all">
          <Field label="A note to the client" hint="Optional; printed in the email as you type it">
            <Textarea rows={3} value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn--primary" disabled={busy || !chosen} onClick={() => send(true)}>{busy ? 'Sending…' : 'Email it'}</button>
        <button type="button" className="btn" disabled={busy || !chosen} onClick={() => send(false)}>Make a link only</button>
        {onCancel && <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
