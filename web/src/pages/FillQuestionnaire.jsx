import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Clock, FileText, Link2, Lock } from 'lucide-react';
import { ClientHeader, ClientPage, useEnter } from '../components/client.jsx';
import { QuestionnaireForm } from '../components/QuestionnaireForm.jsx';

/**
 * The page a client opens from a questionnaire link (#208 phase 1, §3.1).
 *
 * No sign-in and no app chrome, like the acceptance page (#53): one form,
 * read on a phone by somebody who has never seen this system. It saves as
 * they go, so the same link picks up where they stopped; after they submit
 * it shows their answers, read-only, and who will be in touch.
 *
 * Wave 9 (Mocha Glass): the client header, one glass card, step bars, and
 * a calm card for a dead link, too many requests or a failed load.
 */
const BASE = '/api/public/questionnaire';

async function call(path, { method = 'GET', body, form } = {}) {
  const r = await fetch(`${BASE}/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : form,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(json.error?.message || 'Something went wrong. Please try again.');
    e.status = r.status;
    e.fields = json.error?.fields;
    throw e;
  }
  return json.data;
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

/** A page that has nothing to fill: dead link, too many requests, a failed load, no questions. */
function Gone({ icon: Icon, tone, title, text, onRetry, badge }) {
  return (
    <ClientPage plain>
      <ClientHeader sub="Questionnaire" badge={badge} />
      <div className="cl-dead">
        <main className={`mg-glass mg-glass--strong mg-empty qn-gone`} role={tone === 'late' ? 'alert' : 'status'}>
          <span className={`mg-empty__mark${tone ? ` cl-ico--${tone}` : ''}`}><Icon size={24} strokeWidth={1.8} aria-hidden="true" /></span>
          <h1 className="mg-display">{title}</h1>
          <p className="mg-empty__text" style={{ fontSize: 14 }}>{text}</p>
          {onRetry && <button type="button" className="mg-btn" style={{ marginTop: 6 }} onClick={onRetry}>Try again</button>}
        </main>
      </div>
    </ClientPage>
  );
}

export default function FillQuestionnaire({ token }) {
  const [state, setState] = useState({ loading: true });
  const [done, setDone] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const ref = useEnter(state.loading ? null : done ? 'thanks' : state.data ? 'form' : 'dead');

  useEffect(() => {
    call(token).then((data) => setState({ data })).catch((e) => setState({ dead: e.message, status: e.status }));
  }, [token, attempt]);
  const retry = () => { setState({ loading: true }); setAttempt((n) => n + 1); };

  if (state.loading) {
    return (
      <ClientPage plain>
        <ClientHeader sub="Questionnaire" />
        <main className="mg-glass mg-glass--strong qn-card" aria-busy="true" aria-label="Loading the questionnaire">
          <div className="mg-skel" style={{ height: 14, width: '30%' }} />
          <div className="mg-skel" style={{ height: 34, width: '70%' }} />
          <div className="mg-skel" style={{ height: 120 }} />
          <span className="cl-meta">Opening your questionnaire…</span>
        </main>
      </ClientPage>
    );
  }
  if (state.dead) {
    if (state.status === 429) return <Gone icon={Clock} tone="wait" title="Too many requests" text="Too many changes in a short time. Please wait a few minutes, then open the link again. Your saved answers are safe." onRetry={retry} />;
    if (!state.status || state.status >= 500) return <Gone icon={CircleAlert} tone="late" title="Something went wrong" text={`${state.dead} Your saved answers are safe.`} onRetry={retry} />;
    return <Gone icon={Link2} tone="wait" title="This link is not available" text={`${state.dead} If you were expecting a questionnaire, reply to the email that brought you here and we will send a fresh link.`} />;
  }
  const d = state.data;
  if (!d.definition?.steps?.length) {
    return <Gone icon={FileText} title="Nothing to answer yet" text="This questionnaire has no questions yet. We will send the link again once it is ready." badge={d.client_name ? `For ${d.client_name}` : undefined} />;
  }

  const header = (
    <div className="qn-head">
      {d.seller && <span className="mg-eyebrow">{d.seller}</span>}
      <h1 className="mg-display">{d.questionnaire}</h1>
      <p>For {d.client_name || 'you'}{d.requested_by ? ` · requested by ${d.requested_by}` : ''}</p>
    </div>
  );
  const foot = (
    <p className="qn-foot"><Lock aria-hidden="true" />This link works until {fmtDate(d.expires_at)}. Your answers are used only to prepare your quotation.</p>
  );

  return (
    <ClientPage plain rootRef={ref}>
      <ClientHeader sub="Questionnaire" badge={d.client_name ? `For ${d.client_name}` : undefined} />
      <main className="mg-glass mg-glass--strong qn-card" data-a="rise">
        {done ? (
          <>
            {header}
            <div className="mg-empty qn-thanks" role="status">
              <span className="mg-empty__mark cl-ico--ok"><CircleCheck size={30} strokeWidth={1.8} aria-hidden="true" /></span>
              <strong className="qn-thanks__title">Thank you</strong>
              <p className="mg-empty__text">{done}</p>
            </div>
          </>
        ) : d.submitted ? (
          <>
            {header}
            <div className="mg-banner mg-banner--ok" role="status">
              <CircleCheck aria-hidden="true" />
              <div className="mg-banner__body">
                <strong>Submitted on {fmtDate(d.submitted_at)}{d.submitted_by_name ? ` by ${d.submitted_by_name}` : ''}.</strong>
                If something needs changing, reply to our email and we will reopen it for you.
              </div>
            </div>
            <QuestionnaireForm definition={d.definition} initialAnswers={d.answers} files={d.files} readOnly />
          </>
        ) : (
          <>
            {header}
            <QuestionnaireForm
              definition={d.definition}
              initialAnswers={d.answers}
              initialStep={d.current_step}
              files={d.files}
              onSave={(step, answers) => call(`${token}/answers`, { method: 'PUT', body: { step, answers } })}
              onUpload={(questionKey, file) => { const form = new FormData(); form.set('question_key', questionKey); form.set('file', file); return call(`${token}/files`, { method: 'POST', form }); }}
              onSubmit={async ({ answers, name, email }) => { const r = await call(`${token}/submit`, { method: 'POST', body: { answers, name, email } }); setDone(r.message); }}
            />
            {foot}
          </>
        )}
      </main>
    </ClientPage>
  );
}
