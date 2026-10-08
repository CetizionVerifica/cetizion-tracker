import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { marginTone } from '../components/ProjectProfit.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { ListPage } from '../components/ListPage.jsx';
import { SummaryStrip, Tone, useRows } from '../components/sales.jsx';
import { daysTo, shortDate } from '../components/money.jsx';
import { count } from '../components/travel.jsx';
import { invalidateLookups, useLookups } from '../lib/hooks.js';
import { money } from '../lib/format.js';

/** A project's stage and payment state in the system's tones, sentence case. */
const STAGE = { 'Not Started': ['plain', 'Not started'], Onboarding: ['info', 'Onboarding'], 'In Progress': ['info', 'In progress'], Delivered: ['ok', 'Delivered'] };
const PAY = {
  Overdue: ['late', 'Overdue'], 'Invoicing pending': ['wait', 'Invoicing pending'], Pending: ['wait', 'Pending'],
  'No stages': ['plain', 'No stages'], 'Up to date': ['ok', 'Up to date'], 'Fully Paid': ['ok', 'Fully paid'],
};
const BADGE = { ok: 'mg-badge--ok', wait: 'mg-badge--wait', late: 'mg-badge--late' };

/** Not delivered, and the planned delivery date has passed: how many days ago. */
const daysLate = (r) => {
  if (r.actual_delivery_date || !r.planned_delivery_date) return 0;
  const d = daysTo(r.planned_delivery_date);
  return d < 0 ? -d : 0;
};
/** One currency across the project's POs (null when they differ), and a PO at all. */
const hasMoney = (r) => Number(r.po_count) > 0 && Boolean(r.currency);
const amountOf = (r, v) => (hasMoney(r) ? money(v, r.currency) : '—');

/**
 * The project form, the same on the list's New/Edit and on the record's
 * Edit (which adds Delivered on, and has no ID to change).
 */
