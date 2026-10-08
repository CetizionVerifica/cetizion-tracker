import { useState } from 'react';
import { Field, Modal, useToast } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { date } from '../../lib/format.js';

/** "Mon 13 Oct, 10:00", the way the snooze options say when. */
const whenShort = (d) => `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

/** A local date-time field's value for a Date. */
const localValue = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Create an enquiry from this email: prefilled from the thread, sourced
 * from the inbox. The banner's button and this dialog say the same words.
 */
export function ConvertDialog({ c, people, sources, sentAt, onClose, onDone }) {
  const toast = useToast();
  // The inbound-email source when the list has one; blank lets the server choose ("Inbound email or call").
  const inbound = sources.find((x) => /inbound\s*e-?mail/i.test(x.name));
  const [v, setV] = useState({
    client_name: c.company_name || '',
    contact_person: c.contact_name || String(c.from_name || '').replace(/\s*\(portal\)\s*$/i, ''),
    service: c.subject || '',
    sales_person: c.assignee || '',
    source_id: inbound ? String(inbound.id) : '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const who = String(c.from_name || c.from_email || '').replace(/\s*\(portal\)\s*$/i, '');
  async function go(e) {
    e?.preventDefault();
    if (!v.client_name.trim()) return;
    setBusy(true);
    try {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
      const { data } = await api.action(`/inbox/${c.id}/convert`, body);
      toast(`Enquiry ${data.enquiry_no} created`, 'success'); onDone();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal
      title="Create an enquiry from this email"
      subtitle={`Prefilled from ${who}’s email${sentAt ? ` of ${date(sentAt)}` : ''}. The enquiry is sourced from the inbox.`}
      onClose={onClose}
      footer={<>
        <span className="mr-auto self-center text-[12px] text-muted-foreground max-sm:hidden">The email thread shows on the new enquiry.</span>
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="convert-form" className="mg-btn mg-btn--primary" disabled={busy || !v.client_name.trim()}>{busy ? 'Creating…' : 'Create enquiry'}</button>
      </>}
    >
      <form id="convert-form" onSubmit={go} className="flex flex-col gap-3.5" noValidate>
        <div className="mg-grid2 grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <Field label="Company" required hint={c.company_name ? 'On file. The enquiry joins its record.' : 'Not on file yet: it is created with the enquiry.'}>
            <input className="mg-input" required value={v.client_name} onChange={set('client_name')} />
          </Field>
          <Field label="Contact" hint={c.contact_name ? 'On file.' : undefined}><input className="mg-input" value={v.contact_person} onChange={set('contact_person')} /></Field>
        </div>
        <Field label="Service asked for"><input className="mg-input" value={v.service} onChange={set('service')} /></Field>
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <Field label="Owner">
            <span className="mg-select-wrap">
              <select className="mg-select" value={v.sales_person} onChange={set('sales_person')}>
                <option value="">Nobody (unassigned)</option>
                {people.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </span>
          </Field>
          <Field label="Source" hint={v.source_id ? undefined : 'Blank: Inbound email or call'}>
            <span className="mg-select-wrap">
              <select className="mg-select" value={v.source_id} onChange={set('source_id')}>
                <option value="">—</option>
                {sources.map((x) => <option key={x.id} value={String(x.id)}>{x.name}</option>)}
              </select>
            </span>
          </Field>
        </div>
        <Field label="Notes"><textarea className="mg-textarea" rows={2} value={v.notes} onChange={set('notes')} style={{ minHeight: 72 }} /></Field>
      </form>
    </Modal>
  );
}

/** Snooze until: three quick times, or a date and time of your own. */
export function SnoozeDialog({ onClose, onSnooze }) {
  const at = (days, hour = 10) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  const options = [['tom', 'Tomorrow morning', at(1)], ['three', 'In 3 days', at(3)], ['week', 'Next week', at(7)]];
  const [pick, setPick] = useState('week');
  const [custom, setCustom] = useState('');
  const chosen = custom ? new Date(custom) : options.find((o) => o[0] === pick)?.[2];
  const valid = chosen && !Number.isNaN(chosen.getTime()) && chosen > new Date();
  return (
    <Modal
      size="sm"
      title="Snooze until"
      subtitle="It leaves Open now and comes back at this time, with its reply clock."
      onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="mg-btn mg-btn--primary" disabled={!valid} onClick={() => onSnooze(chosen.toISOString())}>Snooze</button>
      </>}
    >
      <div className="flex flex-col gap-3.5">
        <div role="radiogroup" aria-label="When it comes back" className="flex flex-col gap-1.5">
          {options.map(([key, label, d]) => {
            const on = !custom && pick === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => { setPick(key); setCustom(''); }}
                className="flex min-h-12 w-full items-center gap-3 rounded-[14px] border px-3.5 text-left"
                style={{ borderColor: on ? 'var(--caramel)' : 'var(--line)', background: on ? 'var(--wait-soft)' : 'transparent' }}
              >
                <span className="flex-1 font-bold">{label}</span>
                <span className="mg-num text-[12.5px] text-secondary-text">{whenShort(d)}</span>
              </button>
            );
          })}
        </div>
        <Field label="Or pick a date and time" hint={custom && valid ? `India time. Comes back on ${whenShort(chosen)}.` : custom ? 'Pick a time after now.' : 'India time.'}>
          <input className="mg-input" type="datetime-local" min={localValue(new Date())} value={custom} onChange={(e) => setCustom(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
