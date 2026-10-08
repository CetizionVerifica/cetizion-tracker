import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { cn } from 'cn';
import { SettingsPane } from './SettingsArea.jsx';
import { ConfirmDialog, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { FailedCard, ListTable, LoadingPanel, Panel, PhoneRow, StateCard } from '../components/daily.jsx';
import { MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { Seg } from '../components/insights/shared.jsx';
import { RowActions, SetStrip, undoToast } from '../components/settings.jsx';
import { money } from '../lib/format.js';
import { api } from '../lib/api.js';
import { useFetch, useList, useLookups, invalidateLookups } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { mayWriteResource } from '../lib/permissions.js';
import { date } from '../lib/format.js';

/**
 * Settings › Organisation, Money and Lists (Wave 8): Exchange rates,
 * Holidays, Assumptions and the four lists. Each is a pane in the Settings
 * shell (SettingsArea): crumbs, one h1, a sentence, the actions, then its
 * panels. Readers (sales) get a "Read only" chip instead of empty action
 * columns.
 */

export const CATALOGUES = {
  services: { resource: 'services', label: 'Service', title: 'Service offerings', hint: 'What you quote for. Each one fills in its rate, GST and SAC code on quotation and PO lines.' },
  // The travel desk keeps these two (#196): HR edits them as an admin does.
  'travel-vendors': {
    resource: 'travel-vendors', label: 'Travel vendor', title: 'Travel vendors', hr: true,
    hint: 'Who trips are booked through. The invoice prefixes are how the travel import recognises a vendor’s bills.',
    extraFields: [
      { name: 'gstin', label: 'GSTIN' }, { name: 'pan', label: 'PAN' },
      { name: 'contact_name', label: 'Contact' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' },
      { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', default: '30' },
      { name: 'invoice_prefixes', label: 'Invoice number prefixes', hint: 'Separated by commas, e.g. HT/2627/, HTT/26-27/. The travel import uses these to recognise this vendor’s bills.', span: 'all' },
      { name: 'address', label: 'Address', type: 'textarea', span: 'all' },
    ],
  },
  'trip-types': {
    resource: 'trip-types', label: 'Trip type', title: 'Trip types', hr: true,
    hint: 'What a trip was for. A billable type may be billed to the client; one in use can be hidden, never deleted.',
    extraFields: [
      { name: 'chargeable', label: 'Billable to the client', type: 'boolean', default: 'false' },
      { name: 'sort_order', label: 'Sort order', type: 'number', default: '0' },
    ],
  },
  'expense-categories': { resource: 'expense-categories', label: 'Expense category', title: 'Expense categories', hint: 'What employees can claim against.' },
};

const an = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const days = (n) => `${n} ${Number(n) === 1 ? 'day' : 'days'}`;
const SOURCE = { manual: 'Typed in', feed: 'From a feed' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOf = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).getUTCDay();
const shortDay = (iso) => { const [, m, d] = String(iso).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]}`; };
const todayIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/** Read-only roles see a chip instead of buttons that would be refused. */
function useReader() {
  const { isAdmin } = useAuth();
  return isAdmin ? null : 'Read only: an admin changes these';
}

/* ------------------------------------------------------------ rates */

/**
 * Rates with the date each one took effect. Every report converts a figure at
 * the rate in force on that record's own date — the quotation date, the PO
 * date, the invoice date, the payment date — so adding today's rate never
 * changes what last year's deals were worth.
 */
export function ExchangeRates() {
  // One rate decides what every historical deal in that currency is reported to
  // be worth, so exchange-rates is adminOnlyWrites on the server (#85). Sales
  // users still read them — the same rows drive their figures, and /settings
  // deliberately lands them on this pane — so the pane stays open and only the
  // three controls that change a rate are the admin's.
  const { isAdmin } = useAuth();
  const reader = useReader();
  const toast = useToast();
  const lookups = useLookups();
  const { rows, loading, error, data, refetch } = useList('exchange-rates', { limit: 500 });
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const currencies = (lookups.enums?.currency || ['INR', 'EUR', 'USD', 'GBP', 'AED', 'SGD']).filter((c) => c !== 'INR');
  // Newest first per currency, so the rate in force today is the one on top.
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.from_currency)) latest.set(row.from_currency, row);
  // Only currencies something is actually recorded in: warning about a rate
  // nothing needs trains people to ignore the warning.
  const inUse = lookups.currencies_in_use ?? [];
  const missing = inUse.filter((c) => c !== 'INR' && !latest.has(c));

  async function remove(row) {
    setBusy(true);
    try {
      await api.remove('exchange-rates', row.id);
      toast('Rate deleted', 'success');
      setRemoving(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  /** What deleting a rate does, in the dialog: fall back, or stop converting. */
  function deleteText(row) {
    const same = rows.filter((r) => r.from_currency === row.from_currency);
    const earlier = same.filter((r) => r.effective_from < row.effective_from).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    if (!earlier) return `It’s the earliest ${row.from_currency} rate, so every figure dated before the next one would be left out of the INR totals and reported unconverted.`;
    return `Figures dated on or after ${shortDay(row.effective_from)} fall back to the ${shortDay(earlier.effective_from)} rate, ₹${Number(earlier.rate)}.`;
  }

  const acts = (r) => isAdmin && (
    <RowActions>
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit the ${r.from_currency} rate from ${date(r.effective_from)}`} onClick={() => setEditing(r)}>Edit</button>
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Delete the ${r.from_currency} rate from ${date(r.effective_from)}`} onClick={() => setRemoving(r)}>Delete</button>
    </RowActions>
  );

  return (
    <SettingsPane
      title="Exchange rates"
      description="INR for one unit, from the date it took effect. Reports convert each figure at the rate in force on its own date, so a restated rate never rewrites history."
      readOnly={reader}
      actions={isAdmin && <button type="button" className="mg-btn mg-btn--primary" onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" />Add a rate</button>}
    >
      {error ? <FailedCard title="Couldn’t load exchange rates" text="The server didn’t answer, so nothing is shown. This isn’t “nothing set”: nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !data ? <LoadingPanel rows={4} />
      : (
        <>
          {missing.length > 0 && (
            <MoneyBanner
              tone="wait"
              title={`No rate is set for ${missing.join(', ')}.`}
              action={isAdmin && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setEditing({ from_currency: missing[0] })}>Add {an(missing[0])} {missing[0]} rate</button>}
            >
              {' '}Amounts in {missing.length === 1 ? 'it are' : 'them are'} left out of every INR figure and reported separately until a rate is added.{isAdmin ? '' : ' Ask an admin to add one.'}
            </MoneyBanner>
          )}
          {rows.length === 0 ? (
            <StateCard tone="plain" title="No exchange rates yet" text="Add one per currency, dated from when it applied. Until then, amounts in other currencies are left out of INR totals.">
              {isAdmin && <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setEditing('new')}>Add a rate</button>}
            </StateCard>
          ) : (
            <>
              <SetStrip
                label="Rates in force today"
                cells={[
                  ...[...latest.values()].map((r) => ({ label: r.from_currency, figure: `₹${Number(r.rate).toFixed(2)}`, foot: `from ${shortDay(r.effective_from)}` })),
                  ...missing.map((c) => ({ label: c, figure: 'Not set', foot: 'Left out of INR totals', tone: 'late' })),
                ]}
              />
              <RateHistory rows={rows} currencies={currencies} />
              <Panel id="set-rates" title="Every rate" hint="Newest first. A restated rate is a new row from its own date, so history never changes.">
                <ListTable
                  label="Exchange rates"
                  rows={rows}
                  columns={[
                    { key: 'from_currency', header: 'Currency', render: (r) => <b>{r.from_currency}</b> },
                    { key: 'rate', header: 'INR for 1 unit', num: true, render: (r) => <b>₹{Number(r.rate).toFixed(2)}</b> },
                    { key: 'effective_from', header: 'Effective from', num: true, render: (r) => date(r.effective_from) },
                    { key: 'in_force', header: 'In force', render: (r) => (latest.get(r.from_currency)?.id === r.id ? <Tone tone="ok">Current</Tone> : <span className="text-muted-foreground">—</span>) },
                    { key: 'source', header: 'Source', render: (r) => SOURCE[r.source] || r.source },
                    { key: 'note', header: 'Note', className: 'app-say', render: (r) => r.note || <span className="text-muted-foreground">—</span> },
                    ...(isAdmin ? [{ key: 'act', header: '', className: 'actions', render: acts }] : []),
                  ]}
                  phone={(r) => (
                    <PhoneRow
                      title={r.from_currency}
                      amount={`₹${Number(r.rate).toFixed(2)}`}
                      meta={[`from ${date(r.effective_from)}`, SOURCE[r.source] || r.source, r.note].filter(Boolean).join(' · ')}
                      state={latest.get(r.from_currency)?.id === r.id ? <Tone tone="ok">Current</Tone> : null}
                    >
                      {isAdmin && <span className="set-rowacts">
                        <button type="button" className="mg-btn mg-btn--sm" onClick={() => setEditing(r)}>Edit</button>
                        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setRemoving(r)}>Delete</button>
                      </span>}
                    </PhoneRow>
                  )}
                />
              </Panel>
            </>
          )}
        </>
      )}

      {editing && (
        <RecordForm
          title={editing.id ? `Edit the ${editing.from_currency} rate from ${shortDay(editing.effective_from)}` : 'New exchange rate'}
          subtitle={editing.id ? `Changing it changes every figure dated from ${shortDay(editing.effective_from)} until a later rate` : 'INR for one unit of a currency, from a date'}
          submitLabel={editing.id ? 'Save changes' : 'Add rate'}
          resource="exchange-rates"
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refetch}
          fields={[
            { name: 'from_currency', label: 'Currency', type: 'select', options: currencies, required: true },
            { name: 'rate', label: 'INR for 1 unit', type: 'number', step: '0.000001', required: true, hint: 'e.g. 88.25 for 1 USD' },
            { name: 'effective_from', label: 'Effective from', type: 'date', required: true, hint: 'Applies to every record dated on or after this, until a later rate takes over.' },
            { name: 'note', label: 'Note', span: 'all', hint: 'Where the rate came from, if it helps' },
          ]}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete the ${removing.from_currency} rate from ${date(removing.effective_from)}?`}
          subtitle={`${removing.from_currency} ₹${Number(removing.rate).toFixed(2)}`}
          message={deleteText(removing)}
          confirmLabel="Delete rate"
          cancelLabel="Keep it"
          busy={busy}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </SettingsPane>
  );
}

