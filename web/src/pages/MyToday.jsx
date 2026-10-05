import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, CheckSquare, IndianRupee, RefreshCw, Receipt } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ErrorState, Field, Input, Modal, Select, Textarea, useToast } from '../components/ui.jsx';
import { RecordInvoiceDialog } from '../components/actions.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * My Today (docs/my-today-plan.md): one person's own list for the day.
 *
 * Today is the company's day; this is yours. Two sections — what is more
 * than the grace period late, and what is due today — built from tasks,
 * enquiry follow-ups, invoices ready to raise and payments to chase. Each
 * row has one action, and the list empties as you work down it.
 *
 * The rules (whose an item is, when it is due, which section) are the
 * server's, in lib/myToday.js; this page only draws them.
 */

/** Sent after any action here, so the sidebar count drops with the list. */
export const MY_TODAY_CHANGED = 'cetizion:my-today-changed';

const CARD = 'rounded-[10px] border border-border bg-card';
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground';
const BUTTON = 'inline-flex h-control shrink-0 items-center rounded-[6px] border border-border-strong bg-secondary px-3.5 text-[13px] font-medium text-foreground transition-colors duration-150 hover:border-muted-foreground disabled:opacity-50';

const KIND = {
  task: { icon: CheckSquare, action: 'Done', noun: ['task', 'tasks'] },
  follow_up: { icon: RefreshCw, action: 'Log & reschedule', noun: ['follow-up', 'follow-ups'] },
  invoice: { icon: Receipt, action: 'Raise', noun: ['invoice to raise', 'invoices to raise'] },
  payment: { icon: IndianRupee, action: 'Log chase', noun: ['payment to chase', 'payments to chase'] },
};

/** "Tuesday, 29 September", from the business date the server worked out. */
function dayLabel(iso) {
  const d = iso ? new Date(`${iso}T12:00:00`) : new Date();
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })}, ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}

/** The second line of a row: what it is about, and why it is here. */
function detail(item) {
  const c = item.context || {};
  const parts = [];
  if (item.kind === 'task') {
    parts.push(`${String(c.type || 'task').replace('_', ' ')} on ${String(c.record).replace('_', ' ')} ${c.record_id}`);
    if (item.client_name) parts.push(item.client_name);
    parts.push(`due ${date(item.due_on)}`);
  } else if (item.kind === 'follow_up') {
    parts.push(`enquiry ${c.enquiry_no}`);
    if (c.service) parts.push(c.service);
    parts.push(`due ${date(item.due_on)}`);
  } else if (item.kind === 'invoice') {
    parts.push(`${c.po_number} · ${item.client_name}`);
    if (item.amount != null) parts.push(money(item.amount, item.currency, { compact: true }));
    parts.push(`ready since ${date(item.due_on)}`);
  } else if (item.kind === 'payment') {
    parts.push(item.client_name);
    if (item.amount != null) parts.push(`${money(item.amount, item.currency, { compact: true })} owed`);
    if (c.days_overdue != null) parts.push(`${c.days_overdue} days past due`);
    parts.push(c.last_chase ? `last chased ${date(c.last_chase)}` : 'not chased yet');
  }
  return parts.filter(Boolean).join(' · ');
}

function Skeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-hidden="true">
      {[3, 4].map((n, s) => (
        <section key={s} className="flex min-w-0 flex-col gap-3">
          <div className="skeleton h-3 w-40 rounded" />
          <div className={`${CARD} overflow-hidden`}>
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className="flex h-11 items-center gap-3 border-b border-border px-5 last:border-b-0">
                <div className="skeleton size-4 shrink-0 rounded-full" />
                <div className="skeleton h-3 flex-1 rounded" />
                <div className="skeleton h-7 w-24 shrink-0 rounded" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Row({ item, busy, onAct }) {
  const kind = KIND[item.kind];
  const Icon = kind.icon;
  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-border px-5 py-1.5 last:border-b-0 hover:bg-secondary">
      <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] text-foreground">{item.title}</div>
        <div className="truncate text-[12px] text-secondary-text">{detail(item)}</div>
      </div>
      {item.late_label && (
        <span className="hidden shrink-0 rounded-[6px] border border-late/30 bg-late/10 px-2 text-[11.5px] font-semibold text-late sm:inline">
          {item.late_label}
        </span>
      )}
      <button type="button" className={BUTTON} disabled={busy} onClick={() => onAct(item)}>{kind.action}</button>
    </div>
  );
}

function Section({ title, items, older, busy, onAct, olderHref }) {
  if (!items.length && !older) return null;
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className={EYEBROW}>{title}</div>
      <div className={`${CARD} overflow-hidden`}>
        {items.map((item) => <Row key={`${item.kind}:${item.entity_id}`} item={item} busy={busy} onAct={onAct} />)}
        {older && (
          <div className="flex min-h-11 items-center gap-3 px-5 py-1.5">
            <span className="min-w-0 flex-1 text-[13px] text-secondary-text">
              {older.count} older {older.count === 1 ? 'item' : 'items'}, more than a month late, since {date(older.oldest_due_on)}
            </span>
            <Link to={olderHref} className={BUTTON}>Show all</Link>
          </div>
        )}
      </div>
    </section>
  );
}