export function projectFields(lookups, { record = null } = {}) {
  return [
    ...(record ? [{ name: 'actual_delivery_date', label: 'Delivered on', type: 'date', group: 'The project', hint: 'Blank until it is delivered. Setting it makes the on-delivery stages billable' }] : []),
    ...(record ? [] : [{ name: 'project_id', label: 'Project ID', auto: 'project', group: 'The project' }]),
    { name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups.clients, group: 'The project' },
    { name: 'primary_service', label: 'Primary service', type: 'combo', options: lookups.services, span: 2, group: 'The project' },
    { name: 'project_manager', label: 'Project manager', group: 'People' },
    { name: 'project_manager_email', label: 'Manager email', type: 'email', group: 'People' },
    { name: 'sales_person', label: 'Sales person', type: 'combo', options: lookups.sales_people, group: 'People' },
    {
      name: 'quotation_no',
      label: 'Won quotation',
      type: 'select',
      group: 'People',
      // Only quotations that are won and not already registered elsewhere.
      options: (lookups.unregistered_quotations || []).map((q) => ({
        value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name}`,
      })),
      hint: 'Registers this project against that quotation, the same as Register on a won deal. Leave it blank to change nothing',
      span: 2,
    },
    { name: 'planned_start_date', label: 'Planned start', type: 'date', group: 'Plan' },
    { name: 'planned_delivery_date', label: 'Planned delivery', type: 'date', group: 'Plan' },
    { name: 'service_request_no', label: 'Service request no.', hint: 'e.g. CV108: how a trip with no PO finds this project', group: 'Plan' },
    { name: 'percent_complete', label: '% complete', type: 'percent', hint: '0 to 100. Shown under the stage on this list.', group: 'Plan' },
    { name: 'estimated_cost', label: 'Planned cost', type: 'money', hint: 'Delivery cost expected, to compare planned with actual', group: 'Plan' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all', group: 'Plan', placeholder: 'Anything the delivery team should know' },
  ];
}

export default function Projects() {
  const navigate = useNavigate();
  const lookups = useLookups();
  // Margins are the admin's (a 403 for sales unless Settings opens them):
  // when they don't come back, the column is left out rather than a column of dashes.
  const profit = useFetch(() => api.raw('/profitability'));
  const margins = Object.fromEntries((profit.data?.data ?? []).map((p) => [p.project_id, p]));
  const showMargin = Boolean(profit.data) && !profit.error;
  const alertAt = Number(lookups.settings?.margin_alert_percent) || 20;

  // The strip covers every project the reader can see, whatever the filters.
  const all = useRows('projects', { limit: 500 });
  const inInr = all.rows.filter((r) => hasMoney(r) && r.currency === 'INR');
  const sum = (rows, key) => rows.reduce((n, r) => n + Number(r[key] || 0), 0);
  const dueRows = inInr.filter((r) => Number(r.balance_due_now) > 0);
  const overdue = sum(inInr.filter((r) => r.payment_status === 'Overdue'), 'balance_due_now');
  const billRows = inInr.filter((r) => Number(r.balance_to_bill) > 0);
  const late = all.rows.filter((r) => daysLate(r) > 0);
  const low = Object.values(margins).filter((m) => m.low_margin);

  const strip = (
    <SummaryStrip
      label="Totals across every project"
      loading={all.loading}
      tiles={[
        { key: 'due', label: 'Due now', figure: all.loading ? null : money(sum(dueRows, 'balance_due_now')), foot: `${count(dueRows.length, 'project')}${overdue > 0 ? ` · ${money(overdue)} overdue` : ''}` },
        { key: 'bill', label: 'Still to bill', tone: 'wait', figure: all.loading ? null : money(sum(billRows, 'balance_to_bill')), foot: count(billRows.length, 'project') },
        {
          key: 'late',
          label: 'Past the delivery date',
          tone: late.length ? 'late' : undefined,
          figure: all.loading ? null : count(late.length, 'project'),
          foot: late.length
            ? <Link className="app-link" to="/worklist?tab=delivery">{late.length === 1 ? `${late[0].project_id}, ${daysLate(late[0])} days · show it` : 'Show them'}</Link>
            : 'Nothing is late',
        },
        ...(showMargin ? [{
          key: 'low',
          label: 'Low margin',
          figure: count(low.length, 'project'),
          foot: low.length === 1 ? `${low[0].project_id} · ${low[0].margin_percent}%` : `Under ${alertAt}%`,
        }] : []),
      ]}
    />
  );

  const columns = [
    {
      key: 'project_id', header: 'Project', sortBy: 'project_id', className: 'nowrap',
      render: (r) => <><Link className="mg-num font-bold text-foreground no-underline" to={`/projects/${encodeURIComponent(r.project_id)}`}>{r.project_id}</Link><span className="app-sub2">{Number(r.po_count) === 0 ? 'No PO' : count(r.po_count, 'PO')}{r.service_request_no ? ` · SR ${r.service_request_no}` : ''}</span></>,
    },
    { key: 'client_name', header: 'Client', min: 150, render: (r) => <><b>{r.client_name}</b><span className="app-sub2 is-wrap">{r.primary_service}</span></> },
    { key: 'project_manager', header: 'Manager', className: 'nowrap', render: (r) => <>{r.project_manager || <span className="text-muted-foreground">Not set</span>}<span className="app-sub2">Sales: {r.sales_person || 'not set'}</span></> },
    {
      key: 'total_contract_value', header: 'Contract', align: 'right',
      render: (r) => (
        <span title={Number(r.po_count) > 0 && !r.currency ? "This project's purchase orders use more than one currency, so they are not added up here. Open the project to see each one." : undefined}>
          <span className={hasMoney(r) ? undefined : 'text-muted-foreground'}>{amountOf(r, r.total_contract_value)}</span>
          <span className="app-sub2">{hasMoney(r) ? (Number(r.total_received) > 0 ? `${money(r.total_received, r.currency)} received` : 'Nothing received') : Number(r.po_count) > 0 ? 'Mixed currencies' : 'No PO yet'}</span>
        </span>
      ),
    },
    {
      key: 'balance_due_now', header: 'Due now', align: 'right',
      render: (r) => (
        <>
          <strong className={!hasMoney(r) || !Number(r.balance_due_now) ? 'text-muted-foreground' : r.payment_status === 'Overdue' ? 'text-late' : undefined}>{amountOf(r, r.balance_due_now)}</strong>
          {hasMoney(r) && <span className="app-sub2">{Number(r.balance_to_bill) > 0 ? `${money(r.balance_to_bill, r.currency)} to bill` : 'Nothing to bill'}</span>}
        </>
      ),
    },
    ...(showMargin ? [{
      key: 'margin', header: 'Margin', align: 'right',
      render: (r) => {
        const m = margins[r.project_id];
        if (m?.margin_percent == null) return <span className="text-muted-foreground" title={Number(r.po_count) ? 'No margin: the purchase orders use more than one currency' : 'No margin yet: there is no purchase order'}>—</span>;
        const tone = marginTone(Number(m.margin_percent), alertAt);
        return (
          <span title={`Margin ${money(m.margin)} · cost ${money(m.total_cost)}${m.low_margin ? ' · flagged as low margin' : ''}`}>
            <span className={`mg-badge ${tone === 'danger' ? 'mg-badge--late' : tone === 'warning' ? 'mg-badge--wait' : 'mg-badge--ok'}`}>{m.margin_percent}%</span>
            {m.low_margin && <span className="app-sub2 is-late">Low margin</span>}
          </span>
        );
      },
    }] : []),
    {
      key: 'onboarding_percent', header: 'Onboarding', className: 'nowrap',
      render: (r) => (Number(r.onboarding_total) ? (
        <>
          <span className="app-onb">
            <span className="mg-progress" role="img" aria-label={`Onboarding ${r.onboarding_done} of ${r.onboarding_total} steps done`}><span className="mg-progress__done" style={{ width: `${Math.round(Number(r.onboarding_percent) * 100)}%` }} /></span>
            <b className="mg-num">{Math.round(Number(r.onboarding_percent) * 100)}%</b>
          </span>
          <span className="app-sub2">{r.onboarding_done} of {r.onboarding_total} steps</span>
        </>
      ) : <span className="text-[12.5px] text-muted-foreground">No steps yet</span>),
    },
    {
      key: 'project_stage', header: 'Stage', className: 'nowrap',
      render: (r) => {
        const [tone, word] = STAGE[r.project_stage] || ['plain', r.project_stage];
        const lateBy = daysLate(r);
        return (
          <>
            <span className={`mg-badge ${BADGE[tone] || (tone === 'info' ? 'mg-badge--info' : 'mg-badge--plain')}`}>{word}</span>
            <span className="app-sub2">{r.actual_delivery_date
              ? `Delivered ${shortDate(r.actual_delivery_date)}${Number(r.delivery_variance_days) > 0 ? `, ${r.delivery_variance_days} days late` : ''}`
              : r.planned_delivery_date ? `${lateBy ? 'Was due' : 'Due'} ${shortDate(r.planned_delivery_date)} · ${Math.round(Number(r.percent_complete || 0) * 100)}% done` : 'No delivery date'}</span>
            {lateBy > 0 && <span className="app-sub2 is-late">{lateBy} days late</span>}
          </>
        );
      },
    },
    { key: 'payment_status', header: 'Payment', render: (r) => { const [tone, word] = PAY[r.payment_status] || ['plain', r.payment_status]; return <Tone tone={tone}>{word}</Tone>; } },
  ];

  const fields = projectFields(lookups);


  return (
    <ListPage
      title="Projects"
      subtitle="Every registered project, with its purchase orders, stage and money rolled up. Open one for its checklist, invoices and trips."
      resource="projects"
      noun="projects"
      allLabel="All projects"
      columns={columns}
      fields={fields}
      formSize="lg"
      newLabel="Project"
      formTitle="project"
      formSubmitLabel="Create project"
      deleteTitle={() => 'Delete this project?'}
      deleteText={(r) => `${r.project_id} · ${r.client_name}. This cannot be undone. Its onboarding checklist, its notes and its files go with it. Today and Reports update straight away.`}
      searchPlaceholder="Search project, client, manager or SR no."
      summary={strip}
      phoneBelow={1024}
      onRowClick={(row) => navigate(`/projects/${row.project_id}`)}
      rowMenu={(r) => [{ label: 'Open the project', icon: ArrowRight, onSelect: () => navigate(`/projects/${encodeURIComponent(r.project_id)}`) }]}
      phone={(r) => {
        const lateBy = daysLate(r);
        const m = margins[r.project_id];
        const [tone, word] = PAY[r.payment_status] || ['plain', r.payment_status];
        return {
          title: r.client_name,
          to: `/projects/${encodeURIComponent(r.project_id)}`,
          amount: hasMoney(r) && Number(r.balance_due_now) > 0 ? `${money(r.balance_due_now, r.currency)} due` : amountOf(r, r.total_contract_value),
          meta: [
            `${r.project_id} · ${r.primary_service || 'No service'} · ${r.project_manager || 'no manager'}`,
            `${(STAGE[r.project_stage] || [0, r.project_stage])[1]} · ${lateBy ? `${lateBy} days late` : r.actual_delivery_date ? `delivered ${shortDate(r.actual_delivery_date)}` : r.planned_delivery_date ? `due ${shortDate(r.planned_delivery_date)}` : 'no delivery date'}${showMargin && m?.margin_percent != null ? ` · margin ${m.margin_percent}%${m.low_margin ? ', low' : ''}` : ''}`,
          ].join(' · '),
          state: <Tone tone={tone}>{word}</Tone>,
        };
      }}
      // Saving can register a won quotation, which takes it off the list the
      // form offers — the lookups are cached for the session until cleared.
      onSaved={() => invalidateLookups()}
      filters={[
        { name: 'project_stage', label: 'Stage', options: Object.entries(STAGE).map(([value, [, label]]) => ({ value, label })) },
        { name: 'payment_status', label: 'Payment', options: Object.entries(PAY).map(([value, [, label]]) => ({ value, label })) },
        { name: 'sales_person', label: 'Sales person', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sales_people] },
      ]}
    />
  );
}
