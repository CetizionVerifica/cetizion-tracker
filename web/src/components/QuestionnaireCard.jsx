import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CircleAlert, Copy, Info, Link2, Send, TriangleAlert } from 'lucide-react';
import { Modal, useToast } from './ui.jsx';
import { QuestionnaireForm, answerText, rowsText, visible } from './QuestionnaireForm.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';

/**
 * The questionnaire on an enquiry (#208 phase 1, §3.2): send it, see where
 * the client is, remind, revoke, reopen, fill it in for them on a call,
 * and read the answers. Enquiries have no page of their own, so this opens
 * from the enquiry list's Questionnaire column; the deal it became shows
 * the same answers, read-only, in its Questionnaire tab.
 *
 * Wave 3 (Mocha Glass): the Enquiries Q* boards and the Deal's tab.
 * Classes in styles/mocha/questionnaire.css (`qn-*`).
 */
export const RESPONSE_LABEL = { not_started: 'Not started', in_progress: 'In progress', submitted: 'Submitted', reopened: 'Reopened', withdrawn: 'Withdrawn' };
const RESPONSE_TONE = { not_started: 'info', in_progress: 'wait', submitted: 'ok', reopened: 'wait', withdrawn: 'plain' };
const OPEN = ['not_started', 'in_progress', 'reopened'];
/** Where the client's links stand, in words. */
function linkWords(r) {
  if (r.link_state === 'sent' || r.link_state === 'opened') {
    return `Open until ${date(r.expires_at)}${r.link_state === 'opened' ? '' : ', not opened yet'}`;
  }
  return { expired: 'Expired', revoked: 'Revoked', none: 'None yet' }[r.link_state] || r.link_state;
}
const progressWords = (r) => (r.status === 'submitted'
  ? `Submitted ${date(r.submitted_at)} by ${r.submitted_by_name || 'the client'}${r.filled_by === 'staff' ? ' (filled in by staff)' : ''}`
  : r.status === 'not_started' ? 'Not started' : `Step ${r.current_step + 1} of ${r.step_count}`);

export function QuestionnaireBadge({ status }) {
  return status ? <span className={`mg-badge mg-badge--${RESPONSE_TONE[status] || 'plain'}`}>{RESPONSE_LABEL[status] || status}</span> : null;
}

function Banner({ tone = 'info', title, children, actions, role }) {
  const Icon = tone === 'late' ? CircleAlert : tone === 'wait' ? TriangleAlert : Info;
  return (
    <div className={`mg-banner${tone === 'info' ? '' : ` mg-banner--${tone}`}`} role={role || (tone === 'late' ? 'alert' : 'status')}>
      <Icon aria-hidden="true" />
      <div className="mg-banner__body">
        {title && <strong>{title}</strong>}
        {children}
        {actions && <span className="qn-banner__acts">{actions}</span>}
      </div>
    </div>
  );
}

function Skel() {
  return (
    <div className="qn-stack" aria-busy="true" aria-label="Loading the questionnaire">
      <div className="mg-skel" style={{ height: 22, width: '55%' }} />
      <div className="mg-skel" style={{ height: 56 }} />
      <div className="mg-skel" style={{ height: 96 }} />
    </div>
  );
}

