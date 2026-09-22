import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Badge, Card, DataTable, Empty, Field, Input, Modal, Select, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';

/**
 * The shared sales inbox (#30): who owns each email, what is waiting on
 * us, replies from the shared address, and conversion to enquiries.
 */
const VIEWS = [{ key: 'mine', label: 'Mine' }, { key: 'unassigned', label: 'Unassigned' }, { key: 'overdue', label: 'Overdue' }, { key: 'all', label: 'All open' }, { key: 'closed', label: 'Closed' }, { key: 'setup', label: 'Set-up' }];
const STATUS_TONE = { open: 'info', pending_client: '', snoozed: 'warning', closed: '' };
const since = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'all';
  const selected = params.get('c');
  const [q, setQ] = useState('');
  const summary = useFetch(() => api.raw('/inbox/summary'), [view, selected]);
  const listUrl = view === 'closed' ? '/inbox?view=all&status=closed' : `/inbox?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const list = useFetch(() => (view === 'setup' ? Promise.resolve({ data: [] }) : api.raw(listUrl)), [listUrl]);
  const s = summary.data?.data;
  const put = (k, v) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const counts = { mine: s?.mine, unassigned: s?.unassigned, overdue: s?.overdue, all: s?.open };

  return (
    <>
      <PageHeader title="Inbox" subtitle="Email to the shared sales addresses. Every conversation has an owner and a reply deadline; turn new business into an enquiry in one step."
        actions={view !== 'setup' && <Input placeholder="Search subject, sender, company…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />} />
      <div className="page stack">
        <Tabs active={view} onChange={(k) => { const n = new URLSearchParams(); n.set('view', k); setParams(n, { replace: true }); }} tabs={VIEWS.map((v) => ({ ...v, count: counts[v.key] }))} />
        {view === 'setup' ? <InboxSetup /> : (
          <div className="inbox">
            <Card flush className="inbox__list">
              <DataTable
                loading={list.loading && !list.data}
                rows={list.data?.data ?? []}
                onRowClick={(r) => put('c', String(r.id))}
                rowClassName={(r) => (String(r.id) === selected ? 'is-selected' : '')}
                empty={<Empty icon="✓" title="Nothing here" text="New email to a shared mailbox appears here after the next sync." />}
                columns={[
                  { key: 'subject', header: 'Conversation', className: 'wrap', render: (r) => <><div className="strong">{r.subject || '(no subject)'}</div><div className="small muted">{r.from_name || r.from_email}{r.company_name ? ` · ${r.company_name}` : ''}</div></> },
                  { key: 'assignee', header: 'Owner', render: (r) => r.assignee || <span className="muted">—</span> },
                  { key: 'state', header: '', render: (r) => <>{r.overdue ? <Badge tone="danger">overdue</Badge> : <Badge tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge>}{r.priority === 'high' && <> <Badge tone="danger">high</Badge></>}{r.enquiry_no && <> <Badge tone="success">enquiry</Badge></>}</> },
                  { key: 'last', header: 'Last', align: 'right', className: 'small muted', render: (r) => since(r.last_message_at) },
                ]}
              />
            </Card>
            <div className="inbox__detail">
              {selected ? <Conversation id={selected} onChanged={() => { list.refetch(); summary.refetch(); }} /> : <Card><Empty title="Pick a conversation" /></Card>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Conversation({ id, onChanged }) {
  const toast = useToast();
  const lookups = useLookups();
  const conv = useFetch(() => api.raw(`/inbox/${id}`), [id]);
  const c = conv.data?.data;
  const thread = useFetch(() => (c ? api.raw(`/mail/threads/${c.thread_id}`) : Promise.resolve(null)), [c?.thread_id, c?.message_count]);
  const canned = useFetch(() => api.raw('/inbox/canned'));
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const [snoozing, setSnoozing] = useState(false);

  async function update(patch, ok) {
    setBusy(true);
    try { await api.raw(`/inbox/${id}`, { method: 'PATCH', body: patch }); if (ok) toast(ok, 'success'); conv.refetch(); onChanged(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function reply(close) {
    setBusy(true);
    try { await api.action(`/inbox/${id}/reply`, { body, close }); toast('Reply sent', 'success'); setBody(''); conv.refetch(); thread.refetch(); onChanged(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  if (!c) return <Card><div className="skeleton" style={{ height: 200 }} /></Card>;
  const t = thread.data?.data;

  return (
    <Card flush title={c.subject || '(no subject)'} hint={<>{c.from_name || c.from_email} &lt;{c.from_email}&gt;{c.company_name && <> · <Link to={`/companies/${c.company_id}`}>{c.company_name}</Link></>}{c.enquiry_no && <> · <Link to={`/enquiries?q=${encodeURIComponent(c.enquiry_no)}`}>{c.enquiry_no}</Link></>}{c.response_due_at && c.status === 'open' && <> · reply due {new Date(c.response_due_at).toLocaleString()}</>}</>}
      actions={<div className="card__actions">
        {!c.enquiry_no && <button type="button" className="btn btn--sm btn--primary" onClick={() => setConverting(true)}>Convert to enquiry</button>}
        {c.status !== 'closed' ? <button type="button" className="btn btn--sm" disabled={busy} onClick={() => update({ status: 'closed' }, 'Closed')}>Close</button> : <button type="button" className="btn btn--sm" disabled={busy} onClick={() => update({ status: 'open' }, 'Reopened')}>Reopen</button>}
        {c.status !== 'snoozed' && c.status !== 'closed' && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSnoozing(true)}>Snooze</button>}
      </div>}>
      <div className="contact-bar">
        <Field label="Owner"><Input list="inbox-people" defaultValue={c.assignee || ''} key={`${c.id}-${c.assignee}`} onBlur={(e) => e.target.value !== (c.assignee || '') && update({ assignee: e.target.value || null }, 'Reassigned')} placeholder="Unassigned" /><datalist id="inbox-people">{lookups.sales_people.map((p) => <option key={p} value={p} />)}</datalist></Field>
        <Field label="Priority"><Select value={c.priority} placeholder={null} options={['low', 'normal', 'high']} onChange={(e) => update({ priority: e.target.value })} /></Field>
        <span className="small muted">{c.inbox_name} · {c.status.replace('_', ' ')}{c.first_response_at ? ` · first reply ${new Date(c.first_response_at).toLocaleString()}` : ''}</span>
      </div>
      <div className="stack" style={{ padding: 14 }}>
        {!t ? <div className="skeleton" style={{ height: 120 }} /> : t.messages.map((m) => (
          <div key={m.id} className={`mail mail--${m.direction}`}>
            <div className="mail__head"><span className="strong">{m.from_name || m.from_email}</span>{m.sent_from_tracker_by && <Badge tone="info">by {m.sent_from_tracker_by}</Badge>}<span className="small muted mail__when">{new Date(m.sent_at).toLocaleString()}</span></div>
            {m.body_html ? <iframe className="mail__body" title={`email ${m.id}`} sandbox="" srcDoc={`<style>body{font:13px system-ui,sans-serif;margin:8px;color:#0f172a}img{max-width:100%}</style>${m.body_html}`} /> : <div className="mail__snippet">{m.snippet}</div>}
          </div>
        ))}
        <Field label="Reply from the shared address">
          <Select value="" placeholder="Insert a canned response…" options={(canned.data?.data ?? []).map((x) => ({ value: String(x.id), label: x.name }))} onChange={(e) => { const x = canned.data.data.find((y) => String(y.id) === e.target.value); if (x) setBody(x.body.replace(/\{\{\s*contact_name\s*\}\}/g, c.contact_name || c.from_name || 'Sir/Madam')); }} />
          <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="{{my_name}} is replaced with your name; the inbox signature is added." />
        </Field>
        <div className="card__actions">
          <button type="button" className="btn btn--primary" disabled={busy || !body.trim()} onClick={() => reply(false)}>Send</button>
          <button type="button" className="btn" disabled={busy || !body.trim()} onClick={() => reply(true)}>Send and close</button>
        </div>
      </div>
      {converting && <ConvertDialog c={c} people={lookups.sales_people} sources={lookups.lead_sources || []} onClose={() => setConverting(false)} onDone={() => { setConverting(false); conv.refetch(); onChanged(); }} />}
      {snoozing && <SnoozeDialog onClose={() => setSnoozing(false)} onSnooze={(until) => { setSnoozing(false); update({ status: 'snoozed', snoozed_until: until }, 'Snoozed'); }} />}
    </Card>
  );
}

