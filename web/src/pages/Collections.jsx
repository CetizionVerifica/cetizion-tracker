import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, DataTable, Empty, Field, Input, Modal, Select, Stat, Textarea, useToast } from '../components/ui.jsx';
import { RecordPaymentDialog } from '../components/actions.jsx';
import { FollowUpBanner, useLogParam } from '../components/FollowUpBanner.jsx';
import { PortalAnswers } from '../components/PortalAnswers.jsx';
import { ClientSaidBadge, useClientSaid } from '../components/ClientSaid.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch } from '../lib/hooks.js';
import { date, money, today } from '../lib/format.js';

/**
 * Collections (#27): who owes what and for how long, what was done about
 * it, and the next step. Ageing buckets per client, the chasing log,
 * promises to pay, disputes on hold. Since #198, what clients said in the
 * portal: payments they report, and their queries.
 */
export default function Collections() {
  const toast = useToast();
  const [open, setOpen] = useState(null);           // company key expanded
  const [chase, setChase] = useState(null);         // { stage } | { company }
  const { isAdmin } = useAuth();
  const [hold, setHold] = useState(null);           // stage
  const [paying, setPaying] = useState(null);       // stage
  const [logFor, setLogFor] = useState(null);       // stage id
  const { data, loading, error, refetch } = useFetch(() => api.raw('/collections'), []);
  // What the client last said in the portal about each invoice (#198).
  const clientSaid = useClientSaid();
  // Reports links an ageing bar here as ?bucket=31-60. The list narrows to
  // the clients with money in that band, and says so, rather than opening on
  // everything owed and leaving the reader to find the nine invoices.
  const [params, setParams] = useSearchParams();
  const bucket = params.get('bucket');
  const raw = data?.data;
  const band = raw?.buckets.find((b) => b.key === bucket);
  const d = raw && band
    ? { ...raw, clients: raw.clients.filter((c) => c.buckets[band.key] > 0).map((c) => ({ ...c, stages: c.stages.filter((s) => s.bucket === band.key) })) }
    : raw;
  // A follow-up email links here as ?stage=<id>&log=1: open that client's
  // invoices, show the follow-up, and open "Log a chase".
  const stageId = params.get('stage');
  const [chased, setChased] = useState(0);
  const target = stageId && raw
    ? raw.clients.flatMap((c) => c.stages.map((s) => ({ stage: s, key: c.company_id ?? c.company }))).find((x) => String(x.stage.id) === stageId)
    : null;
  useEffect(() => { if (target) setOpen(target.key); }, [target?.key]);
  useLogParam(() => setChase({ stage: target.stage }), Boolean(target));

  async function lift(stage) {
    try { await api.action(`/collections/stages/${stage.id}/hold`, { on_hold: false }); toast('Hold lifted', 'success'); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
  }

  return (
    <>
      <PageHeader title="Collections" subtitle="Invoiced and unpaid, by client and by age. Log every chase; a promise to pay pauses reminders until its date, a hold pauses them until lifted." />
      <div className="page stack">
        {band && (
          <Alert tone="info">
            <span>
              Showing <strong>{band.label.toLowerCase()}</strong> only — {d.clients.length} client{d.clients.length === 1 ? '' : 's'}. The totals above still cover everything outstanding.{' '}
              <button type="button" className="btn btn--sm" onClick={() => { const next = new URLSearchParams(params); next.delete('bucket'); setParams(next, { replace: true }); }}>Show all</button>
            </span>
          </Alert>
        )}
        {error && <Alert tone="danger"><span>{error}</span></Alert>}
        {stageId && <FollowUpBanner entity="payment_stage" id={stageId} version={chased} logLabel="Log a chase" onLog={target ? () => setChase({ stage: target.stage }) : undefined} />}
        {d && (
          <div className="auto-grid--stats">
            <Stat label="Outstanding (INR)" value={money(d.totals.outstanding)} />
            <Stat label="Overdue" value={money(d.totals.overdue)} tone={d.totals.overdue > 0 ? 'danger' : ''} />
            {d.buckets.map((b) => <Stat key={b.key} label={b.label} value={money(d.totals.buckets[b.key])} tone={b.key === '90+' && d.totals.buckets[b.key] > 0 ? 'danger' : ''} />)}
            <Stat label="Promised" value={money(d.totals.promised)} meta="pay-by dates given" />
            <Stat label="On hold" value={money(d.totals.on_hold)} meta="disputes" />
            {d.foreign?.length > 0 && (
              <Stat
                label="Not in these totals"
                value={`${d.foreign.length} invoice${d.foreign.length === 1 ? '' : 's'}`}
                meta={[...new Set(d.foreign.map((f) => f.currency))].join(', ')}
                tone="warn"
              />
            )}
          </div>
        )}
        <PortalAnswers onPaid={refetch} />
        <Card flush title="By client" hint="Click a client for its invoices. Oldest overdue first.">
          {loading && !d ? <div className="skeleton" style={{ height: 120, margin: 18 }} />
            /* Same reason as Payables: an empty list after a failed load
               is not the same fact as nothing being owed. */
            : error ? null : !d?.clients.length ? <Empty title="Nothing outstanding" text="Every invoiced stage is paid." /> : (
            <DataTable
              rows={d.clients}
              onRowClick={(r) => setOpen(open === (r.company_id ?? r.company) ? null : (r.company_id ?? r.company))}
              rowClassName={(r) => (open === (r.company_id ?? r.company) ? 'is-open' : '')}
              columns={[
                { key: 'company', header: 'Client', className: 'strong', render: (r) => <>{r.company_id ? <Link to={`/companies/${r.company_id}`} onClick={(e) => e.stopPropagation()}>{r.company}</Link> : r.company}{r.contact_name && <div className="small muted">{r.contact_name}{r.contact_email ? ` · ${r.contact_email}` : ''}{r.contact_phone ? ` · ${r.contact_phone}` : ''}</div>}</> },
                { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => money(r.outstanding) },
                { key: 'overdue', header: 'Overdue', align: 'right', render: (r) => (r.overdue > 0 ? <span style={{ color: 'var(--danger-fg)' }}>{money(r.overdue)}</span> : <span className="muted">—</span>) },
                ...d.buckets.map((b) => ({ key: b.key, header: b.label, align: 'right', render: (r) => (r.buckets[b.key] > 0 ? money(r.buckets[b.key]) : <span className="muted">—</span>) })),
                { key: 'oldest', header: 'Oldest', align: 'right', render: (r) => (r.oldest_days > 0 ? `${r.oldest_days} d` : '—') },
                { key: 'chased', header: 'Last chased', render: (r) => (r.last_chased_at ? new Date(r.last_chased_at).toLocaleDateString() : <span className="muted">never</span>) },
                { key: 'promise', header: 'Promise', render: (r) => (r.promise_to_pay_date ? <Badge tone={r.promise_to_pay_date < today() ? 'danger' : 'info'}>{date(r.promise_to_pay_date)}</Badge> : <span className="muted">—</span>) },
                { key: 'act', header: '', align: 'right', render: (r) => <button type="button" className="btn btn--sm" onClick={(e) => { e.stopPropagation(); setChase({ company: r }); }}>Log a chase</button> },
              ]}
            />
          )}
        </Card>
        {d?.clients.filter((c) => open === (c.company_id ?? c.company)).map((c) => (
          <Card key={c.company} flush title={`${c.company}: invoices`} hint="Each invoiced stage still open, with what was done about it.">
            <DataTable
              rows={c.stages}
              columns={[
                { key: 'invoice_no', header: 'Invoice', className: 'mono', render: (s) => <>{s.invoice_no}<div className="small muted">{date(s.invoice_date)} · <Link to={`/purchase-orders/${encodeURIComponent(s.po_number)}`}>{s.po_number}</Link> · {s.stage_name}</div></> },
                { key: 'outstanding', header: 'Outstanding', align: 'right', render: (s) => <>{money(s.outstanding, s.currency)}<div className="small muted">of {money(s.stage_amount, s.currency)}</div></> },
                { key: 'due', header: 'Due', render: (s) => <>{date(s.invoice_due_date)}{s.days_overdue > 0 && <div className="small" style={{ color: 'var(--danger-fg)' }}>{s.days_overdue} days overdue · {s.bucket}</div>}</> },
                { key: 'status', header: 'Status', render: (s) => <><Badge>{s.stage_status}</Badge>{s.on_hold && <div><Badge tone="warning">on hold</Badge> <span className="small muted">{s.hold_reason}</span></div>}{s.promise_to_pay_date && <div className="small">promised {date(s.promise_to_pay_date)}</div>}{s.reminder_level > 0 && <div className="small muted">reminder level {s.reminder_level}{s.reminder_sent_on ? ` on ${date(s.reminder_sent_on)}` : ''}</div>}<ClientSaidBadge said={clientSaid.get(s.id)} /></> },
                { key: 'last', header: 'Last chase', className: 'wrap small', render: (s) => (s.last_chased_at ? <>{new Date(s.last_chased_at).toLocaleDateString()} · {s.last_channel}<div className="muted">{s.last_summary}</div>{s.next_action_on && <div>next: {date(s.next_action_on)}</div>}</> : <span className="muted">never</span>) },
                { key: 'act', header: '', align: 'right', render: (s) => <div className="table__actions"><button type="button" className="btn btn--sm btn--primary" onClick={() => setPaying(s)}>Payment</button><button type="button" className="btn btn--sm" onClick={() => setChase({ stage: s })}>Chase</button>{isAdmin && (s.on_hold ? <button type="button" className="btn btn--sm btn--ghost" onClick={() => lift(s)}>Lift hold</button> : <button type="button" className="btn btn--sm btn--ghost" onClick={() => setHold(s)}>Hold</button>)}<button type="button" className="btn btn--sm btn--ghost" onClick={() => setLogFor(s)}>Log</button></div> },
              ]}
            />
          </Card>
        ))}
      </div>

      {chase && <ChaseDialog target={chase} onClose={() => setChase(null)} onSaved={() => { setChase(null); setChased((n) => n + 1); refetch(); }} />}
      {hold && <HoldDialog stage={hold} onClose={() => setHold(null)} onSaved={() => { setHold(null); refetch(); }} />}
      {paying && <RecordPaymentDialog stage={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); refetch(); }} />}
      {logFor && <LogDialog stage={logFor} onClose={() => setLogFor(null)} />}
    </>
  );
}