/** Badge, name, version; then the four facts. */
function Summary({ r }) {
  return (
    <>
      <div className="qn-title">
        <QuestionnaireBadge status={r.status} />
        <strong>{r.questionnaire_name}</strong>
        <span className="qn-meta">version {r.version}</span>
      </div>
      <dl className="mg-facts qn-facts">
        <div><dt>Link</dt><dd>{linkWords(r)}</dd></div>
        <div><dt>Sent to</dt><dd>{r.last_sent_to ? `${r.last_sent_to} on ${date(r.last_sent_at)}` : 'Not emailed (link only)'}{r.reminders ? ` · ${r.reminders} reminder${r.reminders === 1 ? '' : 's'}` : ''}</dd></div>
        <div><dt>Progress</dt><dd>{progressWords(r)}</dd></div>
        <div><dt>First opened</dt><dd>{r.first_opened_at ? new Date(r.first_opened_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not yet'}</dd></div>
      </dl>
    </>
  );
}

function Differences({ r, action }) {
  if (!r.differences?.length) return null;
  return (
    <Banner tone="wait" title={`${r.differences.length === 1 ? 'One answer differs' : `${r.differences.length} answers differ`} from our records.`}
      actions={r.company_id && action}>
      {r.differences.map((d) => `${d.label}: "${d.now}" (we have ${d.was ? `"${d.was}"` : 'nothing'})`).join('. ')}. Nothing changes until you choose.
    </Banner>
  );
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

  const open = r && OPEN.includes(r.status);
  const sendView = !latest || sending;
  let body;
  if (list.loading && !list.data) body = <Skel />;
  else if (list.error) {
    body = <Banner tone="late" title="The questionnaire could not be loaded." actions={<button type="button" className="mg-btn mg-btn--sm" onClick={list.refetch}>Try again</button>}>{list.error}</Banner>;
  } else if (sendView) {
    body = (
      <SendForm enquiry={enquiry} again={latest} onCancel={latest ? () => setSending(false) : null}
        onSent={(res) => { setSending(false); setLink(res.url); refresh(); toast(res.email ? `Sent to ${res.email.to}${res.email.status === 'sent' ? '' : ` (${res.email.status})`}` : 'Link created', 'success'); }} />
    );
  } else if (!r) {
    body = detail.error
      ? <Banner tone="late" title="The questionnaire could not be loaded." actions={<button type="button" className="mg-btn mg-btn--sm" onClick={detail.refetch}>Try again</button>}>{detail.error}</Banner>
      : <Skel />;
  } else {
    const dead = open && (r.link_state === 'expired' || r.link_state === 'revoked');
    body = (
      <div className="qn-stack">
        <Summary r={r} />
        {link && (
          <Banner title="New link ready. " actions={<button type="button" className="mg-btn mg-btn--sm" onClick={() => copy(link)}><Copy aria-hidden="true" />Copy</button>}>
            Copy it into WhatsApp or an email.
            <span className="qn-link" data-testid="questionnaire-link">{link}</span>
          </Banner>
        )}
        {dead && !link && (
          <Banner tone="wait" title={r.link_state === 'expired' ? 'The client’s link has expired. ' : 'The client’s links were revoked. '}>
            They can no longer open it. Make a new link to let them carry on, or fill it in for them.
          </Banner>
        )}
        {r.status === 'reopened' && <Banner title="Reopened for changes. ">The client can change their answers and submit again.</Banner>}
        <div className="qn-acts">
          {open && <button type="button" className="mg-btn mg-btn--sm mg-btn--primary" disabled={busy} onClick={() => setFilling(true)}>Fill in for the client</button>}
          {open && <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => act('link', {}, 'New link ready to copy')}><Link2 aria-hidden="true" />Make a new link</button>}
          {open && r.link_state !== 'none' && r.last_sent_to && <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => act('remind', {}, (d) => `Reminder sent to ${d.email?.to}`)}>Remind</button>}
          {open && r.open_links > 0 && <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" disabled={busy} onClick={() => act('revoke', {}, 'Links revoked: the client can no longer open it')}>Revoke links</button>}
          {r.status === 'submitted' && <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => act('reopen', {}, 'Reopened: the client can change their answers')}>Reopen for changes</button>}
          <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" disabled={busy} onClick={() => setSending(true)}>Send another</button>
        </div>
        <Differences r={r} action={<Link className="mg-btn mg-btn--sm" to={`/companies/${r.company_id}`}>Review on the company page</Link>} />
        <hr className="qn-rule" />
        <h3 className="qn-h">{r.status === 'submitted' ? 'Answers' : 'Answers so far'}</h3>
        <Answers response={r} />
      </div>
    );
  }

  return (
    <>
      <Modal
        title={`Questionnaire · ${enquiry.enquiry_no}`}
        subtitle={enquiry.client_name ? `${enquiry.client_name}${enquiry.service ? ` · ${enquiry.service}` : ''}` : undefined}
        size={sendView ? '' : 'lg'}
        onClose={onClose}
        footer={<button type="button" className="mg-btn mg-btn--ghost" onClick={onClose}>Close</button>}
      >
        {body}
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
function Answers({ response: r, columns = false }) {
  const steps = r.definition?.steps || [];
  const byKey = new Map(steps.flatMap((s) => s.questions).map((q) => [q.key, q]));
  const names = Object.fromEntries((r.files || []).map((f) => [f.document_id, f.file_name]));
  if (!Object.keys(r.answers || {}).length) {
    return <p className="qn-meta">No answers yet. They show here as the client fills it in, step by step.</p>;
  }
  return (
    <div className={columns ? 'qn-ans-cols' : 'qn-stack'}>
      {steps.map((s) => {
        const shown = s.questions.filter((q) => q.type !== 'info' && visible(q, r.answers, byKey) && r.answers[q.key] !== undefined);
        if (!shown.length) return null;
        return (
          <section key={s.key} className="qn-ans" aria-label={s.title}>
            <h4>{s.title}</h4>
            <dl>
              {shown.map((q) => (
                <div key={q.key}>
                  <dt>{q.label}</dt>
                  <dd>
                    {q.type === 'table'
                      ? <ul className="qn-lines">{rowsText(q, r.answers[q.key]).map((t, i) => <li key={i}>{t}</li>)}</ul>
                      : q.type === 'file'
                        ? r.answers[q.key].map((id) => <div key={id}><a className="qn-a" href={api.documentUrl(id)} target="_blank" rel="noopener noreferrer">{names[id] || 'File'}</a></div>)
                        : answerText(q, r.answers[q.key], names)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

/** Choose the questionnaire, the address and a note; email it, or just make a link to copy. */
function SendForm({ enquiry, again, onCancel, onSent }) {
  const toast = useToast();
  const { isAdmin } = useAuth() || {};
  const forms = useFetch(() => api.raw('/questionnaires'), []);
  const published = (forms.data?.data || []).filter((q) => q.active && q.published);
  const guess = published.find((q) => q.service_name === enquiry.service) || published[0];
  const [v, setV] = useState({ questionnaire_id: '', to: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [failed, setFailed] = useState(null);
  const chosen = v.questionnaire_id || (guess ? String(guess.id) : '');

  async function send(sendEmail) {
    setBusy(sendEmail ? 'email' : 'link'); setErrors({}); setFailed(null);
    try {
      const res = await api.action('/questionnaire-responses', { enquiry_no: enquiry.enquiry_no, questionnaire_id: Number(chosen), to: v.to || undefined, message: v.message || undefined, send_email: sendEmail });
      onSent(res.data);
    } catch (err) {
      setErrors(err.fields || {});
      if (!err.fields) setFailed(err.message);
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
    } finally { setBusy(false); }
  }

  if (forms.loading && !forms.data) return <Skel />;
  if (forms.error) {
    return <Banner tone="late" title="The questionnaires could not be loaded." actions={<button type="button" className="mg-btn mg-btn--sm" onClick={forms.refetch}>Try again</button>}>{forms.error}</Banner>;
  }
  if (!published.length) {
    return (
      <Banner title="No questionnaire is published for this service yet. "
        actions={isAdmin && <Link className="mg-btn mg-btn--sm" to="/settings/templates">Open Templates</Link>}>
        {isAdmin
          ? 'An admin builds one per service in Settings › Templates › Questionnaires, then publishes it so it can be sent.'
          : 'An admin builds one per service in Settings › Templates › Questionnaires. Ask an admin to publish one, then send it from here.'}
      </Banner>
    );
  }
  const contact = enquiry.contact_email;
  return (
    <div className="qn-stack">
      {again && OPEN.includes(again.status) && (
        <Banner tone="wait" title="Sending another withdraws the one not yet submitted. ">
          Its links stop working{again.status === 'in_progress' ? `, and what the client has answered so far (step ${again.current_step + 1} of ${again.step_count}) is set aside` : ''}. To reach a different address with the same questionnaire, use Make a new link instead.
        </Banner>
      )}
      <p className="qn-lead">The client gets a link to a short form for this service. Their answers come back here, and you are told when they submit.</p>
      {failed && <Banner tone="late" title="Nothing was sent. ">{failed}</Banner>}
      <div className={`mg-field${errors.questionnaire_id ? ' is-error' : ''}`}>
        <label className="mg-field__label" htmlFor="qn-send-which">Questionnaire<span className="req" aria-hidden="true">*</span></label>
        <span className="mg-select-wrap">
          <select id="qn-send-which" className="mg-select" value={chosen} onChange={(e) => setV({ ...v, questionnaire_id: e.target.value })} aria-invalid={errors.questionnaire_id ? true : undefined}>
            {published.map((q) => <option key={q.id} value={String(q.id)}>{`${q.name} (${q.service_name})`}</option>)}
          </select>
        </span>
        {errors.questionnaire_id ? <span className="mg-field__error">{errors.questionnaire_id}</span> : <span className="mg-field__hint">Picked from the service asked for; change it if needed</span>}
      </div>
      <div className={`mg-field${errors.to ? ' is-error' : ''}`}>
        <label className="mg-field__label" htmlFor="qn-send-to">Send to</label>
        <input id="qn-send-to" className="mg-input" type="email" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} placeholder={contact || 'client@company.com'} aria-invalid={errors.to ? true : undefined} />
        {errors.to ? <span className="mg-field__error">{errors.to}</span> : <span className="mg-field__hint">{contact ? `Blank: ${contact}, the enquiry contact` : 'Blank: the enquiry\'s contact'}</span>}
      </div>
      <div className="mg-field">
        <label className="mg-field__label" htmlFor="qn-send-note">A note to the client</label>
        <textarea id="qn-send-note" className="mg-textarea" rows={3} value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} />
        <span className="mg-field__hint">Optional; printed in the email as you type it</span>
      </div>
      <div className="qn-acts qn-acts--end">
        {onCancel && <button type="button" className="mg-btn mg-btn--ghost qn-acts__left" disabled={Boolean(busy)} onClick={onCancel}>Cancel</button>}
        <button type="button" className="mg-btn" disabled={Boolean(busy) || !chosen} onClick={() => send(false)}><Link2 aria-hidden="true" />{busy === 'link' ? 'Making the link…' : 'Make a link only'}</button>
        <button type="button" className="mg-btn mg-btn--primary" disabled={Boolean(busy) || !chosen} onClick={() => send(true)}><Send aria-hidden="true" />{busy === 'email' ? 'Sending…' : 'Email it'}</button>
      </div>
    </div>
  );
}

/**
 * The Deal's Questionnaire tab (Wave 3): the enquiry's questionnaire,
 * read-only, with a way back to the enquiry to act on it.
 */
export function QuestionnaireTab({ enquiryNo }) {
  const list = useFetch(() => api.raw(`/questionnaire-responses?enquiry=${encodeURIComponent(enquiryNo)}`), [enquiryNo]);
  const latest = (list.data?.data || []).find((x) => x.status !== 'withdrawn');
  const detail = useFetch(() => (latest ? api.raw(`/questionnaire-responses/${latest.id}`) : Promise.resolve(null)), [latest?.id]);
  const r = detail.data?.data;
  const to = `/enquiries?q=${encodeURIComponent(enquiryNo)}&questionnaire=1`;
  const openIt = <Link className="mg-btn mg-btn--sm qn-tab__open" to={to}>Open it on {enquiryNo}<ChevronRight aria-hidden="true" /></Link>;
  const error = list.error || detail.error;

  if ((list.loading && !list.data) || (latest && !r && !error)) return <Skel />;
  if (error) return <Banner tone="late" title="The questionnaire could not be loaded." actions={<button type="button" className="mg-btn mg-btn--sm" onClick={() => { list.refetch(); detail.refetch(); }}>Try again</button>}>{error}</Banner>;
  if (!latest) {
    return (
      <div className="mg-empty">
        <span className="mg-empty__mark" aria-hidden="true"><Send size={22} strokeWidth={1.8} /></span>
        <strong>No questionnaire was sent</strong>
        <p className="mg-empty__text">Enquiry {enquiryNo} has no service questionnaire. Send one from the enquiry to have the client's answers show here.</p>
        <Link className="mg-btn mg-btn--sm" to={to}>Send it from {enquiryNo}</Link>
      </div>
    );
  }
  const submitted = r.status === 'submitted';
  return (
    <div className="qn-stack">
      <div className="qn-title">
        <QuestionnaireBadge status={r.status} />
        <h2 className="mg-panel__title">{r.questionnaire_name}</h2>
        <span className="mg-panel__hint">version {r.version}</span>
        {openIt}
      </div>
      <p className="qn-lead">
        {submitted
          ? `${r.submitted_by_name || 'The client'} submitted it on ${date(r.submitted_at)}. It came with enquiry ${enquiryNo}; the answers below are read-only here.`
          : `${progressWords(r)}. It came with enquiry ${enquiryNo}: remind, fill in or reopen it there. The answers so far are read-only here.`}
      </p>
      <Differences r={r} action={<Link className="mg-btn mg-btn--sm" to={`/companies/${r.company_id}`}>Review on the company page</Link>} />
      <Answers response={r} columns />
    </div>
  );
}