/**
 * The rate's history for one currency, drawn from the tokens. Each point is
 * a button with its rate and date as its name, and the picked one shows a
 * callout, so nothing depends on hovering.
 */
function RateHistory({ rows, currencies }) {
  // Start on a currency that has rates, not just the first in the enum, or the
  // chart opens on "No EUR rates yet" beside a table full of USD.
  const [currency, setCurrency] = useState(() => rows[0]?.from_currency || currencies[0] || 'USD');
  const points = useMemo(() => rows
    .filter((row) => row.from_currency === currency)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from)), [rows, currency]);
  const [picked, setPicked] = useState(null);
  const at = picked != null && picked < points.length ? picked : points.length - 1;

  const t = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const t0 = points.length ? t(points[0].effective_from) : 0;
  const t1 = points.length ? t(points.at(-1).effective_from) : 1;
  const vals = points.map((p) => Number(p.rate));
  const lo = Math.floor(Math.min(...vals) - 0.6);
  const hi = Math.ceil(Math.max(...vals) + 0.6);
  const X = (iso) => (points.length < 2 ? 500 : 30 + ((t(iso) - t0) / Math.max(t1 - t0, 1)) * 940);
  const Y = (v) => 172 - ((v - lo) / Math.max(hi - lo, 1)) * 154;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.effective_from).toFixed(1)} ${Y(Number(p.rate)).toFixed(1)}`).join(' ');
  const area = points.length > 1 ? `${line} L${X(points.at(-1).effective_from).toFixed(1)} 190 L${X(points[0].effective_from).toFixed(1)} 190 Z` : '';
  const sel = points[at];
  const xLabels = points.length > 1 ? [points[0], points[Math.floor((points.length - 1) / 2)], points.at(-1)].filter((p, i, a) => a.indexOf(p) === i) : [];

  return (
    <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="set-rh">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-0.5">
          <h2 className="mg-panel__title" id="set-rh">Rate history</h2>
          <span className="mg-panel__hint">Pick a point to read its rate and the date it took effect.</span>
        </div>
        <div className="max-w-full overflow-x-auto">
          <Seg label="Currency" value={currency} width={62} options={currencies.map((c) => ({ value: c, label: c }))} onChange={(c) => { setCurrency(c); setPicked(null); }} />
        </div>
      </div>
      {!points.length ? (
        <p className="m-0 text-[13px] text-secondary-text">No {currency} rates yet. Add one to see how it has moved.</p>
      ) : points.length === 1 ? (
        <p className="m-0 text-[13px] text-secondary-text">
          One {currency} rate so far: <b className="text-foreground">₹{Number(sel.rate).toFixed(2)}</b> from {date(sel.effective_from)}. The line starts when a second one is added.
        </p>
      ) : (
        <div className="set-chart">
          <div className="set-chart__y" aria-hidden="true">
            {[hi, (hi + lo) / 2, lo].map((v) => <span key={v} style={{ top: Y(v) }}>₹{v.toFixed(2)}</span>)}
          </div>
          <div className="set-chart__plot">
            <svg className="mg-chart" width="100%" height="190" viewBox="0 0 1000 190" preserveAspectRatio="none" aria-hidden="true">
              {[hi, (hi + lo) / 2, lo].map((v) => <line key={v} x1="0" x2="1000" y1={Y(v)} y2={Y(v)} style={{ stroke: 'var(--line)' }} strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />)}
              <path d={area} style={{ fill: 'var(--track)' }} />
              <path d={line} fill="none" style={{ stroke: 'var(--figure)' }} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </svg>
            {points.map((p, i) => (
              <button
                key={p.id}
                type="button"
                className="set-chart__pt"
                aria-label={`${currency} ₹${Number(p.rate).toFixed(2)} from ${date(p.effective_from)}`}
                aria-pressed={i === at}
                onClick={() => setPicked(i)}
                onFocus={() => setPicked(i)}
                style={{ left: `${X(p.effective_from) / 10}%`, top: Y(Number(p.rate)) }}
              />
            ))}
            <div className="set-chart__tip" aria-live="polite" style={{ left: `${X(sel.effective_from) / 10}%`, top: Y(Number(sel.rate)), '--tx': X(sel.effective_from) < 160 ? '-14%' : X(sel.effective_from) > 840 ? '-86%' : '-50%' }}>
              {currency} ₹{Number(sel.rate).toFixed(2)} · from {date(sel.effective_from)}
            </div>
          </div>
          <span />
          <div className="set-chart__x" aria-hidden="true">
            {xLabels.map((p, i) => <span key={p.id} style={{ left: `${X(p.effective_from) / 10}%`, '--tx': i === 0 ? '-10%' : i === xLabels.length - 1 ? '-90%' : '-50%' }}>{date(p.effective_from)}</span>)}
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------- assumptions */

/** Settings that now have a pane of their own, with the context to match. */
const MOVED = new Set([
  'company_name', 'company_address', 'company_gstin', 'company_state_code', 'finance_email', 'company_gstins', 'partner_companies',
  'quotation_terms_default', 'emails_enabled',
  // Settings -> Report categories: JSON lists with their own editor.
  'report_sectors', 'report_service_lines',
  // Inbox setup (Mailboxes) and Scheduled reports keep these beside what they switch.
  'auto_po_enabled', 'auto_enquiries_enabled', 'email_readers_review_only', 'email_readers_auto_clients',
  'receivables_list_phrases', 'receivables_list_senders', 'personal_mis_enabled',
]);
const movedKey = (key) => MOVED.has(key) || key.startsWith('mis_') || key.startsWith('fx_rate_');

/**
 * The assumptions, grouped by the question they answer, in two columns.
 *
 * Every key already carries a written explanation in `settings.notes`, and
 * the API has always sent it. `quiet` hides it for the few keys whose note
 * only restates the label. Hints never truncate; on/off rows are switches;
 * a choice is said in words (Zoho Books, not `zoho`).
 */
const LEFT = [
  { id: 'q', title: 'Quoting', hint: 'What a new quotation starts from.', items: [
    { key: 'quotation_validity_days', label: 'A quotation stays open for', unit: 'days' },
    { key: 'quotation_expiry_warning_days', quiet: true, label: 'Warn its owner before it expires', unit: 'days' },
    { key: 'quotation_expiry_grace_days', label: 'Mark it lost after expiry', unit: 'days' },
    { key: 'acceptance_unviewed_days', quiet: true, label: 'Flag an unopened acceptance link after', unit: 'days' },
    { key: 'discount_approval_threshold_percent', label: 'Discount that needs approval', type: 'percent' },
    { key: 'gst_rate_default', label: 'GST on a new line', type: 'percent' },
  ] },
  { id: 'o', title: 'Orders and delivery', hint: 'Suggested when a PO is registered.', items: [
    { key: 'default_po_payment_terms_days', quiet: true, label: 'Payment terms on a new order', unit: 'days' },
    { key: 'deliverable_reminder_days', label: 'Remind before a certificate expires', type: 'list', unit: 'days' },
    { key: 'visit_reminder_days', label: 'Remind before a visit', unit: 'days' },
  ] },
  { id: 'g', title: 'Getting paid', hint: 'When the tracker chases, and how often.', items: [
    { key: 'reminder_grace_days', label: 'Wait after the due date', unit: 'days' },
    { key: 'reminder_levels_days', label: 'Reminders go out at', type: 'list', unit: 'days overdue' },
    { key: 'reminder_interval_days', label: 'Then repeat every', unit: 'days' },
    { key: 'no_contact_days', label: 'Call a deal untouched after', unit: 'days' },
  ] },
  { id: 'sq', title: 'Service questionnaires', hint: 'The form a client fills in before we quote.', items: [
    { key: 'questionnaire_link_days', label: 'A questionnaire link stays open for', unit: 'days' },
    { key: 'questionnaire_reminder_days', label: 'Remind a client who has not submitted after', unit: 'days' },
  ] },
  { id: 'cp', title: 'Client portal', hint: 'Emails to clients who have the portal switched on.', foot: 'These apply to every client. Each client’s own portal switches are on its company page.', items: [
    { key: 'portal_notify_new_invoice', label: 'Email portal contacts when an invoice is recorded', type: 'bool' },
    { key: 'portal_link_in_reminders', label: 'Add the portal address to payment reminders', type: 'bool' },
  ] },
  { id: 'p', title: 'What counts as a problem', hint: 'The thresholds behind the red and amber on every page.', items: [
    { key: 'margin_alert_percent', label: 'Flag a project margin below', type: 'percent' },
    { key: 'cost_alert_share_percent', label: 'Warn when costs pass this share of the order', type: 'percent' },
    { key: 'lead_first_response_hours', label: 'Target first response to an enquiry', unit: 'hours' },
    { key: 'lead_follow_up_default_days', label: 'Default next follow-up', unit: 'days' },
  ] },
  { id: 't', title: 'Travel vendors', hint: 'The travel desk’s defaults.', items: [
    { key: 'default_vendor_payment_terms_days', quiet: true, label: 'Suggested vendor terms', unit: 'days' },
    { key: 'vendor_invoice_window_days', label: 'A vendor must invoice within', unit: 'days' },
    { key: 'travel_import_trip_gap_days', label: 'In the travel import, separate trips more than this far apart', unit: 'days' },
  ] },
];
const RIGHT = [
  { id: 'f', title: 'Follow-ups', hint: 'An email to the owner, then to management if nothing is logged. Separate from the bell.', items: [
    { key: 'followup_enabled', label: 'Send follow-up reminders and escalations', type: 'bool' },
    { key: 'followup_enquiry_idle_days', label: 'Enquiry untouched for', unit: 'working days' },
    { key: 'followup_quotation_idle_days', label: 'Sent quotation untouched for', unit: 'working days' },
    { key: 'followup_invoice_overdue_days', label: 'Invoice overdue by', unit: 'days' },
    { key: 'followup_invoice_idle_days', label: 'Overdue invoice unchased for', unit: 'working days' },
    { key: 'followup_grace_days', label: 'Then tell management after', unit: 'working days' },
    { key: 'followup_reescalate_days', label: 'Remind management again every', unit: 'working days' },
    // Admins always get it. With the shared sign-in there are no admin
    // accounts, so this list (or the daily digest address) is everyone.
    { key: 'followup_escalation_emails', label: 'Management addresses, besides admins', type: 'emails' },
    { key: 'followup_cc_owner_on_escalation', label: 'Tell the owner when escalated', type: 'bool' },
    // When Insights counts an open enquiry as at risk.
    { key: 'enquiry_reply_days', label: 'Enquiry at risk with no reply after', unit: 'working days' },
    { key: 'enquiry_decision_warn_days', label: 'Or with no quotation this close to its decision date', unit: 'working days' },
  ] },
  { id: 'w', title: 'Who gets told', hint: 'Blank falls back to the accounts email on Company profile.', items: [
    { key: 'alert_email', label: 'Alerts', type: 'email' },
    { key: 'approver_email', label: 'Quotation approvals', type: 'email' },
    { key: 'digest_email', label: 'The daily digest', type: 'email' },
    { key: 'hr_email', label: 'Travel and reimbursements', type: 'email' },
  ] },
  { id: 'b', title: 'The books', hint: 'Where payments recorded outside the tracker come from.', items: [
    { key: 'accounting_provider', label: 'Where the books are', type: 'choice', options: [['none', 'Not connected'], ['zoho', 'Zoho Books'], ['tally', 'Tally'], ['file', 'A file export']] },
    { key: 'accounting_apply_payments', label: 'Apply payments found in the books', type: 'bool' },
  ] },
  { id: 'r', title: 'Running the tracker', hint: 'The lead’s settings rather than the desk’s.', items: [
    { key: 'public_app_url', label: 'Address clients open links on', type: 'text' },
    { key: 'internal_email_domains', label: 'Our own email domains', type: 'text' },
    { key: 'incoming_enquiries_enabled', label: 'Accept enquiries posted by webhook', type: 'bool' },
    { key: 'signin_lockout_failures', label: 'Failed sign-ins before a lockout', unit: 'tries' },
    { key: 'signin_lockout_minutes', quiet: true, label: 'A lockout lasts', unit: 'minutes' },
    { key: 'backup_max_age_hours', quiet: true, label: 'Alert with no backup for', unit: 'hours' },
    { key: 'backup_verify_max_age_days', quiet: true, label: 'Alert with no restore check for', unit: 'days' },
    { key: 'personal_mis_ai_limit', label: 'AI calls a day for the personal daily MIS', unit: 'calls' },
  ] },
];
const KNOWN = new Set([...LEFT, ...RIGHT].flatMap((g) => g.items.map((i) => i.key)));

/** "1 days" is the tell that nobody read the screen. */
function unitFor(unit, value) {
  if (!unit || Number(value) !== 1) return unit;
  return unit.replace(/^(working )?(days|hours|minutes|tries|calls)\b/, (m, working = '', word) => working + (word === 'tries' ? 'try' : word.slice(0, -1)));
}

/** A value as somebody would read it, rather than as it is stored. */
function shown(item, value) {
  if (value === undefined || value === null || value === '') return null;
  if (item.type === 'percent') return `${value}%`;
  if (item.type === 'choice') return item.options.find(([v]) => v === value)?.[1] ?? value;
  if (item.type === 'emails' || item.type === 'text') return String(value).split(',').map((v) => v.trim()).filter(Boolean).join(', ');
  if (item.type === 'list') {
    const parts = String(value).split(',').map((v) => v.trim()).filter(Boolean);
    const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
    return `${joined}${item.unit ? ` ${item.unit}` : ''}`;
  }
  const unit = unitFor(item.unit, value);
  return unit ? `${value} ${unit}` : value;
}

export function Assumptions() {
  // The thresholds every report and reminder is computed from. Readable by
  // everyone, changed by an admin (#85) — PATCH /api/settings is requireAdmin.
  const { isAdmin } = useAuth();
  const reader = useReader();
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/settings'));
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(null);

  const rows = data?.data ?? [];
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  // Anything the server grows that this file has not been taught about
  // still has to be editable, so it lands here rather than vanishing.
  const extras = rows
    .filter((r) => !KNOWN.has(r.key) && !movedKey(r.key))
    .map((r) => ({ key: r.key, label: r.notes || r.key.replace(/_/g, ' '), quiet: true }));
  const right = extras.length ? [...RIGHT, { id: 'x', title: 'Other settings', hint: 'Newer settings this page doesn’t group yet.', items: extras }] : RIGHT;

  async function save(key, value) {
    setBusy(true);
    setFail(null);
    try {
      await api.update('settings', key, { value });
      toast('Saved', 'success');
      invalidateLookups();
      setEditing(null);
      refetch();
    } catch (err) {
      if (editing === key) setFail(err.message); else toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  const row = (item) => {
    const r = byKey[item.key];
    if (!r) return null;
    const open = editing === item.key;
    const display = shown(item, r.value);
    const note = r.notes && !item.quiet ? r.notes : null;
    return (
      <div key={item.key} className="set-arow">
        <div className="set-arow__text">
          <div className="set-arow__label">{item.label}</div>
          {note && <p className="set-arow__note">{note}</p>}
        </div>
        {item.type === 'bool' ? (
          <label className="mg-switch">
            <span className="text-[12.5px] font-bold text-secondary-text">{r.value === 'true' ? 'On' : 'Off'}</span>
            <input type="checkbox" role="switch" aria-label={item.label} checked={r.value === 'true'} disabled={!isAdmin || busy} onChange={(e) => save(item.key, e.target.checked ? 'true' : 'false')} />
          </label>
        ) : open ? (
          <div className="set-arow__edit">
            <label className={cn('mg-field', fail && 'is-error')}>
              <span className="mg-field__label">{item.label}</span>
              {item.type === 'choice' ? (
                <span className="mg-select-wrap">
                  <select className="mg-select" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus>
                    {item.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </span>
              ) : (
                <input
                  className="mg-input"
                  autoFocus
                  type={item.type === 'email' ? 'email' : item.unit && item.type !== 'list' || item.type === 'percent' ? 'number' : 'text'}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') save(item.key, draft); if (e.key === 'Escape') setEditing(null); }}
                />
              )}
              {fail ? <span className="mg-field__error">{fail}</span>
                : item.type === 'emails' ? <span className="mg-field__hint">Email addresses, separated by commas.</span>
                : item.type === 'list' ? <span className="mg-field__hint">Numbers separated by commas{item.unit ? `, in ${item.unit}` : ''}.</span>
                : item.unit ? <span className="mg-field__hint">In {item.unit}.</span>
                : item.type === 'choice' ? <span className="mg-field__hint">One of: {item.options.map(([, l]) => l.toLowerCase()).join(', ')}.</span> : null}
            </label>
            <span className="set-arow__btns">
              <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" onClick={() => { setEditing(null); setFail(null); }}>Cancel</button>
              <button type="button" className="mg-btn mg-btn--sm mg-btn--primary" disabled={busy} onClick={() => save(item.key, draft)}>{busy ? 'Saving…' : 'Save'}</button>
            </span>
          </div>
        ) : (
          <span className={cn('set-arow__val', display === null && 'is-muted')}>
            {display ?? 'Not set'}
            {isAdmin && <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Change: ${item.label}`} onClick={() => { setEditing(item.key); setDraft(r.value ?? ''); setFail(null); }}>Change</button>}
          </span>
        )}
      </div>
    );
  };

  const group = (g) => {
    const items = g.items.filter((i) => byKey[i.key]);
    if (!items.length) return null;
    return (
      <section key={g.id} className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby={`set-as-${g.id}`} style={{ gap: 0 }}>
        <div className="flex flex-col gap-0.5 pb-3">
          <h2 className="mg-panel__title" id={`set-as-${g.id}`}>{g.title}</h2>
          <span className="mg-panel__hint">{g.hint}</span>
        </div>
        {items.map(row)}
        {g.foot && <p className="set-group-foot">{g.foot}</p>}
      </section>
    );
  };

  return (
    <SettingsPane
      title="Assumptions"
      description="The numbers the app computes with when a record doesn’t say otherwise. Changing one changes what every future calculation assumes; nothing already recorded moves."
      readOnly={reader}
    >
      {error ? <FailedCard title="Couldn’t load assumptions" text="The server didn’t answer, so nothing is shown. This isn’t “nothing set”: nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !data ? <LoadingPanel rows={5} />
      : (
        <>
          <div className="set-two">
            <div className="set-col">{LEFT.map(group)}</div>
            <div className="set-col">{right.map(group)}</div>
          </div>
          <p className="mg-glass set-note" data-a="rise">
            {isAdmin ? (
              <>The company’s own details are under <Link to="/settings/company">Company profile</Link>, the default quotation terms and payment splits under <Link to="/settings/templates">Templates</Link>, and the automatic-email switch under <Link to="/settings/emails">Emails &amp; jobs</Link>.</>
            ) : (
              <>Admins keep the company’s details under Company profile, the default quotation terms and payment splits under Templates, and the automatic-email switch under Emails &amp; jobs.</>
            )}
          </p>
        </>
      )}
    </SettingsPane>
  );
}

