import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Chip, RecordSection } from '../components/record.jsx';
import { cn } from 'cn';
import { Card, DataTable, Tabs, Badge, Alert, Empty, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { money } from '../lib/format.js';
import { ApiTokens } from '../components/ApiTokens.jsx';
import { UsersAdmin } from '../components/UsersAdmin.jsx';
import { api } from '../lib/api.js';
import { useFetch, useList, useLookups, invalidateLookups } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { mayWriteResource } from '../lib/permissions.js';
import { date } from '../lib/format.js';

export const CATALOGUES = {
  services: { resource: 'services', label: 'Service', title: 'Service offerings', hint: 'Offered on quotations and PO service lines' },
  // The travel desk keeps these two (#196): HR edits them as an admin does.
  'travel-vendors': {
    resource: 'travel-vendors', label: 'Travel vendor', title: 'Travel vendors', hr: true,
    hint: 'Who trips are booked through. The invoice prefixes are how the travel import recognises a vendor\'s bills',
    extraColumns: [
      { key: 'gstin', header: 'GSTIN', className: 'mono', render: (r) => r.gstin || '—' },
      { key: 'invoice_prefixes', header: 'Invoice prefixes', className: 'mono small', render: (r) => (r.invoice_prefixes?.length ? r.invoice_prefixes.join(', ') : '—') },
      { key: 'payment_terms_days', header: 'Terms', align: 'right', render: (r) => `${r.payment_terms_days} days` },
    ],
    extraFields: [
      { name: 'gstin', label: 'GSTIN' }, { name: 'pan', label: 'PAN' },
      { name: 'contact_name', label: 'Contact' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' },
      { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', default: '30' },
      { name: 'invoice_prefixes', label: 'Invoice number prefixes', hint: 'Comma separated, e.g. HT/2627/, HTT/26-27/', span: 'all' },
      { name: 'address', label: 'Address', type: 'textarea', span: 'all' },
    ],
  },
  'trip-types': {
    resource: 'trip-types', label: 'Trip type', title: 'Trip types', hr: true,
    hint: 'What a trip was for. A chargeable type may be billed to the client; one in use can be hidden but not deleted',
    extraColumns: [{ key: 'chargeable', header: 'Chargeable', render: (r) => (r.chargeable ? 'Yes' : 'No') }],
    extraFields: [
      { name: 'chargeable', label: 'Billable to the client', type: 'boolean', default: 'false' },
      { name: 'sort_order', label: 'Sort order', type: 'number', default: '0' },
    ],
  },
  'expense-categories': { resource: 'expense-categories', label: 'Expense category', title: 'Expense categories', hint: 'What employees can claim against' },
};

export default function Settings() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState('services');

  // Users is an admin tab. Hiding it is only tidiness — every route behind
  // it is guarded by requireAdmin on the server, so a sales user who found
  // the tab anyway would get 403 from each one.
  const tabs = [
    ...Object.entries(CATALOGUES).map(([key, c]) => ({ key, label: c.title })),
    ...(isAdmin ? [{ key: 'users', label: 'Users' }] : []),
  ];
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;

  return (
    <>
      <PageHeader title="Settings" subtitle="The lists and assumptions the rest of the app reads from" />

      <div className="page stack">
        <ExchangeRates />
        <Assumptions />

        <Tabs active={active} onChange={setTab} tabs={tabs} />

        {active === 'users' ? <UsersAdmin /> : <Catalogue key={active} {...CATALOGUES[active]} />}

        {isAdmin && <ApiTokens />}
      </div>
    </>
  );
}

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
  const toast = useToast();
  const lookups = useLookups();
  const { rows, loading, refetch } = useList('exchange-rates', { limit: 500 });
  const [editing, setEditing] = useState(null);

  const currencies = (lookups.enums?.currency || ['INR', 'EUR', 'USD', 'GBP', 'AED', 'SGD']).filter((c) => c !== 'INR');
  // Newest first per currency, so the rate in force today is the one on top.
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.from_currency)) latest.set(row.from_currency, row.id);
  // Only currencies something is actually recorded in: warning about a rate
  // nothing needs trains people to ignore the warning.
  const inUse = lookups.currencies_in_use ?? [];
  const missing = inUse.filter((c) => c !== 'INR' && !latest.has(c));

  async function remove(row) {
    // The earliest rate for a currency has nothing before it, so deleting it
    // does not "fall back" — everything older simply stops converting.
    const earliest = !rows.some((r) => r.from_currency === row.from_currency
      && r.effective_from < row.effective_from);
    const warning = earliest
      ? `Delete the ${row.from_currency} rate effective ${row.effective_from}? It is the earliest ${row.from_currency} rate, so every figure dated before the next one would be left out of the INR totals and reported unconverted.`
      : `Delete the ${row.from_currency} rate effective ${row.effective_from}? Figures dated on or after it will fall back to the previous rate.`;
    if (!window.confirm(warning)) return;
    try {
      await api.remove('exchange-rates', row.id);
      toast('Rate deleted', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <SettingsPane
      title="Exchange rates"
      description="INR for one unit, from the date it took effect. Reports convert each figure at the rate in force on its own date, so a restated rate never rewrites history."
      actions={isAdmin && <Button size="sm" className="h-8 px-4 text-[13px]" onClick={() => setEditing('new')}>Add a rate</Button>}
    >
      <Card flush>
        {missing.length > 0 && (
          <Alert tone="warning">
            <span>
              No rate is set for <strong>{missing.join(', ')}</strong>. Amounts in those currencies are
              left out of every INR figure and reported separately until a rate is added.
            </span>
          </Alert>
        )}
        {rows.length > 0 && <RateHistoryChart rows={rows} currencies={currencies} />}
        <DataTable
          loading={loading}
          rows={rows}
          columns={[
            { key: 'from_currency', header: 'Currency', className: 'strong' },
            { key: 'rate', header: 'INR for 1 unit', align: 'right', render: (r) => `₹${r.rate}` },
            { key: 'effective_from', header: 'Effective from' },
            {
              key: 'in_force',
              header: '',
              render: (r) => (latest.get(r.from_currency) === r.id ? <Badge tone="success">Current</Badge> : null),
            },
            { key: 'source', header: 'Source', render: (r) => <Badge tone="neutral">{r.source}</Badge> },
            { key: 'note', header: 'Note', className: 'muted' },
            {
              key: 'act',
              header: '',
              align: 'right',
              render: (r) => (
                <div className="table__actions">
                  {isAdmin && (
                    <>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(r)}>Edit</button>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(r)}>Delete</button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
          empty={<Empty title="No exchange rates yet" text="Add one per currency, dated from when it applied." />}
        />
      </Card>

      {editing && (
        <RecordForm
          title={editing === 'new' ? 'New exchange rate' : 'Edit exchange rate'}
          resource="exchange-rates"
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refetch}
          fields={[
            { name: 'from_currency', label: 'Currency', type: 'select', options: currencies, required: true },
            { name: 'rate', label: 'INR for 1 unit', type: 'number', step: '0.000001', required: true, hint: 'e.g. 88.25 for 1 USD' },
            {
              name: 'effective_from',
              label: 'Effective from',
              type: 'date',
              required: true,
              hint: 'Applies to every record dated on or after this, until a later rate takes over',
            },
            { name: 'note', label: 'Note', span: 'all', hint: 'Where the rate came from, if it helps' },
          ]}
        />
      )}
    </SettingsPane>
  );
}

function RateHistoryChart({ rows, currencies }) {
  // Start on a currency that has rates, not just the first in the enum, or the
  // chart opens on "No EUR rates yet" beside a table full of USD.
  const [currency, setCurrency] = useState(() => rows[0]?.from_currency || currencies[0] || 'EUR');
  const points = rows
    .filter((row) => row.from_currency === currency)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  const width = 720;
  const height = 170;
  const pad = { top: 16, right: 18, bottom: 28, left: 48 };
  const values = points.map((point) => Number(point.rate));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max * 0.05, 1);
  const x = (index) => pad.left + (index / Math.max(points.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + ((max - value) / span) * (height - pad.top - pad.bottom);
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(Number(point.rate))}`).join(' ');

  return (
    <div className="rate-chart" aria-label={`${currency} exchange-rate history`}>
      <div className="rate-chart__head">
        <div>
          <strong>Rate history</strong>
          <span className="small muted">Hover a point for the rate and effective date.</span>
        </div>
        <span className="spacer" />
        <select className="select" value={currency} onChange={(event) => setCurrency(event.target.value)} aria-label="Rate history currency">
          {currencies.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      {!points.length ? (
        <p className="small muted">No {currency} rates yet. Add one to see how it has moved.</p>
      ) : (
      <svg viewBox={`0 0 ${width} ${height}`} role="img" className="rate-chart__svg">
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} stroke="var(--ink-200)" />
        <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="var(--ink-200)" />
        <path d={path} fill="none" stroke="var(--brand-600)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((point, index) => (
          <circle key={point.id} cx={x(index)} cy={y(Number(point.rate))} r="3.5" fill="var(--white)" stroke="var(--brand-600)" strokeWidth="2">
            <title>{`${point.from_currency}: ₹${point.rate} from ${point.effective_from}`}</title>
          </circle>
        ))}
        <text x={pad.left - 8} y={pad.top + 4} textAnchor="end" className="chart-label">₹{max}</text>
        <text x={pad.left - 8} y={height - pad.bottom + 4} textAnchor="end" className="chart-label">₹{min}</text>
        <text x={pad.left} y={height - 8} className="chart-label">{points[0].effective_from}</text>
        <text x={width - pad.right} y={height - 8} textAnchor="end" className="chart-label">{points.at(-1).effective_from}</text>
      </svg>
      )}
    </div>
  );
}

/** Settings that now have a pane of their own, with the context to match. */
const MOVED = new Set([
  'company_name', 'company_address', 'company_gstin', 'company_state_code', 'finance_email',
  'quotation_terms_default', 'emails_enabled',
  // Settings -> Report categories: JSON lists with their own editor.
  'report_sectors', 'report_service_lines',
]);

/**
 * The assumptions, grouped by the question they answer.
 *
 * They were one alphabetical list of thirty-four keys, which meant the
 * names had to carry the grouping themselves — `quotation_expiry_grace_days`
 * next to `quotation_expiry_warning_days` next to `quotation_validity_days`
 * — and a person hunting for "how long does a quote last" had to read all
 * of them. Grouped, the prefixes are redundant and the labels can be the
 * words somebody would actually say.
 *
 * Every key already carries a written explanation in `settings.notes`, and
 * the API has always sent it. The old table dropped it on the floor.
 *
 * `quiet` hides that explanation for the few keys whose note only restates
 * the label — "Suggested vendor terms" over "Suggested terms for travel
 * vendor invoices" is the same sentence twice, which is the duplication
 * this screen was meant to remove rather than relocate.
 */
const GROUPS = [
  {
    title: 'Quoting',
    hint: 'what a new quotation starts from',
    items: [
      { key: 'quotation_validity_days', label: 'A quotation stays open for', unit: 'days' },
      { key: 'quotation_expiry_warning_days', quiet: true, label: 'Warn its owner before it expires', unit: 'days' },
      { key: 'quotation_expiry_grace_days', label: 'Mark it lost after expiry', unit: 'days' },
      { key: 'acceptance_unviewed_days', quiet: true, label: 'Flag an unopened acceptance link after', unit: 'days' },
      { key: 'discount_approval_threshold_percent', label: 'Discount that needs approval', type: 'percent' },
      { key: 'gst_rate_default', label: 'GST on a new line', type: 'percent' },
    ],
  },
  {
    title: 'Orders and delivery',
    hint: 'suggested when a PO is registered',
    items: [
      { key: 'default_po_payment_terms_days', quiet: true, label: 'Payment terms on a new order', unit: 'days' },
      { key: 'deliverable_reminder_days', label: 'Remind before a certificate expires', type: 'list', unit: 'days' },
      { key: 'visit_reminder_days', label: 'Remind before a visit', unit: 'days' },
    ],
  },
  {
    title: 'Getting paid',
    hint: 'when the tracker chases, and how often',
    items: [
      { key: 'reminder_grace_days', label: 'Wait after the due date', unit: 'days' },
      { key: 'reminder_levels_days', label: 'Reminders go out at', type: 'list', unit: 'days overdue' },
      { key: 'reminder_interval_days', label: 'Then repeat every', unit: 'days' },
      { key: 'no_contact_days', label: 'Call a deal untouched after', unit: 'days' },
    ],
  },
  {
    title: 'Follow-ups',
    hint: 'an email to the owner, then to management if nothing is logged; separate from the bell',
    items: [
      { key: 'followup_enabled', label: 'Send follow-up reminders and escalations', type: 'bool' },
      { key: 'followup_enquiry_idle_days', label: 'Enquiry untouched for', unit: 'working days' },
      { key: 'followup_quotation_idle_days', label: 'Sent quotation untouched for', unit: 'working days' },
      { key: 'followup_invoice_overdue_days', label: 'Invoice overdue by', unit: 'days' },
      { key: 'followup_invoice_idle_days', label: 'Overdue invoice unchased for', unit: 'working days' },
      { key: 'followup_grace_days', label: 'Then tell management after', unit: 'working days' },
      { key: 'followup_reescalate_days', label: 'Remind management again every', unit: 'working days' },
      // Admins always get it. With the shared sign-in there are no admin
      // accounts, so this list (or the daily digest address) is everyone.
      { key: 'followup_escalation_emails', label: 'Management addresses, besides admins', type: 'list' },
      { key: 'followup_cc_owner_on_escalation', label: 'Tell the owner when escalated', type: 'bool' },
      // When Insights counts an open enquiry as at risk.
      { key: 'enquiry_reply_days', label: 'Enquiry at risk with no reply after', unit: 'working days' },
      { key: 'enquiry_decision_warn_days', label: 'Or with no quotation this close to its decision date', unit: 'working days' },
    ],
  },
  {
    title: 'What counts as a problem',
    hint: 'the thresholds behind the red and amber on every page',
    items: [
      { key: 'margin_alert_percent', label: 'Flag a project margin below', type: 'percent' },
      { key: 'cost_alert_share_percent', label: 'Warn when costs pass this share of the order', type: 'percent' },
      { key: 'lead_first_response_hours', label: 'Target first response to an enquiry', unit: 'hours' },
      { key: 'lead_follow_up_default_days', label: 'Default next follow-up', unit: 'days' },
    ],
  },
  {
    title: 'Travel vendors',
    items: [
      { key: 'default_vendor_payment_terms_days', quiet: true, label: 'Suggested vendor terms', unit: 'days' },
      { key: 'vendor_invoice_window_days', label: 'A vendor must invoice within', unit: 'days' },
    ],
  },
  {
    title: 'Who gets told',
    hint: 'blank falls back to the accounts email on Company profile',
    items: [
      { key: 'alert_email', label: 'Alerts', type: 'email' },
      { key: 'approver_email', label: 'Quotation approvals', type: 'email' },
      { key: 'digest_email', label: 'The daily digest', type: 'email' },
      { key: 'hr_email', label: 'Travel and reimbursements', type: 'email' },
    ],
  },
  {
    title: 'The books',
    items: [
      { key: 'accounting_provider', quiet: true, label: 'Where the books are', type: 'choice', options: ['none', 'zoho', 'tally', 'file'] },
      { key: 'accounting_apply_payments', label: 'Apply payments found in the books', type: 'bool' },
    ],
  },
  {
    title: 'Running the tracker',
    hint: 'the lead’s settings rather than the desk’s',
    items: [
      { key: 'public_app_url', label: 'Address clients open links on', type: 'text' },
      { key: 'internal_email_domains', label: 'Our own email domains', type: 'text' },
      { key: 'incoming_enquiries_enabled', label: 'Accept enquiries posted by webhook', type: 'bool' },
      { key: 'signin_lockout_failures', label: 'Failed sign-ins before a lockout', unit: 'tries' },
      { key: 'signin_lockout_minutes', quiet: true, label: 'A lockout lasts', unit: 'minutes' },
      { key: 'backup_max_age_hours', quiet: true, label: 'Alert with no backup for', unit: 'hours' },
      { key: 'backup_verify_max_age_days', quiet: true, label: 'Alert with no restore check for', unit: 'days' },
    ],
  },
];

const KNOWN = new Set(GROUPS.flatMap((g) => g.items.map((i) => i.key)));

/** "1 days" is the tell that nobody read the screen. */
function unitFor(unit, value) {
  if (!unit || Number(value) !== 1) return unit;
  return unit.replace(/^(working )?(days|hours|minutes|tries)\b/, (m, working = '', word) => working + (word === 'tries' ? 'try' : word.slice(0, -1)));
}

/** A value as somebody would read it, rather than as it is stored. */
function shown(item, value) {
  if (value === undefined || value === '') return null;
  if (item.type === 'bool') return value === 'true' ? 'On' : 'Off';
  if (item.type === 'percent') return `${value}%`;
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
  const toast = useToast();
  const { data, loading, refetch } = useFetch(() => api.raw('/settings'));
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = data?.data ?? [];
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  // Anything the server grows that this file has not been taught about
  // still has to be editable, so it lands here rather than vanishing.
  const extras = rows
    .filter((r) => !KNOWN.has(r.key) && !MOVED.has(r.key) && !r.key.startsWith('fx_rate_'))
    .map((r) => ({ key: r.key, label: r.key.replace(/_/g, ' ') }));
  const groups = extras.length ? [...GROUPS, { title: 'Anything else', items: extras }] : GROUPS;

  async function save(key) {
    setBusy(true);
    try {
      await api.update('settings', key, { value: draft });
      toast('Saved', 'success');
      invalidateLookups();
      setEditing(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <div className="skeleton" style={{ height: 240 }} />;

  return (
    <SettingsPane
      title="Assumptions"
      description="The numbers the app computes with when a record does not say otherwise. Changing one changes what every future calculation assumes; nothing already recorded moves."
    >
      {groups.map((group) => (
        <RecordSection key={group.title} title={group.title} hint={group.hint}>
          {group.items.map((item, i) => {
            const row = byKey[item.key];
            if (!row) return null;
            const open = editing === item.key;
            const display = shown(item, row.value);
            return (
              <div
                key={item.key}
                className={cn('flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3', i < group.items.length - 1 && 'border-b border-border')}
              >
                <div className="min-w-[14rem] flex-1">
                  <div className="text-[13px] font-medium text-foreground">{item.label}</div>
                  {row.notes && !item.quiet && <p className="mt-0.5 max-w-[68ch] text-[12px]/[1.5] text-muted-foreground">{row.notes}</p>}
                </div>

                {open ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {item.type === 'bool' || item.type === 'choice' ? (
                      <Select value={draft} onValueChange={setDraft}>
                        <SelectTrigger size="sm" className="h-7 w-[11rem] text-[12.5px]" aria-label={item.label}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(item.type === 'bool' ? ['true', 'false'] : item.options).map((o) => (
                            <SelectItem key={o} value={o} className="text-[12.5px]">
                              {item.type === 'bool' ? (o === 'true' ? 'On' : 'Off') : o}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        autoFocus
                        className="h-7 w-[11rem] text-[12.5px]"
                        aria-label={item.label}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') save(item.key); if (e.key === 'Escape') setEditing(null); }}
                      />
                    )}
                    <Button size="sm" className="h-7 px-3 text-[12.5px]" disabled={busy} onClick={() => save(item.key)}>Save</Button>
                    <Button variant="ghost" size="sm" className="h-7 px-3 text-[12.5px]" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    {display === null ? (
                      <span className="text-[12.5px] text-muted-foreground">not set</span>
                    ) : item.type === 'bool' ? (
                      <Chip tone={row.value === 'true' ? 'settled' : 'plain'}>{display}</Chip>
                    ) : (
                      <span className="mono text-[13px] text-foreground">{display}</span>
                    )}
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-3 text-[12.5px]"
                        onClick={() => { setEditing(item.key); setDraft(row.value); }}
                      >
                        Edit
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </RecordSection>
      ))}

      <p className="max-w-[70ch] text-[11.5px]/[1.6] text-muted-foreground">
        The company&rsquo;s own details are under Company profile, the default quotation terms under Templates, and
        the automatic-email switch under Emails &amp; jobs — each with the context that makes it make sense. The
        payment split a new order starts from comes from a payment-schedule template, also under Templates.
      </p>
    </SettingsPane>
  );
}

/**
 * The days nobody works (#73). Weekends are skipped anyway; this is the
 * list of weekday closures the working-day counts leave out, starting with
 * the gazetted holidays for 2026 and 2027.
 */
export function Holidays() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const { rows, loading, refetch } = useList('holidays', { limit: 500 });
  // 'new' or the row being changed. The pane told people to correct the
  // moon-dated holidays here and then offered only Add and Delete, so
  // moving Id by a day meant deleting it and retyping it — while
  // PATCH /api/holidays/:id existed and worked the whole time.
  const [editing, setEditing] = useState(null);

  async function remove(row) {
    if (!window.confirm(`Delete ${row.name} on ${date(row.holiday_on)}? It becomes a working day again.`)) return;
    try {
      await api.remove('holidays', row.id);
      toast('Holiday deleted', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <SettingsPane
      title="Holidays"
      description="Days the office is closed. Working-day counts skip these as well as Saturdays and Sundays. Dates that follow the moon (Id, Muharram, Milad-un-Nabi) can move; correct them here when they do."
      actions={isAdmin && <Button size="sm" className="h-8 px-4 text-[13px]" onClick={() => setEditing('new')}>Add a holiday</Button>}
    >
      <Card flush>
        <DataTable
          loading={loading}
          rows={rows}
          columns={[
            { key: 'holiday_on', header: 'Date', render: (r) => date(r.holiday_on) },
            {
              key: 'weekday',
              header: 'Day',
              className: 'muted',
              render: (r) => new Date(`${r.holiday_on}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
            },
            { key: 'name', header: 'Holiday', className: 'strong' },
            ...(isAdmin ? [{
              key: 'act',
              header: '',
              align: 'right',
              render: (r) => (
                <div className="table__actions">
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(r)}>Edit</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(r)}>Delete</button>
                </div>
              ),
            }] : []),
          ]}
          empty={<Empty title="No holidays yet" text="Add the days the office is closed." />}
        />
      </Card>

      {editing && (
        <RecordForm
          title={editing === 'new' ? 'New holiday' : `Edit ${editing.name}`}
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
    </SettingsPane>
  );
}

