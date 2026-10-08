import { useState } from 'react';
import { cn } from 'cn';
import { useToast } from '../components/ui.jsx';
import { FailedCard, LoadingPanel } from '../components/daily.jsx';
import { BrandMark } from '../components/shell/Shell.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch } from '../lib/hooks.js';

/**
 * The company profile (C21): the facts printed on every quotation.
 *
 * The panel on the right is not a mock-up of a PDF: it is the same three
 * fields the generator lays out (`lib/quotationPdf.js` prints the name, the
 * address and "GSTIN <n>"), in the same order, updating as you type, with
 * the next real quotation number. Wave 8: drawn from the tokens, changed
 * fields marked with what they were, and Discard beside Save.
 */

const FIELDS = [
  { key: 'company_name', label: 'Legal name', hint: 'Printed at the top of every quotation, and used wherever the app names the company.' },
  { key: 'company_gstin', label: 'GSTIN', mono: true, hint: 'Sets the home state. The place of supply then decides CGST and SGST, or IGST.' },
  {
    key: 'company_gstins', label: 'All our GSTINs', mono: true, span: true,
    hint: 'Every state we are registered in, separated by commas. The email readers accept a PO addressed to any of them; an invoice raised from a different GSTIN than its PO was addressed to goes to review.',
  },
  {
    key: 'partner_companies', label: 'Partner companies', multiline: true, span: true,
    hint: 'Companies clients also order through, one per line: name | GSTIN | other names. A PO addressed to one is registered as ours and marked “Through” it. Write “none” for no partners.',
  },
  { key: 'company_address', label: 'Registered address', multiline: true, span: true, hint: 'One block, as it should appear under the name.' },
  { key: 'finance_email', label: 'Accounts email', type: 'email', hint: 'Where payment questions and the finance digest go.' },
  { key: 'company_state_code', label: 'Home state code', mono: true, hint: 'Two digits, matching the start of the GSTIN: 27 for Maharashtra.' },
];

/** The PDF header, as quotationPdf.js lays it out, drawn from the tokens. */
function PdfHeader({ values, number }) {
  const name = values.company_name || 'Cetizion Verifica';
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <div className="set-preview">
      <div className="set-preview__top">
        <BrandMark size={30} />
        <div className="min-w-0">
          <div className="set-preview__name">{name}</div>
          {values.company_address && <div className="set-preview__addr">{values.company_address}</div>}
          {values.company_gstin && <div className="set-mono text-secondary-text">GSTIN {values.company_gstin}</div>}
        </div>
      </div>
      <div className="set-preview__rule" />
      <div className="set-preview__row"><span className="font-extrabold tracking-[.04em]">QUOTATION {number || ''}</span><span className="text-secondary-text">{today}</span></div>
      <div className="set-preview__hair" />
      <div className="text-right text-secondary-text">For {name} · authorised signatory</div>
    </div>
  );
}

export function CompanyProfile() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/lookups'));
  const next = useFetch(() => api.raw('/lookups/next-id/quotation').catch(() => null), []);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);

  const saved = data?.data?.settings || {};
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, draft[f.key] ?? saved[f.key] ?? '']));
  const changed = FIELDS.filter((f) => draft[f.key] !== undefined && draft[f.key] !== (saved[f.key] ?? ''));
  const number = next.data?.data?.next;

  async function save() {
    setBusy(true);
    try {
      // One PATCH per changed key — the endpoint takes one setting at a
      // time, and only what actually moved is sent.
      for (const field of changed) {
        await api.update('settings', field.key, { value: draft[field.key] });
      }
      toast(changed.length === 1 ? 'Saved' : `${changed.length} settings saved`, 'success');
      invalidateLookups();
      setDraft({});
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  const names = changed.map((f) => f.label);
  const said = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];

  return (
    <SettingsPane
      title="Company profile"
      description="The legal identity and tax registration printed on every quotation. The preview shows where a change lands before you save it."
    >
      {error ? <FailedCard title="Couldn’t load the company profile" text="The server didn’t answer, so nothing is shown. This isn’t “nothing set”: nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !data ? <LoadingPanel rows={5} />
      : (
        <div className="set-two" data-a="rise">
          <section className="mg-glass mg-glass--strong mg-panel" aria-labelledby="set-cp" style={{ flex: '3 1 480px' }}>
            <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="set-cp">Legal identity and tax</h2><span className="mg-panel__hint">What every quotation, invoice and email reader takes as ours.</span></div>
            <div className="mg-grid2">
              {FIELDS.map((field) => {
                const was = saved[field.key] ?? '';
                const isChanged = changed.includes(field);
                return (
                  <label key={field.key} className={cn('mg-field', isChanged && 'is-changed')} style={{ gridColumn: field.span ? '1 / -1' : undefined }}>
                    <span className="mg-field__label">{field.label}</span>
                    {field.multiline ? (
                      <textarea className="mg-textarea" rows={2} value={values[field.key]} onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))} />
                    ) : (
                      <input className={cn('mg-input', field.mono && 'set-mono')} type={field.type || 'text'} value={values[field.key]} onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))} />
                    )}
                    {isChanged && <span className="set-was">{was ? `Was “${was.length > 60 ? `${was.slice(0, 60)}…` : was}”` : 'Was blank'}</span>}
                    {field.hint && <span className="mg-field__hint">{field.hint}</span>}
                  </label>
                );
              })}
            </div>
            <div className="set-savebar">
              <button type="button" className="mg-btn mg-btn--primary" disabled={!changed.length || busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
              {changed.length > 0 && !busy && <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setDraft({})}>Discard</button>}
              <span className={cn('text-[13px] font-semibold', changed.length ? 'text-caramel-text' : 'text-muted-foreground')}>
                {changed.length ? `${said} ${changed.length === 1 ? 'has' : 'have'} changed. Save, or ${changed.length === 1 ? 'it’s' : 'they’re'} lost when you leave.` : 'Nothing has changed yet'}
              </span>
            </div>
          </section>
          <section className="mg-glass mg-panel" aria-labelledby="set-pdf" style={{ flex: '2 1 320px', maxWidth: 480 }}>
            <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="set-pdf">PDF header, live</h2><span className="mg-panel__hint">The name, address and GSTIN, as the quotation PDF prints them.</span></div>
            <PdfHeader values={values} number={number} />
            <p className="m-0 text-[12.5px] text-secondary-text">
              Shown with your next quotation number and today’s date. The number series ({number ? <span className="set-mono">{number}</span> : 'CTZ/QT/…'}, PRJ-…, CVPL/…) stay server-owned and aren’t edited here.
            </p>
          </section>
        </div>
      )}
    </SettingsPane>
  );
}