function ChaseDialog({ target, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState({ channel: 'call', summary: '', promise_to_pay_date: '', next_action_on: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const label = target.stage ? `${target.stage.invoice_no} · ${target.stage.client_name}` : target.company.company;
  async function save(e) {
    e.preventDefault(); setBusy(true);
    try {
      await api.action('/collections/log', { ...v, stage_id: target.stage?.id, company_id: target.stage ? undefined : target.company.company_id });
      toast('Chase logged', 'success'); onSaved();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title="Log a chase" subtitle={label} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="chase-form" className="btn btn--primary" disabled={busy || !v.summary.trim()}>Save</button></>}>
      <form id="chase-form" onSubmit={save} className="form-grid">
        <Field label="How"><Select value={v.channel} placeholder={null} options={['call', 'email', 'whatsapp', 'meeting', 'note']} onChange={(e) => set('channel', e.target.value)} /></Field>
        <Field label="Promised to pay by" hint="Pauses reminders until then"><Input type="date" value={v.promise_to_pay_date} onChange={(e) => set('promise_to_pay_date', e.target.value)} /></Field>
        <Field label="Next action on"><Input type="date" value={v.next_action_on} onChange={(e) => set('next_action_on', e.target.value)} /></Field>
        <div className="span-all"><Field label="What happened" required><Textarea rows={3} value={v.summary} onChange={(e) => set('summary', e.target.value)} autoFocus placeholder="Spoke to accounts; payment run is on the 25th" /></Field></div>
      </form>
    </Modal>
  );
}

function HoldDialog({ stage, onClose, onSaved }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Put on hold" subtitle={`${stage.invoice_no} · no reminders until the hold is lifted`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" disabled={busy} onClick={async () => { setBusy(true); try { await api.action(`/collections/stages/${stage.id}/hold`, { on_hold: true, hold_reason: reason || null }); toast('On hold', 'success'); onSaved(); } catch (err) { toast(err.message, 'danger'); setBusy(false); } }}>Hold</button></>}>
      <Field label="Why" hint="A dispute, a credit note in progress, a wrong invoice"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function LogDialog({ stage, onClose }) {
  const log = useFetch(() => api.raw(`/collections/log?stage_id=${stage.id}`), [stage.id]);
  const pays = useFetch(() => api.raw(`/collections/stages/${stage.id}/payments`), [stage.id]);
  return (
    <Modal title={`${stage.invoice_no}: history`} subtitle={`${stage.client_name} · ${stage.po_number} · ${stage.stage_name}`} onClose={onClose} size="lg" footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="stack">
        <div>
          <div className="strong" style={{ marginBottom: 6 }}>Receipts</div>
          {(pays.data?.data ?? []).length ? <table className="table"><tbody>{pays.data.data.map((p) => <tr key={p.id}><td>{date(p.received_on)}</td><td>{p.mode.replace('_', ' ')}{p.reference ? ` · ${p.reference}` : ''}</td><td className="num">{money(p.amount, stage.currency)}{Number(p.tds_amount) > 0 && <div className="small muted">+ TDS {money(p.tds_amount, stage.currency)}</div>}</td></tr>)}</tbody></table> : <span className="muted small">None yet</span>}
        </div>
        <div>
          <div className="strong" style={{ marginBottom: 6 }}>Chasing log</div>
          {(log.data?.data ?? []).length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{log.data.data.map((l) => <li key={l.id}>{new Date(l.happened_at).toLocaleString()} · {l.channel}{l.by_whom ? ` · ${l.by_whom}` : ''}: {l.summary}{l.promise_to_pay_date ? ` (promised ${date(l.promise_to_pay_date)})` : ''}</li>)}</ul> : <span className="muted small">Nothing logged</span>}
        </div>
      </div>
    </Modal>
  );
}
