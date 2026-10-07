import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '../components/ui/card.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { QuestionnaireForm } from '../components/QuestionnaireForm.jsx';

/**
 * The page a client opens from a questionnaire link (#208 phase 1, §3.1).
 *
 * No sign-in and no app chrome, like the acceptance page (#53): one form,
 * read on a phone by somebody who has never seen this system. It saves as
 * they go, so the same link picks up where they stopped; after they submit
 * it shows their answers, read-only, and who will be in touch.
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

function Sheet({ children }) {
  return (
    <div className="min-h-dvh bg-background px-4 py-10 sm:px-6 sm:py-16">
      <Card className="mx-auto w-full max-w-[720px] gap-0 rounded-[14px] py-0">
        <CardContent className="px-5 py-6 sm:px-8 sm:py-8">{children}</CardContent>
      </Card>
    </div>
  );
}

export default function FillQuestionnaire({ token }) {
  const [state, setState] = useState({ loading: true });
  const [done, setDone] = useState(null);

  useEffect(() => {
    call(token).then((data) => setState({ data })).catch((e) => setState({ dead: e.message }));
  }, [token]);

  if (state.loading) {
    return <Sheet><Skeleton className="h-5 w-40" /><Skeleton className="mt-4 h-8 w-3/4" /><Skeleton className="mt-6 h-40 w-full" /></Sheet>;
  }
  if (state.dead) {
    return (
      <Sheet>
        <h1 className="text-xl font-semibold text-foreground">This link is not available</h1>
        <p className="mt-2 text-[14px]/[1.6] text-secondary-text">{state.dead}</p>
      </Sheet>
    );
  }
  const d = state.data;
  const header = (
    <header className="mb-6">
      <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary">{d.seller}</div>
      <h1 className="mt-2 text-[24px]/[1.25] font-semibold tracking-[-0.02em] text-foreground">{d.questionnaire}</h1>
      <p className="mt-1.5 text-[13px] text-secondary-text">
        For {d.client_name || 'you'}{d.requested_by ? ` · requested by ${d.requested_by}` : ''}
      </p>
    </header>
  );

  if (done) {
    return (
      <Sheet>
        {header}
        <div className="flex items-start gap-3 rounded-md border border-border p-4">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <div className="text-[15px] font-semibold text-foreground">Thank you</div>
            <p className="mt-1 text-[14px]/[1.6] text-secondary-text">{done}</p>
          </div>
        </div>
      </Sheet>
    );
  }

  if (d.submitted) {
    return (
      <Sheet>
        {header}
        <p className="mb-6 rounded-md border border-border p-3 text-[13.5px]/[1.6] text-secondary-text">
          Submitted on {fmtDate(d.submitted_at)}{d.submitted_by_name ? ` by ${d.submitted_by_name}` : ''}. If something needs changing, reply to our email and we will reopen it for you.
        </p>
        <QuestionnaireForm definition={d.definition} initialAnswers={d.answers} files={d.files} readOnly />
      </Sheet>
    );
  }

  return (
    <Sheet>
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
      <p className="mt-8 text-[12px]/[1.6] text-muted-foreground">This link works until {fmtDate(d.expires_at)}. Your answers are used only to prepare your quotation.</p>
    </Sheet>
  );
}
