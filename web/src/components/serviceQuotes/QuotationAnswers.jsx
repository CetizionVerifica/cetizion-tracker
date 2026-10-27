import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '../ui.jsx';
import { Answers } from '../QuestionnaireCard.jsx';
import { api } from '../../lib/api.js';
import { useFetch } from '../../lib/hooks.js';

/**
 * The answers a quotation's generated lines came from (#208 phase 2C,
 * web/src/components/serviceQuotes/CLAUDE.md §2): every response in
 * `generated_from`, one per service (spec D12), read-only. A client's
 * answers are shown as text, never as markup, through the same Answers the
 * enquiry's questionnaire dialog uses.
 */
export function QuotationAnswers({ generatedFrom }) {
  const [open, setOpen] = useState(() => (generatedFrom.length === 1 ? generatedFrom[0].questionnaire_response_id : null));
  if (!generatedFrom.length) return null;
  return (
    <div className="stack">
      {generatedFrom.map((g) => (
        <section key={g.questionnaire_response_id} className="rounded-lg border border-border bg-card">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
            aria-expanded={open === g.questionnaire_response_id}
            onClick={() => setOpen(open === g.questionnaire_response_id ? null : g.questionnaire_response_id)}
          >
            <span className="strong">{g.service_name || 'Questionnaire'}</span>
            <span className="small muted">{g.lines} line{g.lines === 1 ? '' : 's'} from these answers · {open === g.questionnaire_response_id ? 'Hide' : 'Show'}</span>
          </button>
          {open === g.questionnaire_response_id && <div className="px-4 pb-4"><ResponseAnswers id={g.questionnaire_response_id} /></div>}
        </section>
      ))}
    </div>
  );
}

/**
 * One response's answers, fetched through the same scoped route as the
 * enquiry's dialog: someone who may open the quotation but not the enquiry
 * (a reassigned quotation) gets the server's refusal, not the answers.
 */
function ResponseAnswers({ id }) {
  const r = useFetch(() => api.raw(`/questionnaire-responses/${id}`), [id]);
  if (r.error) return <Alert tone="warning"><span>These answers could not be opened: {r.error}</span></Alert>;
  if (!r.data) return <div className="skeleton" style={{ height: 80 }} />;
  const response = r.data.data;
  return (
    <div className="stack">
      {response.enquiry_no && (
        <p className="small">
          {/* The enquiry's questionnaire dialog, the way a "submitted" notification opens it. */}
          <Link className="underline" to={`/enquiries?q=${encodeURIComponent(response.enquiry_no)}&questionnaire=1`}>
            Open the questionnaire on enquiry <span className="mono">{response.enquiry_no}</span>
          </Link>
        </p>
      )}
      <Answers response={response} />
    </div>
  );
}
