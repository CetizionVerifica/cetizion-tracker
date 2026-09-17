import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Card, DataTable, Tabs, Badge, Alert, Empty, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { api } from '../lib/api.js';
import { useFetch, useList, useLookups, invalidateLookups } from '../lib/hooks.js';

const CATALOGUES = {
  services: { resource: 'services', label: 'Service', title: 'Service offerings', hint: 'Offered on quotations and PO service lines' },
  'travel-vendors': { resource: 'travel-vendors', label: 'Travel vendor', title: 'Travel vendors', hint: 'Who trips are booked through' },
  'expense-categories': { resource: 'expense-categories', label: 'Expense category', title: 'Expense categories', hint: 'What employees can claim against' },
};

export default function Settings() {
  const [tab, setTab] = useState('services');

  return (
    <>
      <PageHeader title="Settings" subtitle="The lists and assumptions the rest of the app reads from" />

      <div className="page stack">
        <ExchangeRates />
        <SettingsValues />

        <Tabs
          active={tab}
          onChange={setTab}
          tabs={Object.entries(CATALOGUES).map(([key, c]) => ({ key, label: c.title }))}
        />

        <Catalogue key={tab} {...CATALOGUES[tab]} />
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
function ExchangeRates() {
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
  const inUse = lookups.currencies_in_use ?? currencies;
  const missing = inUse.filter((c) => c !== 'INR' && !latest.has(c));

  async function remove(row) {
    if (!window.confirm(`Delete the ${row.from_currency} rate effective ${row.effective_from}? Figures dated on or after it will fall back to the previous rate.`)) return;
    try {
      await api.remove('exchange-rates', row.id);
      toast('Rate deleted', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <>
      <Card
        flush
        title="Exchange rates"
        hint="INR for 1 unit, from the date it took effect · reports convert each figure at the rate in force on its own date"
        actions={<button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing('new')}>+ Rate</button>}
      >
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
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(r)}>Edit</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(r)}>Delete</button>
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
    </>
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

function SettingsValues() {
  const toast = useToast();
  const { data, loading, refetch } = useFetch(() => api.raw('/lookups'));
  const [editing, setEditing] = useState(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const settings = data?.data?.settings || {};
  // fx_rate_* moved to Exchange rates above, where each rate carries its date.
  const rows = Object.entries(settings)
    .filter(([key]) => !key.startsWith('fx_rate_'))
    .map(([key, val]) => ({ id: key, key, value: val }));

  async function save(key) {
    setBusy(true);
    try {
      await api.update('settings', key, { value });
      toast('Setting saved', 'success');
      invalidateLookups();
      setEditing(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card flush title="Assumptions" hint="Changing these changes what the app computes everywhere">
      <Alert>
        <span>
          <strong>Vendor invoice window</strong> drives the "invoice overdue from vendor" flag.
          The default payment terms are only suggestions — actual terms live on each PO.
        </span>
      </Alert>
      <DataTable
        loading={loading}
        rows={rows}
        columns={[
          {
            key: 'key',
            header: 'Setting',
            className: 'mono',
            render: (r) => r.key.replace(/_/g, ' '),
          },
          {
            key: 'value',
            header: 'Value',
            render: (r) =>
              editing === r.key ? (
                <input
                  className="input"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoFocus
                  style={{ maxWidth: 280 }}
                />
              ) : r.value === '' ? (
                <span className="muted">Not set</span>
              ) : (
                <span className="strong">{r.value}</span>
              ),
          },
          {
            key: 'act',
            header: '',
            align: 'right',
            render: (r) => (
              <div className="table__actions">
                {editing === r.key ? (
                  <>
                    <button type="button" className="btn btn--sm btn--primary" onClick={() => save(r.key)} disabled={busy}>Save</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => { setEditing(r.key); setValue(r.value); }}>Edit</button>
                )}
              </div>
            ),
          },
        ]}
        empty={<Empty title="No settings recorded" />}
      />
    </Card>
  );
}

function Catalogue({ resource, label, title, hint }) {
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
    <>
      <Card
        flush
        title={title}
        hint={hint}
        actions={<button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing('new')}>+ {label}</button>}
      >
        <DataTable
          loading={loading}
          rows={rows}
          columns={[
            { key: 'name', header: 'Name', className: 'strong' },
            { key: 'active', header: 'Status', render: (r) => <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Hidden'}</Badge> },
            {
              key: 'act',
              header: '',
              align: 'right',
              render: (r) => (
                <div className="table__actions">
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(r)}>Rename</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => toggle(r)}>
                    {r.active ? 'Hide' : 'Restore'}
                  </button>
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
            ...(resource === 'services' ? [{ name: 'sort_order', label: 'Sort order', type: 'number', default: '0' }] : []),
            { name: 'active', label: 'Visible in dropdowns', type: 'boolean', default: 'true' },
          ]}
        />
      )}
    </>
  );
}