export function Catalogue({ resource, label, title, hint, extraColumns = [], extraFields = [] }) {
  // A Settings list: an admin curates it, everybody reads it, because the same
  // rows fill the dropdowns sales users work in (#85). The travel desk keeps
  // the travel lists too (#196).
  const auth = useAuth();
  const isAdmin = mayWriteResource(resource, auth.isAdmin, auth.isHr);
  const toast = useToast();
  const { rows, loading, refetch } = useList(resource, {});
  const [editing, setEditing] = useState(null);

  async function toggle(row) {
    try {
      await api.update(resource, row.id, { active: !row.active });
      invalidateLookups();
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <SettingsPane
      title={title}
      description={hint}
      actions={isAdmin && <Button size="sm" className="h-8 px-4 text-[13px]" onClick={() => setEditing('new')}>Add a {label.toLowerCase()}</Button>}
    >
      <Card flush>
        <DataTable
          loading={loading}
          rows={rows}
          columns={[
            { key: 'name', header: 'Name', className: 'strong' },
            // The catalogue a quotation line is filled from (#23): what picking the service prefills.
            ...(resource === 'services' ? [
              { key: 'default_rate', header: 'Default rate', align: 'right', render: (r) => (r.default_rate == null ? '—' : money(r.default_rate, r.currency)) },
              { key: 'gst_rate', header: 'GST', align: 'right', render: (r) => `${Number(r.gst_rate)}%` },
              { key: 'sac_code', header: 'SAC', className: 'mono', render: (r) => r.sac_code || '—' },
            ] : []),
            ...extraColumns,
            { key: 'active', header: 'Status', render: (r) => <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Hidden'}</Badge> },
            {
              key: 'act',
              header: '',
              align: 'right',
              render: (r) => (
                <div className="table__actions">
                  {/* A Settings list: an admin curates it, everybody reads it,
                      because the same rows fill the dropdowns sales users work
                      in (#85). These resources are adminOnlyWrites on the server. */}
                  {isAdmin && (
                    <>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(r)}>{resource === 'services' || extraFields.length ? 'Edit' : 'Rename'}</button>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => toggle(r)}>
                        {r.active ? 'Hide' : 'Restore'}
                      </button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
          empty={<Empty title={`No ${title.toLowerCase()} yet`} />}
        />
      </Card>

      {editing && (
        <RecordForm
          title={editing === 'new' ? `New ${label.toLowerCase()}` : `Edit ${label.toLowerCase()}`}
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
              { name: 'unit', label: 'Unit', type: 'combo', options: ['engagement', 'site', 'day', 'audit', 'report', 'year'], default: 'engagement' },
              { name: 'sac_code', label: 'SAC code', hint: 'Printed on the quotation line' },
              { name: 'code', label: 'Internal code' },
              { name: 'description', label: 'Default line description', type: 'textarea', span: 'all' },
              { name: 'sort_order', label: 'Sort order', type: 'number', default: '0' },
            ] : []),
            ...extraFields,
            { name: 'active', label: 'Visible in dropdowns', type: 'boolean', default: 'true' },
          ]}
        />
      )}
    </SettingsPane>
  );
}