/* ---------------------------------------------------------- holidays */

/** Dates that follow the moon move; the row says so. */
const MOON = /\b(id|eid|muharram|milad|bakri|ramzan|ramadan)\b/i;

/**
 * The days nobody works (#73). Weekends are skipped anyway; this is the
 * list of weekday closures the working-day counts leave out.
 */
export function Holidays() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const reader = useReader();
  const { rows, loading, error, data, refetch } = useList('holidays', { limit: 500 });
  // 'new' or the row being changed. Moving a moon-dated holiday is an edit,
  // PATCH /api/holidays/:id, not a delete and a retype.
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const now = todayIso();
  const thisYear = now.slice(0, 4);
  const years = [...new Set([thisYear, ...rows.map((r) => String(r.holiday_on).slice(0, 4))])].sort();
  const [year, setYear] = useState(thisYear);
  const shownRows = rows.filter((r) => String(r.holiday_on).startsWith(year)).sort((a, b) => String(a.holiday_on).localeCompare(String(b.holiday_on)));
  const upcoming = rows.filter((r) => String(r.holiday_on).slice(0, 10) >= now).sort((a, b) => String(a.holiday_on).localeCompare(String(b.holiday_on)));
  const next = upcoming[0];
  const inYear = rows.filter((r) => String(r.holiday_on).startsWith(thisYear));
  const nextYear = String(Number(thisYear) + 1);
  const forNext = rows.filter((r) => String(r.holiday_on).startsWith(nextYear)).length;
  const daysTo = next ? Math.round((Date.parse(`${String(next.holiday_on).slice(0, 10)}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) / 86400000) : 0;

  async function remove(row) {
    setBusy(true);
    try {
      await api.remove('holidays', row.id);
      toast('Holiday deleted', 'success');
      setRemoving(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  const weekday = (r) => WEEKDAYS[dayOf(r.holiday_on)];
  const passed = (r) => String(r.holiday_on).slice(0, 10) < now;

  return (
    <SettingsPane
      title="Holidays"
      description="Days the office is closed. Working-day counts skip these as well as Saturdays and Sundays."
      readOnly={reader}
      actions={isAdmin && <button type="button" className="mg-btn mg-btn--primary" onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" />Add a holiday</button>}
    >
      {error ? <FailedCard title="Couldn’t load holidays" text="The server didn’t answer, so nothing is shown. This isn’t “nothing set”: nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !data ? <LoadingPanel rows={4} />
      : rows.length === 0 ? (
        <StateCard tone="plain" title="No holidays yet" text="Add the weekdays the office is closed, and working-day counts will skip them.">
          {isAdmin && <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setEditing('new')}>Add a holiday</button>}
        </StateCard>
      ) : (
        <>
          <SetStrip
            label="Holidays at a glance"
            cells={[
              { label: 'Next holiday', figure: next ? next.name : 'None set', tone: next ? undefined : 'muted', foot: next ? `${WEEKDAYS[dayOf(next.holiday_on)].slice(0, 3)} ${shortDay(next.holiday_on)} · ${daysTo === 0 ? 'today' : daysTo === 1 ? 'tomorrow' : `in ${daysTo} days`}` : 'Add the coming ones' },
              { label: `Weekday holidays in ${thisYear}`, figure: String(inYear.length), foot: `${inYear.filter((r) => !passed(r)).length} still to come` },
              { label: `Added for ${nextYear}`, figure: String(forNext), foot: forNext ? 'Add the rest when the list is out' : 'None yet' },
            ]}
          />
          <Panel
            id="set-hol"
            title={`${year} holidays`}
            hint="Saturdays and Sundays are already off. Days that have passed are greyed."
            tools={years.length > 1 && <div className="max-w-full overflow-x-auto"><Seg label="Year" value={year} width={72} options={years.map((y) => ({ value: y, label: y }))} onChange={setYear} /></div>}
          >
            {shownRows.length === 0 ? (
              <StateCard inPanel tone="plain" title={`No holidays in ${year} yet`} text="Add them when the list is out." />
            ) : (
              <ListTable
                label="Holidays"
                rows={shownRows}
                rowClassName={(r) => (passed(r) ? 'set-passed' : undefined)}
                columns={[
                  { key: 'holiday_on', header: 'Date', width: '130px', render: (r) => <b>{date(r.holiday_on)}</b> },
                  { key: 'weekday', header: 'Day', width: '160px', render: (r) => <span className="text-secondary-text">{weekday(r)}</span> },
                  { key: 'name', header: 'Holiday', className: 'app-wrap', render: (r) => <><b className="font-semibold">{r.name}</b>{MOON.test(r.name) && <span className="set-sub">Follows the moon: correct the date here if it moves</span>}</> },
                  ...(isAdmin ? [{ key: 'act', header: '', className: 'actions', render: (r) => (
                    <RowActions>
                      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>Edit</button>
                      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Delete ${r.name} on ${date(r.holiday_on)}`} onClick={() => setRemoving(r)}>Delete</button>
                    </RowActions>
                  ) }] : []),
                ]}
                phone={(r) => (
                  <PhoneRow title={r.name} amount={shortDay(r.holiday_on)} meta={[weekday(r), MOON.test(r.name) && 'follows the moon', passed(r) && 'passed'].filter(Boolean).join(' · ')} className={passed(r) ? 'set-hidden-row' : undefined}>
                    {isAdmin && <span className="set-rowacts">
                      <button type="button" className="mg-btn mg-btn--sm" onClick={() => setEditing(r)}>Edit</button>
                      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setRemoving(r)}>Delete</button>
                    </span>}
                  </PhoneRow>
                )}
              />
            )}
          </Panel>
        </>
      )}

      {editing && (
        <RecordForm
          title={editing === 'new' ? 'New holiday' : `Edit ${editing.name}`}
          subtitle={editing === 'new' ? 'A weekday the office is closed' : `${WEEKDAYS[dayOf(editing.holiday_on)].slice(0, 3)} ${date(editing.holiday_on)}`}
          submitLabel={editing === 'new' ? 'Add holiday' : 'Save changes'}
          size="sm"
          resource="holidays"
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch(); }}
          fields={[
            { name: 'holiday_on', label: 'Date', type: 'date', required: true },
            { name: 'name', label: 'Name', required: true, hint: 'e.g. Republic Day' },
          ]}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name} on ${WEEKDAYS[dayOf(removing.holiday_on)].slice(0, 3)} ${shortDay(removing.holiday_on)}?`}
          subtitle={`Holiday · ${String(removing.holiday_on).slice(0, 4)}`}
          message={`${shortDay(removing.holiday_on)} becomes a working day again, so working-day counts and due dates treat it like any other ${WEEKDAYS[dayOf(removing.holiday_on)]}.`}
          confirmLabel="Delete holiday"
          cancelLabel="Keep it"
          busy={busy}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </SettingsPane>
  );
}

/* --------------------------------------------------------- the lists */

export function Catalogue({ resource, label, title, hint, extraFields = [] }) {
  // A Settings list: an admin curates it, everybody reads it, because the same
  // rows fill the dropdowns sales users work in (#85). The travel desk keeps
  // the travel lists too (#196).
  const auth = useAuth();
  const writer = mayWriteResource(resource, auth.isAdmin, auth.isHr);
  const toast = useToast();
  const { rows, loading, error, data, refetch } = useList(resource, {});
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  const lower = label.toLowerCase();
  const plural = title.toLowerCase();
  const isVendors = resource === 'travel-vendors';

  async function toggle(row, undo = false) {
    try {
      await api.update(resource, row.id, { active: !row.active });
      invalidateLookups();
      refetch();
      if (undo) return;
      if (row.active) undoToast(`${row.name} is hidden from dropdowns.`, () => toggle({ ...row, active: false }, true));
      else toast(`${row.name} is back in dropdowns.`, 'success');
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const active = rows.filter((r) => r.active).length;
  const ql = q.trim().toLowerCase();
  const visible = rows
    .filter((r) => (show === 'all' ? true : show === 'active' ? r.active : !r.active))
    .filter((r) => !ql || [r.name, r.code, r.gstin, ...(r.invoice_prefixes || [])].filter(Boolean).join(' ').toLowerCase().includes(ql));

  const sub = (r) => {
    if (resource === 'services') return [r.unit && `per ${r.unit}`, r.code].filter(Boolean).join(' · ');
    if (isVendors) return [r.contact_name, r.email || r.phone].filter(Boolean).join(' · ');
    return '';
  };
  const cols = [
    { key: 'name', header: 'Name', className: 'app-wrap', render: (r) => <><b>{r.name}</b>{sub(r) && <span className="set-sub">{sub(r)}</span>}</> },
    ...(resource === 'services' ? [
      { key: 'default_rate', header: 'Default rate', num: true, render: (r) => <b className="font-semibold">{r.default_rate == null ? '—' : money(r.default_rate, r.currency)}</b> },
      { key: 'gst_rate', header: 'GST', num: true, render: (r) => `${Number(r.gst_rate)}%` },
      { key: 'sac_code', header: 'SAC', render: (r) => <span className="text-secondary-text">{r.sac_code || '—'}</span> },
    ] : []),
    ...(isVendors ? [
      { key: 'gstin', header: 'GSTIN', render: (r) => <span className="set-mono text-secondary-text">{r.gstin || '—'}</span> },
      { key: 'invoice_prefixes', header: 'Invoice prefixes', className: 'app-wrap--sm', render: (r) => <span className="text-secondary-text">{r.invoice_prefixes?.length ? r.invoice_prefixes.join(', ') : '—'}</span> },
      { key: 'payment_terms_days', header: 'Terms', num: true, render: (r) => days(r.payment_terms_days) },
    ] : []),
    ...(resource === 'trip-types' ? [{ key: 'chargeable', header: 'Billable to the client', render: (r) => (r.chargeable ? 'Yes' : 'No') }] : []),
    { key: 'active', header: 'Status', render: (r) => <Tone tone={r.active ? 'ok' : 'plain'}>{r.active ? 'Active' : 'Hidden'}</Tone> },
    ...(writer ? [{ key: 'act', header: '', className: 'actions', render: (r) => (
      <RowActions>
        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>Edit</button>
        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`${r.active ? 'Hide' : 'Restore'} ${r.name}`} onClick={() => toggle(r)}>{r.active ? 'Hide' : 'Restore'}</button>
      </RowActions>
    ) }] : []),
  ];
  const phoneMeta = (r) => {
    if (resource === 'services') return [sub(r), `GST ${Number(r.gst_rate)}%`, r.sac_code && `SAC ${r.sac_code}`].filter(Boolean).join(' · ');
    if (isVendors) return [r.invoice_prefixes?.join(', '), r.gstin].filter(Boolean).join(' · ');
    if (resource === 'trip-types') return `Billable to the client: ${r.chargeable ? 'Yes' : 'No'}`;
    return null;
  };

  return (
    <SettingsPane
      title={title}
      description={hint}
      readOnly={!writer && (CATALOGUE_HR.has(resource) ? 'Read only: an admin or the travel desk changes these' : 'Read only: an admin changes these')}
      actions={writer && <button type="button" className="mg-btn mg-btn--primary" onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" />Add {an(lower)} {lower}</button>}
    >
      {error ? <FailedCard title={`Couldn’t load ${plural}`} text="The server didn’t answer, so nothing is shown. This isn’t “nothing set”: nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !data ? <LoadingPanel rows={4} />
      : rows.length === 0 ? (
        <StateCard tone="plain" title={`No ${plural} yet`} text={EMPTY[resource] || `Add the first ${lower}; it shows in the dropdowns that use this list.`}>
          {writer && <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setEditing('new')}>Add {an(lower)} {lower}</button>}
        </StateCard>
      ) : (
        <Panel
          id={`set-${resource}`}
          title={title}
          hint="Hidden ones stay on old records but aren’t offered in dropdowns."
          tools={
            <div className="set-tools">
              <label className="mg-search">
                <Search aria-hidden="true" />
                <input className="mg-input" type="search" placeholder={`Find ${an(lower)} ${lower}`} aria-label={`Find ${an(lower)} ${lower}`} value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
              <div className="set-chips">
                {[['all', `All · ${rows.length}`], ['active', `Active · ${active}`], ['hidden', `Hidden · ${rows.length - active}`]].map(([k, l]) => (
                  <button key={k} type="button" className="mg-chip" aria-pressed={show === k} onClick={() => setShow(k)}>{l}</button>
                ))}
              </div>
            </div>
          }
        >
          {visible.length === 0 ? (
            <StateCard inPanel tone="plain" title={`No ${plural} match`} text="Nothing on this list fits what you typed or picked.">
              <button type="button" className="mg-btn mg-btn--sm" onClick={() => { setQ(''); setShow('all'); }}>Clear filters</button>
            </StateCard>
          ) : (
            <ListTable
              label={title}
              rows={visible}
              rowClassName={(r) => (r.active ? undefined : 'set-hidden-row')}
              columns={cols}
              phone={(r) => (
                <PhoneRow
                  title={r.name}
                  amount={resource === 'services' ? (r.default_rate == null ? '' : money(r.default_rate, r.currency)) : isVendors ? days(r.payment_terms_days) : ''}
                  meta={phoneMeta(r)}
                  state={<Tone tone={r.active ? 'ok' : 'plain'}>{r.active ? 'Active' : 'Hidden'}</Tone>}
                  className={r.active ? undefined : 'set-hidden-row'}
                >
                  {writer && <span className="set-rowacts">
                    <button type="button" className="mg-btn mg-btn--sm" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>Edit</button>
                    <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`${r.active ? 'Hide' : 'Restore'} ${r.name}`} onClick={() => toggle(r)}>{r.active ? 'Hide' : 'Restore'}</button>
                  </span>}
                </PhoneRow>
              )}
            />
          )}
        </Panel>
      )}

      {editing && (
        <RecordForm
          title={editing === 'new' ? `New ${lower}` : `Edit ${editing.name}`}
          subtitle={editing === 'new' ? 'Offered in dropdowns as soon as it’s added' : `${label} · records already using it keep it`}
          submitLabel={editing === 'new' ? `Add ${lower}` : 'Save changes'}
          size={resource === 'services' || isVendors ? 'lg' : 'sm'}
          resource={resource}
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidateLookups();
            refetch();
          }}
          fields={[
            { name: 'name', label: 'Name', required: true, span: 'all' },
            ...(resource === 'services' ? [
              { name: 'default_rate', label: 'Default rate', type: 'money', hint: 'Filled in when the service is picked on a quotation line' },
              { name: 'currency', label: 'Currency', type: 'select', options: ['INR', 'EUR', 'USD', 'GBP', 'AED', 'SGD'], default: 'INR' },
              { name: 'gst_rate', label: 'GST %', type: 'number', step: '0.01', default: '18' },
              { name: 'unit', label: 'Unit', type: 'combo', options: ['engagement', 'site', 'day', 'audit', 'report', 'year'], default: 'engagement', hint: 'Or type another.' },
              { name: 'sac_code', label: 'SAC code', hint: 'Printed on the quotation line' },
              { name: 'code', label: 'Internal code' },
              { name: 'description', label: 'Default line description', type: 'textarea', span: 'all' },
              { name: 'sort_order', label: 'Sort order', type: 'number', default: '0' },
            ] : []),
            ...extraFields,
            { name: 'active', label: 'Visible in dropdowns', type: 'boolean', default: 'true', hint: 'Hidden ones stay on old records.' },
          ]}
        />
      )}
    </SettingsPane>
  );
}

/** The travel desk's lists (#196): HR keeps them as an admin does. */
const CATALOGUE_HR = new Set(['travel-vendors', 'trip-types']);

const EMPTY = {
  services: 'Add what you quote for; each one fills in its rate and GST on a quotation line.',
  'travel-vendors': 'Add the agencies trips are booked through, with their invoice prefixes so the travel import recognises their bills.',
  'trip-types': 'Add what trips are for, and whether a client can be billed for them.',
  'expense-categories': 'Add what employees can claim against.',
};
