import { useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { ConfirmDialog, Field, Input, Modal, useToast } from './ui.jsx';
import { SettingsPane } from '../pages/SettingsArea.jsx';
import { FailedCard, ListTable, LoadingPanel, Panel, PhoneRow, StateCard } from './daily.jsx';
import { DialogError } from './money.jsx';
import { Tone } from './sales.jsx';
import { RowActions } from './settings.jsx';
import { api } from '../lib/api.js';
import { ago } from '../lib/format.js';
import { useFetch, useLookups } from '../lib/hooks.js';

/**
 * API tokens for the MCP server (#50), Wave 8: Claude and other assistants
 * can read the tracker with one. A sales token sees only that person's
 * records. Revoking now asks first (it can't be undone).
 *
 * The call log is the answer to "Claude cannot read our data" (#103): a
 * failed call keeps the reason, here, in words. It is the latest hundred
 * calls across every token, newest first, as the server returns them.
 */
const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never');

export function ApiTokens() {
  const toast = useToast();
  const lookups = useLookups();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/api-tokens'));
  const [form, setForm] = useState(null);
  const [failure, setFailure] = useState(null);
  const [shown, setShown] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setFailure(null);
    try {
      const r = await api.action('/api-tokens', { name: form.name, role: form.role, can_write: form.can_write, person: form.role === 'sales' ? form.person : undefined });
      setShown({ ...r.data, label: `${form.name} · ${form.role === 'admin' ? 'everything' : `${form.person}’s records`} · ${form.can_write ? 'read and write' : 'read only'}` });
      setForm(null);
      refetch();
    } catch (err) {
      setFailure(err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(t) {
    setBusy(true);
    try {
      await api.action(`/api-tokens/${t.id}/revoke`);
      toast(`${t.name} is revoked`, 'success');
      setRevoking(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }
  const copy = (text, msg) => navigator.clipboard?.writeText(text).then(() => toast(msg, 'success'), () => toast('Couldn’t reach the clipboard. Select it and copy by hand.', 'danger'));

  const endpoint = `${window.location.origin}/api/mcp`;
  const tokens = data?.data ?? [];
  const log = data?.log ?? [];
  const sees = (r) => (r.role === 'admin' ? 'Everything' : `${r.person}’s records`);
  const may = (r) => (r.can_write ? 'Read and write' : 'Read only');
  const startForm = () => { setFailure(null); setForm({ name: '', role: 'sales', person: '', can_write: false }); };

  return (
    <SettingsPane
      title="API tokens"
      description="Tokens that let Claude answer questions from live tracker data. A token only reads unless it’s given writing, and writing means notes, tasks, logged calls and next steps, nothing else."
      actions={<button type="button" className="mg-btn mg-btn--primary" onClick={startForm}><Plus className="size-4" aria-hidden="true" />Create a token</button>}
    >
      {error ? <FailedCard title="Couldn’t load API tokens" text="The server didn’t answer, so nothing is shown. This isn’t “no tokens”: nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !data ? <LoadingPanel rows={4} />
      : (
        <>
          {tokens.length === 0 ? (
            <StateCard tone="plain" title="No tokens yet" text="Create one to let Claude answer questions from live tracker data.">
              <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={startForm}>Create a token</button>
            </StateCard>
          ) : (
            <Panel id="set-tokens" title="Tokens" hint="Writing means notes, tasks, logged calls and next steps. Revoking stops a token at once.">
              <ListTable
                label="API tokens"
                rows={tokens}
                rowClassName={(r) => (r.revoked_at ? 'set-hidden-row' : undefined)}
                columns={[
                  { key: 'name', header: 'Token', render: (r) => <><b>{r.name}</b><span className="set-sub set-mono">{r.token_prefix}…</span></> },
                  { key: 'sees', header: 'Sees', render: sees },
                  { key: 'may', header: 'May', render: (r) => <span className="text-secondary-text">{may(r)}</span> },
                  { key: 'last', header: 'Last used', num: true, render: (r) => when(r.last_used_at) },
                  { key: 'calls', header: 'Calls', num: true, render: (r) => <b>{r.calls}</b> },
                  { key: 'state', header: 'Status', render: (r) => (r.revoked_at ? <Tone>Revoked</Tone> : <Tone tone="ok">Active</Tone>) },
                  { key: 'act', header: '', className: 'actions', render: (r) => !r.revoked_at && <RowActions><button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Revoke ${r.name}`} onClick={() => setRevoking(r)}>Revoke</button></RowActions> },
                ]}
                phone={(r) => (
                  <PhoneRow title={r.name} amount={`${r.calls} calls`} meta={`${sees(r)} · ${may(r).toLowerCase()} · used ${when(r.last_used_at)}`} state={r.revoked_at ? <Tone>Revoked</Tone> : <Tone tone="ok">Active</Tone>}>
                    {!r.revoked_at && <span className="set-rowacts"><button type="button" className="mg-btn mg-btn--sm" aria-label={`Revoke ${r.name}`} onClick={() => setRevoking(r)}>Revoke</button></span>}
                  </PhoneRow>
                )}
              />
            </Panel>
          )}

          <Panel id="set-calls" title="Recent calls" hint="The last hundred tool calls across every token, newest first. A failed call keeps the reason Claude was given.">
            {log.length === 0 ? (
              <p className="app-panel__note">No calls yet.</p>
            ) : (
              <ListTable
                label="Recent calls"
                rows={log}
                rowKey={(r, i) => r.id ?? i}
                columns={[
                  { key: 'created_at', header: 'When', width: '130px', render: (r) => <span className="whitespace-nowrap text-secondary-text">{ago(r.created_at)}</span> },
                  { key: 'name', header: 'Token' },
                  { key: 'tool', header: 'Tool', render: (r) => <b>{r.tool}</b> },
                  // `ok` is a boolean column, so it is compared as one.
                  { key: 'ok', header: 'Result', render: (r) => (r.ok === true ? <Tone tone="ok">OK</Tone> : <Tone tone="late">Failed</Tone>) },
                  // Plain text, never markup: this is a database error, read by the admin who acts on it.
                  { key: 'error', header: 'Why', className: 'app-say', render: (r) => r.error || <span className="text-muted-foreground">—</span> },
                ]}
                phone={(r) => (
                  <PhoneRow title={r.tool} amount={ago(r.created_at)} meta={[r.name, r.error].filter(Boolean).join(' · ')} state={r.ok === true ? <Tone tone="ok">OK</Tone> : <Tone tone="late">Failed</Tone>} wraps />
                )}
              />
            )}
          </Panel>
        </>
      )}

      {form && (
        <Modal
          title="New assistant token"
          subtitle="Lets Claude read tracker data, and write if you allow it"
          onClose={() => setForm(null)}
          footer={<>
            <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
            <button type="button" className="mg-btn mg-btn--primary" disabled={busy || !form.name.trim() || (form.role === 'sales' && !form.person.trim())} onClick={create}>{busy ? 'Creating…' : 'Create token'}</button>
          </>}
        >
          <div className="form-grid">
            {failure && <div className="span-all"><DialogError error={failure} what="the token" /></div>}
            <div className="span-all"><Field label="Name" required hint="Whose and where, e.g. Priya’s laptop."><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field></div>
            <div className="span-all">
              <Field as="div" label="Sees" required>
                <div className="set-radios" role="radiogroup" aria-label="Sees">
                  {[['sales', 'One salesperson’s records', 'The deals, companies and money that person owns'], ['admin', 'Everything', 'Every record, like an admin']].map(([v, t, d]) => (
                    <label key={v} className="set-radio"><input type="radio" name="tok-role" checked={form.role === v} onChange={() => setForm({ ...form, role: v })} /><span><b>{t}</b><small>{d}</small></span></label>
                  ))}
                </div>
              </Field>
            </div>
            {form.role === 'sales' && (
              <Field label="Sales person" required hint="Needed when it sees one salesperson’s records.">
                <Input list="token-people" value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })} />
                <datalist id="token-people">{lookups.sales_people.map((p) => <option key={p} value={p} />)}</datalist>
              </Field>
            )}
            <div className="span-all">
              <Field as="div" label="May">
                <div className="set-radios" role="radiogroup" aria-label="May">
                  {[[false, 'Read only', ''], [true, 'Read, and add notes and tasks', 'Notes, tasks, logged calls and next steps; nothing else']].map(([v, t, d]) => (
                    <label key={t} className="set-radio"><input type="radio" name="tok-write" checked={form.can_write === v} onChange={() => setForm({ ...form, can_write: v })} /><span><b>{t}</b>{d && <small>{d}</small>}</span></label>
                  ))}
                </div>
              </Field>
            </div>
          </div>
        </Modal>
      )}
      {shown && (
        <Modal
          title="Token created"
          subtitle="Shown only now. Treat it like a password."
          onClose={() => setShown(null)}
          footer={<>
            <button type="button" className="mg-btn" onClick={() => copy(shown.token, 'Copied. Paste it into Claude Code now; it isn’t shown again.')}><Copy className="size-4" aria-hidden="true" />Copy token</button>
            <button type="button" className="mg-btn mg-btn--primary" onClick={() => setShown(null)}>Done</button>
          </>}
        >
          <div className="flex flex-col gap-4">
            <Field as="div" label="Token" hint={shown.label}><span className="set-secret">{shown.token}</span></Field>
            <Field as="div" label="In Claude Code, run">
              <span className="set-secret">claude mcp add --transport http cetizion {endpoint} --header &quot;Authorization: Bearer {shown.token}&quot;</span>
              <span><button type="button" className="mg-btn mg-btn--sm mt-2" onClick={() => copy(`claude mcp add --transport http cetizion ${endpoint} --header "Authorization: Bearer ${shown.token}"`, 'Command copied')}><Copy className="size-3.5" aria-hidden="true" />Copy command</button></span>
            </Field>
          </div>
        </Modal>
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          subtitle={`${sees(revoking)} · ${may(revoking).toLowerCase()} · ${revoking.calls} calls`}
          message="Claude on that computer stops getting answers straight away. This can’t be undone; create a new token if they still need one."
          confirmLabel="Revoke token"
          cancelLabel="Keep it"
          busy={busy}
          onConfirm={() => revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </SettingsPane>
  );
}