function ConvertDialog({ c, people, sources, onClose, onDone }) {
  const toast = useToast();
  const [v, setV] = useState({ client_name: c.company_name || '', contact_person: c.contact_name || c.from_name || '', service: c.subject || '', sales_person: c.assignee || '', source_id: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  async function go() {
    setBusy(true);
    try {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
      const { data } = await api.action(`/inbox/${c.id}/convert`, body);
      toast(`Enquiry ${data.enquiry_no} created`, 'success'); onDone();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title="Convert to enquiry" subtitle="Creates an enquiry prefilled from this email, sourced from the inbox. The thread shows on the enquiry." onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" disabled={busy || !v.client_name.trim()} onClick={go}>Create enquiry</button></>}>
      <div className="form-grid">
        <Field label="Company" required><Input value={v.client_name} onChange={set('client_name')} /></Field>
        <Field label="Contact"><Input value={v.contact_person} onChange={set('contact_person')} /></Field>
        <div className="span-all"><Field label="Service asked for"><Input value={v.service} onChange={set('service')} /></Field></div>
        <Field label="Owner"><Input list="convert-people" value={v.sales_person} onChange={set('sales_person')} /><datalist id="convert-people">{people.map((p) => <option key={p} value={p} />)}</datalist></Field>
        <Field label="Source" hint="Blank: Inbound email or call"><Select value={v.source_id} options={sources.map((x) => ({ value: String(x.id), label: x.name }))} onChange={set('source_id')} /></Field>
        <div className="span-all"><Field label="Notes"><Textarea rows={2} value={v.notes} onChange={set('notes')} /></Field></div>
      </div>
    </Modal>
  );
}

function SnoozeDialog({ onClose, onSnooze }) {
  const at = (days, hour = 10) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const [custom, setCustom] = useState('');
  return (
    <Modal size="sm" title="Snooze until" subtitle="It comes back to the open list then." onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Cancel</button>}>
      <div className="stack">
        <button type="button" className="btn" onClick={() => onSnooze(at(1))}>Tomorrow morning</button>
        <button type="button" className="btn" onClick={() => onSnooze(at(3))}>In 3 days</button>
        <button type="button" className="btn" onClick={() => onSnooze(at(7))}>Next week</button>
        <Field label="Or pick"><Input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>
        <button type="button" className="btn btn--primary" disabled={!custom} onClick={() => onSnooze(new Date(custom).toISOString())}>Snooze</button>
      </div>
    </Modal>
  );
}

function InboxSetup() {
  const toast = useToast();
  const inboxes = useFetch(() => api.raw('/inbox/inboxes'));
  const canned = useFetch(() => api.raw('/inbox/canned'));
  const [form, setForm] = useState(null);
  const [cannedForm, setCannedForm] = useState(null);
  const rows = inboxes.data?.data ?? [];
  const avail = inboxes.data?.available_mailboxes ?? [];

  async function saveInbox() {
    try {
      const body = { name: form.name, default_assignment: form.default_assignment, members: form.members.split(',').map((x) => x.trim()).filter(Boolean), first_response_hours: form.first_response_hours || null, signature: form.signature || null };
      if (form.id) await api.raw(`/inbox/inboxes/${form.id}`, { method: 'PATCH', body }); else await api.action('/inbox/inboxes', { ...body, account_id: Number(form.account_id) });
      toast('Saved', 'success'); setForm(null); inboxes.refetch();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
  }
  async function saveCanned() {
    try {
      if (cannedForm.id) await api.raw(`/inbox/canned/${cannedForm.id}`, { method: 'PATCH', body: { name: cannedForm.name, body: cannedForm.body } }); else await api.action('/inbox/canned', { name: cannedForm.name, body: cannedForm.body });
      toast('Saved', 'success'); setCannedForm(null); canned.refetch();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <Card flush title="Inboxes" hint={<>A shared mailbox connected under <Link to="/mailboxes">Mailboxes</Link> becomes an inbox here.</>}
        actions={<button type="button" className="btn btn--sm btn--primary" disabled={!avail.length} title={avail.length ? '' : 'Connect a shared mailbox first'} onClick={() => setForm({ name: 'Sales', account_id: String(avail[0].id), default_assignment: 'owner_of_company', members: '', first_response_hours: '', signature: '' })}>+ Inbox</button>}>
        <DataTable rows={rows} empty={<Empty title="No inbox yet" text="Connect the shared sales mailbox under Mailboxes, then add it here." />} columns={[
          { key: 'name', header: 'Inbox', className: 'strong', render: (r) => <>{r.name}<div className="small muted">{r.email}</div></> },
          { key: 'default_assignment', header: 'New email goes to', render: (r) => ({ owner_of_company: 'The client\'s owner, else round robin', round_robin: 'Round robin', unassigned: 'Unassigned queue' }[r.default_assignment]) },
          { key: 'members', header: 'Round robin', render: (r) => r.members.join(', ') || '—' },
          { key: 'first_response_hours', header: 'Reply within', render: (r) => (r.first_response_hours ? `${r.first_response_hours} h` : 'Settings default') },
          { key: 'open', header: 'Open', align: 'right' },
          { key: 'act', header: '', align: 'right', render: (r) => <button type="button" className="btn btn--sm btn--ghost" onClick={() => setForm({ ...r, members: r.members.join(', '), first_response_hours: r.first_response_hours || '', signature: r.signature || '' })}>Edit</button> },
        ]} />
      </Card>
      <Card flush title="Canned responses" hint="Use {{contact_name}}, {{company_name}} and {{my_name}}." actions={<button type="button" className="btn btn--sm" onClick={() => setCannedForm({ name: '', body: '' })}>+ Response</button>}>
        <DataTable rows={canned.data?.data ?? []} columns={[
          { key: 'name', header: 'Name', className: 'strong' },
          { key: 'body', header: 'Text', className: 'wrap small', render: (r) => r.body.slice(0, 160) },
          { key: 'act', header: '', align: 'right', render: (r) => <div className="table__actions"><button type="button" className="btn btn--sm btn--ghost" onClick={() => setCannedForm(r)}>Edit</button><button type="button" className="btn btn--sm btn--ghost" onClick={() => api.remove('inbox/canned', r.id).then(canned.refetch)}>✕</button></div> },
        ]} />
      </Card>
      {form && (
        <Modal title={form.id ? `Edit ${form.name}` : 'New inbox'} onClose={() => setForm(null)} footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn--primary" onClick={saveInbox}>Save</button></>}>
          <div className="form-grid">
            <Field label="Name" required><Input value={form.name} onChange={set('name')} /></Field>
            {!form.id && <Field label="Mailbox" required><Select value={form.account_id} placeholder={null} options={avail.map((a) => ({ value: String(a.id), label: a.email }))} onChange={set('account_id')} /></Field>}
            <Field label="New email goes to"><Select value={form.default_assignment} placeholder={null} options={[{ value: 'owner_of_company', label: 'The client\'s owner, else round robin' }, { value: 'round_robin', label: 'Round robin' }, { value: 'unassigned', label: 'Unassigned queue' }]} onChange={set('default_assignment')} /></Field>
            <Field label="Reply within (hours)" hint="Blank: lead_first_response_hours in Settings"><Input type="number" min="1" value={form.first_response_hours} onChange={set('first_response_hours')} /></Field>
            <div className="span-all"><Field label="Round robin between" hint="Names, comma separated"><Input value={form.members} onChange={set('members')} /></Field></div>
            <div className="span-all"><Field label="Signature"><Textarea rows={3} value={form.signature} onChange={set('signature')} /></Field></div>
          </div>
        </Modal>
      )}
      {cannedForm && (
        <Modal title={cannedForm.id ? 'Edit response' : 'New response'} onClose={() => setCannedForm(null)} footer={<><button type="button" className="btn" onClick={() => setCannedForm(null)}>Cancel</button><button type="button" className="btn btn--primary" disabled={!cannedForm.name.trim() || !cannedForm.body.trim()} onClick={saveCanned}>Save</button></>}>
          <div className="stack">
            <Field label="Name" required><Input value={cannedForm.name} onChange={(e) => setCannedForm((f) => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Text" required><Textarea rows={8} value={cannedForm.body} onChange={(e) => setCannedForm((f) => ({ ...f, body: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
