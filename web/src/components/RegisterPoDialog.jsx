import { useState } from 'react';
import { Alert, Field, Input, Modal, Select, useToast } from './ui.jsx';
import { api, ApiError } from '../lib/api.js';
import { invalidateLookups, useLookups } from '../lib/hooks.js';
import { money, today } from '../lib/format.js';

/**
 * PO received → project in one step (#26). From a quotation: the project
 * (new, or an existing one of the same client), the PO, its service lines,
 * the payment stages from a template and the onboarding checklist, all
 * in one save.
 */
export function RegisterPoDialog({ quotation, onClose, onDone }) {
  const toast = useToast();
  const lookups = useLookups();
  const templates = lookups.payment_terms_templates || [];
  const checklists = lookups.onboarding_templates || [];
  // Capitals and extra spaces are not a different client: "Hindalco  Ltd"
  // has to find "Hindalco Ltd", or registering a PO quietly opens a second
  // project for the same client, which is issue #8 all over again.
  const normClient = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const sameClient = lookups.projects.filter((p) => normClient(p.client_name) === normClient(quotation.client_name));
  const [v, setV] = useState({
    project_id: quotation.project_id || '',
    project_manager: '', project_manager_email: '', planned_start_date: '', planned_delivery_date: '',
    po_number: '', po_date: today(), po_value: quotation.total ?? quotation.quotation_value ?? '', currency: quotation.currency || 'INR', payment_terms_days: 30,
    payment_terms_template_id: String(templates.find((t) => t.is_default)?.id || templates[0]?.id || ''),
    onboarding_template_id: String(checklists.find((t) => t.is_default)?.id || checklists[0]?.id || ''),
  });
  const [file, setFile] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, val) => { setV((s) => ({ ...s, [k]: val })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const template = templates.find((t) => String(t.id) === v.payment_terms_template_id);
  // A PO for a different amount than was quoted is worth a second look (#26).
  const quoted = Number(quotation.total ?? quotation.quotation_value);
  const poValue = v.po_value === '' ? quoted : Number(v.po_value);
  const differs = Number.isFinite(quoted) && quoted > 0 && Number.isFinite(poValue) && Math.abs(poValue - quoted) > 0.005;
  const gap = differs ? ((poValue - quoted) / quoted) * 100 : 0;

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null); setErrors({});
    try {
      const payload = {
        ...v,
        onboarding_template_id: v.onboarding_template_id === 'none' ? 0 : v.onboarding_template_id,
        // "No stages now" has to say so. Sent blank, the server falls back to
        // the default template and the user gets a schedule they declined.
        payment_terms_template_id: v.payment_terms_template_id === 'none' ? 0 : v.payment_terms_template_id,
      };
      if (file) {
        const { data } = await api.uploadDocument(file, 'purchase-orders');
        payload.document_id = data.id;
      }
      const { data } = await api.action(`/quotations/${encodeURIComponent(quotation.quotation_no)}/register`, payload);
      toast(`${data.po_number} registered under ${data.project_id}: ${data.stages.length} stages, ${data.checklist_steps} checklist steps${data.po_value_differs ? '. The PO differs from the quotation' : ''}`, data.po_value_differs ? 'warning' : 'success');
      invalidateLookups();
      onDone?.(data);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fields) { setErrors(err.fields); setError('Some fields need attention.'); } else setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Register the PO"
      subtitle={`${quotation.quotation_no} · ${quotation.client_name} · ${money(quotation.total ?? quotation.quotation_value, quotation.currency)}`}
      onClose={onClose}
      size="lg"
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="register-po" className="btn btn--primary" disabled={busy}>{busy ? 'Registering…' : 'Register PO and project'}</button></>}
    >
      <form id="register-po" onSubmit={submit} className="stack">
        <Alert><span>One save: the quotation is marked won, the project is created (or the PO joins the one you pick), the PO is registered with its service lines, the payment stages come from the template, and the checklist is added.</span></Alert>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="form-grid">
          <div className="span-all" style={{ fontWeight: 650 }}>Purchase order</div>
          <Field label="PO number" required error={errors.po_number}><Input value={v.po_number} onChange={(e) => set('po_number', e.target.value)} /></Field>
          <Field label="PO date" error={errors.po_date}><Input type="date" value={v.po_date} onChange={(e) => set('po_date', e.target.value)} /></Field>
          <Field label="PO value" error={errors.po_value} hint="Blank: the quotation total"><Input type="number" step="0.01" min="0" value={v.po_value} onChange={(e) => set('po_value', e.target.value)} /></Field>
          <Field label="Currency"><Select value={v.currency} placeholder={null} options={lookups.enums?.currency || ['INR']} onChange={(e) => set('currency', e.target.value)} /></Field>
          {(differs || v.currency !== (quotation.currency || 'INR')) && (
            <div className="span-all">
              <Alert tone="warning">
                {differs
                  ? `The PO is ${money(poValue, v.currency)} against ${money(quoted, quotation.currency)} quoted (${gap > 0 ? '+' : ''}${gap.toFixed(1)}%). The service lines will be scaled to the PO; check the number before you register it.`
                  : `The PO is in ${v.currency}, the quotation in ${quotation.currency || 'INR'}. Check the currency before you register it.`}
              </Alert>
            </div>
          )}
          <Field label="Payment terms (days)" error={errors.payment_terms_days}><Input type="number" min="0" max="365" value={v.payment_terms_days} onChange={(e) => set('payment_terms_days', e.target.value)} /></Field>
          <Field label="PO document" hint="The client's PO, if you have the file"><input type="file" className="input" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>

          <div className="span-all" style={{ fontWeight: 650, marginTop: 6 }}>Payment schedule</div>
          <div className="span-all">
            <Field label="Template" error={errors.payment_terms_template_id} hint={template ? `${template.lines.map((l) => `${Number(l.percent)}% ${l.trigger_event.replace('On ', 'on ')}`).join(' · ')}` : 'Manage templates under Admin › Templates'}>
              <Select value={v.payment_terms_template_id} placeholder={null} options={[{ value: 'none', label: 'No stages now' }, ...templates.map((t) => ({ value: String(t.id), label: `${t.name}${t.is_default ? ' (default)' : ''}` }))]} onChange={(e) => set('payment_terms_template_id', e.target.value)} />
            </Field>
          </div>

          <div className="span-all" style={{ fontWeight: 650, marginTop: 6 }}>Project</div>
          <div className="span-all">
            <Field label="Project" error={errors.project_id} hint={quotation.project_id ? 'This quotation already has a project' : sameClient.length ? 'Join one of this client\'s projects, or create a new one' : 'A new project is created'}>
              <Select value={v.project_id} placeholder="New project" disabled={Boolean(quotation.project_id)} options={sameClient.map((p) => ({ value: p.project_id, label: `${p.project_id} · ${p.client_name}` }))} onChange={(e) => set('project_id', e.target.value)} />
            </Field>
          </div>
          {!v.project_id && (
            <>
              <Field label="Project manager"><Input value={v.project_manager} onChange={(e) => set('project_manager', e.target.value)} /></Field>
              <Field label="Manager email"><Input type="email" value={v.project_manager_email} onChange={(e) => set('project_manager_email', e.target.value)} /></Field>
              <Field label="Planned start"><Input type="date" value={v.planned_start_date} onChange={(e) => set('planned_start_date', e.target.value)} /></Field>
              <Field label="Planned delivery"><Input type="date" value={v.planned_delivery_date} onChange={(e) => set('planned_delivery_date', e.target.value)} /></Field>
              <div className="span-all">
                <Field label="Onboarding checklist" hint="Step target dates count from the planned start, or the PO date">
                  <Select value={v.onboarding_template_id} placeholder={null} options={[...checklists.map((t) => ({ value: String(t.id), label: `${t.name}${t.is_default ? ' (default)' : ''}` })), { value: 'none', label: 'No checklist' }]} onChange={(e) => set('onboarding_template_id', e.target.value)} />
                </Field>
              </div>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
