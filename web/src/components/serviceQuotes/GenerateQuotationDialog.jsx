import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Modal, useToast } from '../ui.jsx';
import { api } from '../../lib/api.js';
import { useFetch } from '../../lib/hooks.js';

/**
 * Generate quotation, from a submitted questionnaire (#208 phase 2C,
 * web/src/components/serviceQuotes/CLAUDE.md §2). One quotation per enquiry
 * (spec D12): the first questionnaire makes a Draft; another service's adds
 * its lines; the same service again replaces its own generated lines. The
 * dialog says which before anything happens. Only ever a Draft: nothing goes
 * to the client from here. The server decides; a refusal shows its sentence.
 */
const CLOSED = new Set(['Won - PO Received', 'Lost']);

export function GenerateQuotationDialog({ response, enquiry: given, onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  // The enquiry as it is now, not as the caller had it: a dialog opened from
  // a link knows only the enquiry's number, and another service's answers
  // may have made its quotation since.
  const current = useFetch(() => api.raw(`/enquiries/${encodeURIComponent(given.enquiry_no)}`), [given.enquiry_no]);
  const enquiry = current.data?.data || given;
  const existing = useFetch(
    () => (current.data && enquiry.quotation_no ? api.raw(`/quotations/${encodeURIComponent(enquiry.quotation_no)}/full`) : Promise.resolve(null)),
    [current.data, enquiry.quotation_no],
  );
  const q = existing.data?.data;
  const loading = !current.data && !current.error ? true : Boolean(enquiry.quotation_no && !q && !existing.error);
  const mode = enquiry.quotation_no ? 'revise' : 'new';
  const serviceOnIt = q?.lines?.some((l) => l.generated && l.service_id === response.service_id);

  async function generate() {
    setBusy(true);
    setRefusal(null);
    try {
      const r = await api.action(`/questionnaire-responses/${response.id}/quotation`, { mode });
      const d = r.data;
      toast(d.price_needed_count
        ? `${d.quotation_no}: ${d.lines} line${d.lines === 1 ? '' : 's'} from the answers, ${d.price_needed_count} needing a price`
        : `${d.quotation_no}: ${d.lines} line${d.lines === 1 ? '' : 's'} from the answers`, 'success');
      navigate(`/quotations/${encodeURIComponent(d.quotation_no)}`);
    } catch (err) {
      setRefusal(err.message);
    } finally { setBusy(false); }
  }

  const closed = q && CLOSED.has(q.status);
  return (
    <Modal
      title="Generate quotation"
      subtitle={`From the ${response.service_name || response.questionnaire_name} answers · ${enquiry.enquiry_no}`}
      onClose={onClose}
      footer={(
        <>
          {!closed && <button type="button" className="btn btn--primary" disabled={busy || loading} onClick={generate}>{busy ? 'Generating…' : mode === 'new' ? 'Generate quotation' : `Revise ${enquiry.quotation_no}`}</button>}
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>{closed ? 'Close' : 'Cancel'}</button>
        </>
      )}
    >
      <div className="stack">
        {loading && <div className="skeleton" style={{ height: 60 }} />}
        {current.error && <Alert tone="warning"><span>Enquiry {given.enquiry_no} could not be opened: {current.error}</span></Alert>}
        {existing.error && <Alert tone="warning"><span>{enquiry.quotation_no} could not be opened: {existing.error}</span></Alert>}
        {!loading && mode === 'new' && (
          <p>A Draft quotation for {enquiry.client_name || enquiry.enquiry_no}, priced from these answers by the questionnaire's pricing rules. Lines the rules cannot price are marked <strong>Price needed</strong>.</p>
        )}
        {q && closed && (
          <p>{q.quotation_no} is {q.status === 'Lost' ? 'lost' : 'won'}, so it is not generated again{q.status === 'Lost' ? '' : '. Raise a new quotation for extra scope'}.</p>
        )}
        {q && !closed && serviceOnIt && (
          <p>
            {q.quotation_no} is revised: its current version is kept in the history. Its <strong>{response.service_name}</strong> lines
            are replaced by these answers' lines, <strong>including any changes made to them since</strong>. Lines added by hand,
            and other services' lines, stay as they are.
          </p>
        )}
        {q && !closed && !serviceOnIt && (
          <p>
            {q.quotation_no} is revised, and this questionnaire's <strong>{response.service_name}</strong> lines are added to it;
            its current version is kept in the history. The lines already on it stay as they are.
          </p>
        )}
        {!closed && <p className="small muted">It stays a Draft: nothing goes to the client until someone checks it and sends it.</p>}
        {refusal && <Alert tone="warning"><span>{refusal}</span></Alert>}
      </div>
    </Modal>
  );
}