export default function MyToday() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const owner = params.get('owner') || '';
  const all = params.get('all') === '1';
  const query = new URLSearchParams({ ...(owner ? { owner } : {}), ...(all ? { all: '1' } : {}) }).toString();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/dashboard/my-today${query ? `?${query}` : ''}`), [query]);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  const d = data?.data;
  const changed = () => { refetch(); window.dispatchEvent(new Event(MY_TODAY_CHANGED)); };
  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  async function act(item) {
    if (item.kind !== 'task') { setDialog(item); return; }
    setBusy(true);
    try {
      await api.update('tasks', item.entity_id, { status: 'done' });
      toast('Done', 'success');
      changed();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const picker = d?.owners?.length > 0 && (
    <Select
      aria-label="Whose day"
      value={owner || (d.person ? String(d.person.id) : '')}
      placeholder={d.person ? null : 'Pick a person'}
      options={d.owners.map((o) => ({ value: String(o.id), label: o.name }))}
      onChange={(e) => setParam('owner', e.target.value)}
    />
  );

  const title = `My Today · ${dayLabel(d?.today)}`;
  if (error) {
    return (
      <>
        <PageHeader title={title} />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }

  const counts = d?.counts;
  const subtitle = loading && !d ? 'Working out what is yours today…'
    : d?.needs_person ? 'This sign-in is not a person. Pick whose day to show.'
    : counts ? `${counts.late} late · ${counts.due_today} due today${d.person && owner ? ` · ${d.person.name}` : ''}`
    : null;
  const grace = d?.rules?.grace_working_days ?? 2;
  const empty = d && !d.needs_person && !d.late.length && !d.due_today.length && !d.older;
  const olderHref = `/my-today?${new URLSearchParams({ ...(owner ? { owner } : {}), all: '1' }).toString()}`;

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={picker || null} />
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
        {loading && !d && <Skeleton />}
        {d && !d.needs_person && (
          <>
            <Section
              title={`Late — more than ${grace} working ${grace === 1 ? 'day' : 'days'}`}
              items={d.late}
              older={d.older}
              olderHref={olderHref}
              busy={busy}
              onAct={act}
            />
            <Section title="Due today" items={d.due_today} busy={busy} onAct={act} />
            {all && <button type="button" className="self-start text-[13px] font-medium text-primary hover:underline" onClick={() => setParam('all', '')}>Fold the oldest again</button>}
          </>
        )}
        {empty && (
          <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-border px-4 py-3">
            <CheckCircle2 className="size-4 text-settled" strokeWidth={2.2} aria-hidden="true" />
            <span className="text-[13px] text-secondary-text">Nothing is waiting on {owner && d.person ? d.person.name : 'you'} today.</span>
          </div>
        )}
      </div>

      {dialog?.kind === 'follow_up' && <FollowUpDialog item={dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); changed(); }} />}
      {dialog?.kind === 'payment' && <ChaseDialog item={dialog} rechaseDays={d?.rules?.rechase_days ?? 7} onClose={() => setDialog(null)} onDone={() => { setDialog(null); changed(); }} />}
      {dialog?.kind === 'invoice' && (
        <RecordInvoiceDialog
          stage={{
            id: dialog.entity_id,
            po_number: dialog.context.po_number,
            stage_name: dialog.context.stage_name,
            stage_amount: dialog.amount,
            currency: dialog.currency,
            client_name: dialog.client_name,
            terms_days: dialog.context.terms_days,
            document_id: dialog.context.document_id,
          }}
          onClose={() => setDialog(null)}
          onDone={changed}
        />
      )}
    </>
  );
}

/** Tomorrow, as YYYY-MM-DD in the browser's calendar: the default next date. */
function tomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Log the touch, then set the next follow-up. The date is required: logging
 * a touch moves last_contacted_at but not next_follow_up_at, so without a new
 * date the follow-up would still be on the list after the call.
 */
function FollowUpDialog({ item, onClose, onDone }) {
  const toast = useToast();
  const [v, setV] = useState({ channel: 'call', summary: '', next: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  async function save(e) {
    e.preventDefault(); setBusy(true);
    try {
      await api.action('/communications', {
        entity: 'enquiry', entity_id: item.context.enquiry_no, channel: v.channel, direction: 'outbound', summary: v.summary || null,
      });
      await api.update('enquiries', item.context.enquiry_id, { next_follow_up_at: v.next });
      toast('Logged, and the next follow-up is set', 'success');
      onDone();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal
      title="Log & reschedule"
      subtitle={`${item.client_name} · ${item.context.enquiry_no}`}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="follow-up-form" className="btn btn--primary" disabled={busy || !v.next}>Save</button></>}
    >
      <form id="follow-up-form" onSubmit={save} className="form-grid">
        <Field label="How"><Select value={v.channel} placeholder={null} options={['call', 'email', 'whatsapp', 'meeting', 'other']} onChange={(e) => set('channel', e.target.value)} /></Field>
        <Field label="Next follow-up" required><Input type="date" value={v.next} min={tomorrow()} onChange={(e) => set('next', e.target.value)} /></Field>
        <div className="span-all"><Field label="What happened"><Textarea rows={3} value={v.summary} onChange={(e) => set('summary', e.target.value)} autoFocus placeholder="Spoke to the buyer; they want the revised scope by Friday" /></Field></div>
      </form>
    </Modal>
  );
}

/** A chase on one invoice, as Collections logs it. */
function ChaseDialog({ item, rechaseDays, onClose, onDone }) {
  const toast = useToast();
  const [v, setV] = useState({ channel: 'call', summary: '', promise_to_pay_date: '', next_action_on: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  async function save(e) {
    e.preventDefault(); setBusy(true);
    try {
      await api.action('/collections/log', { ...v, stage_id: item.entity_id });
      toast('Chase logged', 'success');
      onDone();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal
      title="Log a chase"
      subtitle={`${item.context.invoice_no} · ${item.client_name}`}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="my-chase-form" className="btn btn--primary" disabled={busy || !v.summary.trim()}>Save</button></>}
    >
      <form id="my-chase-form" onSubmit={save} className="form-grid">
        <Field label="How"><Select value={v.channel} placeholder={null} options={['call', 'email', 'whatsapp', 'meeting', 'note']} onChange={(e) => set('channel', e.target.value)} /></Field>
        <Field label="Promised to pay by" hint="Off your list until then"><Input type="date" value={v.promise_to_pay_date} onChange={(e) => set('promise_to_pay_date', e.target.value)} /></Field>
        <Field label="Next action on" hint={`Blank brings it back in ${rechaseDays} days`}><Input type="date" value={v.next_action_on} onChange={(e) => set('next_action_on', e.target.value)} /></Field>
        <div className="span-all"><Field label="What happened" required><Textarea rows={3} value={v.summary} onChange={(e) => set('summary', e.target.value)} autoFocus placeholder="Spoke to accounts; payment run is on the 25th" /></Field></div>
      </form>
    </Modal>
  );
}
