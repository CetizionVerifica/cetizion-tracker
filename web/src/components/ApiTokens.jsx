import { useState } from 'react';
import { Alert, Badge, Card, DataTable, Field, Input, Modal, Select, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';

/**
 * API tokens for the MCP server (#50): Claude and other assistants can read
 * the tracker with one. A sales token sees only that person's records.
 */
export function ApiTokens() {
  const toast = useToast();
  const lookups = useLookups();
  const { data, refetch } = useFetch(() => api.raw('/api-tokens'));
  const [form, setForm] = useState(null);
  const [shown, setShown] = useState(null);
  async function create() {
    try {
      const r = await api.action('/api-tokens', { name: form.name, role: form.role, can_write: form.can_write, person: form.role === 'sales' ? form.person : undefined });
      setShown(r.data); setForm(null); refetch();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
  }
  const endpoint = `${window.location.origin}/api/mcp`;
  return (
    <Card flush title="Assistant access (MCP)" hint="Tokens that let Claude answer questions from live tracker data. A token reads only unless it is given writing, and writing means notes, tasks, logged calls and next steps; nothing else."
      actions={<button type="button" className="btn btn--sm btn--primary" onClick={() => setForm({ name: '', role: 'sales', person: '', can_write: false })}>+ Token</button>}>
      <DataTable rows={data?.data ?? []} empty={<div className="small muted" style={{ padding: '12px 18px' }}>No tokens yet.</div>} columns={[
        { key: 'name', header: 'Token', className: 'strong', render: (r) => <>{r.name}<div className="small muted mono">{r.token_prefix}…</div></> },
        { key: 'role', header: 'Sees', render: (r) => (r.role === 'admin' ? 'Everything' : `${r.person}'s records`) },
        { key: 'can_write', header: 'May', render: (r) => (r.can_write ? 'Read and write' : 'Read only') },
        { key: 'last_used_at', header: 'Last used', className: 'small', render: (r) => (r.last_used_at ? new Date(r.last_used_at).toLocaleString() : 'never') },
        { key: 'calls', header: 'Calls', align: 'right' },
        { key: 'state', header: '', render: (r) => (r.revoked_at ? <Badge tone="danger">revoked</Badge> : <Badge tone="success">active</Badge>) },
        { key: 'act', header: '', align: 'right', render: (r) => !r.revoked_at && <button type="button" className="btn btn--sm btn--ghost" onClick={() => api.action(`/api-tokens/${r.id}/revoke`).then(() => { toast('Revoked', 'success'); refetch(); })}>Revoke</button> },
      ]} />
      {form && (
        <Modal title="New assistant token" onClose={() => setForm(null)} footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn--primary" disabled={!form.name.trim() || (form.role === 'sales' && !form.person.trim())} onClick={create}>Create</button></>}>
          <div className="form-grid">
            <Field label="Name" required hint="Whose and where, e.g. Priya's laptop"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Sees"><Select value={form.role} placeholder={null} options={[{ value: 'sales', label: "One sales person's records" }, { value: 'admin', label: 'Everything (admin)' }]} onChange={(e) => setForm({ ...form, role: e.target.value })} /></Field>
            <Field label="May"><Select value={form.can_write ? 'write' : 'read'} placeholder={null} options={[{ value: 'read', label: 'Read only' }, { value: 'write', label: 'Read, and add notes and tasks' }]} onChange={(e) => setForm({ ...form, can_write: e.target.value === 'write' })} /></Field>
            {form.role === 'sales' && <Field label="Sales person" required><Input list="token-people" value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })} /><datalist id="token-people">{lookups.sales_people.map((p) => <option key={p} value={p} />)}</datalist></Field>}
          </div>
        </Modal>
      )}
      {shown && (
        <Modal title="Token created" subtitle="Shown only now. Treat it like a password." onClose={() => setShown(null)}
          footer={<><button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(shown.token).then(() => toast('Copied', 'success'))}>Copy token</button><button type="button" className="btn btn--primary" onClick={() => setShown(null)}>Done</button></>}>
          <div className="stack">
            <Field label="Token"><Input readOnly className="mono" value={shown.token} onFocus={(e) => e.target.select()} /></Field>
            <Alert tone="info"><span>In Claude Code, run:<br /><code className="mono small">claude mcp add --transport http cetizion {endpoint} --header "Authorization: Bearer {shown.token}"</code></span></Alert>
          </div>
        </Modal>
      )}
    </Card>
  );
}
