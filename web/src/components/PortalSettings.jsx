import { Alert, Badge, Card, DataTable, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { ago } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';
import { SESSION_TONE, sessionStatus } from '../lib/portalSession.js';

/**
 * A company's client-portal switches (#47): on or off, which sections,
 * which contacts, who signed in, and everything they looked at.
 *
 * "Who signed in" was the half of that sentence the page did not keep its
 * word on (#103). The route has always sent the company's last fifty portal
 * sessions beside the contacts and the audit log, and this file read two of
 * the three. The contacts table could say somebody last signed in at 09:14
 * and not whether they are still reading; both buttons above promise that
 * they end open sessions, about sessions nothing here had ever shown. Signed
 * in renders them, every state of them, so the promise can be checked.
 */
const LABEL = { projects: 'Projects', documents: 'Documents', invoices: 'Invoices', certificates: 'Certificates', contact: 'Contact us' };

export function PortalSettings({ companyId }) {
  const toast = useToast();
  const { data, refetch } = useFetch(() => api.raw(`/portal-admin/companies/${companyId}`), [companyId]);
  const p = data?.data;
  async function run(fn, ok) {
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); } catch (err) { toast(err.message, 'danger'); }
  }
  const patch = (body, ok) => run(() => api.raw(`/portal-admin/companies/${companyId}`, { method: 'PATCH', body }), ok);
  if (!p) return <Card title="Client portal"><div className="skeleton" style={{ height: 80 }} /></Card>;
  return (
    <>
      <Card title="Client portal" hint="Contacts of this client sign in with a link sent to their email and see only this company."
        actions={<button type="button" className={`btn btn--sm ${p.portal_enabled ? '' : 'btn--primary'}`} onClick={() => patch({ portal_enabled: !p.portal_enabled }, p.portal_enabled ? 'Portal off; open sessions ended' : 'Portal on')}>{p.portal_enabled ? 'Turn off' : 'Turn on'}</button>}>
        {!p.portal_enabled && <Alert tone="info"><span>The portal is off for this client.</span></Alert>}
        <div className="chips" style={{ marginTop: 8 }}>
          {p.sections.map((s) => {
            const on = p.portal_sections.includes(s);
            return <button type="button" key={s} className={`chip ${on ? 'is-on' : ''}`} onClick={() => patch({ portal_sections: on ? p.portal_sections.filter((x) => x !== s) : [...p.portal_sections, s] })}>{LABEL[s]}</button>;
          })}
        </div>
        <p className="small muted">Portal address: <span className="mono">{window.location.origin}/portal</span></p>
      </Card>
      <Card flush title="Who can sign in">
        <DataTable rows={p.contacts} columns={[
          { key: 'name', header: 'Contact', className: 'strong' },
          { key: 'email', header: 'Email', render: (r) => r.email || <span className="muted">no email, cannot sign in</span> },
          { key: 'last_login', header: 'Last sign-in', render: (r) => (r.last_login ? new Date(r.last_login).toLocaleString() : 'never') },
          { key: 'portal_access', header: 'Access', render: (r) => <Badge tone={r.portal_access ? 'success' : 'danger'}>{r.portal_access ? 'allowed' : 'withdrawn'}</Badge> },
          {
            key: 'act', header: '', align: 'right', render: (r) => (
              <div className="table__actions">
                {r.portal_access && r.email && p.portal_enabled && <button type="button" className="btn btn--sm" onClick={() => run(() => api.action(`/portal-admin/contacts/${r.id}/invite`), (x) => `Link sent to ${x.data.sent_to}`)}>Send link</button>}
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => run(() => api.raw(`/portal-admin/contacts/${r.id}`, { method: 'PATCH', body: { portal_access: !r.portal_access } }), r.portal_access ? 'Access withdrawn; sessions ended' : 'Access allowed')}>{r.portal_access ? 'Withdraw' : 'Allow'}</button>
              </div>
            ),
          },
        ]} />
      </Card>
      <Card flush title="Signed in" hint="Every sign-in for this client, newest first. A session lasts eight hours; turning the portal off or withdrawing access ends every open one at once.">
        <DataTable rows={p.sessions ?? []} empty={<div className="small muted" style={{ padding: '12px 18px' }}>Nobody has signed in yet.</div>} columns={[
          { key: 'name', header: 'Contact', className: 'strong' },
          // The word is the state and the colour only agrees with it. There is
          // no column for the expiry itself: it is the sign-in plus eight
          // hours and never moves, so the status is the whole of what one
          // would have said.
          { key: 'status', header: 'Status', render: (r) => { const s = sessionStatus(r); return <Badge tone={SESSION_TONE[s]}>{s}</Badge>; } },
          // Null until a session's second request, so somebody who signed in
          // and read nothing has no last-seen rather than an empty cell.
          { key: 'last_seen_at', header: 'Last seen', className: 'small', render: (r) => ago(r.last_seen_at) ?? 'not since' },
          { key: 'created_at', header: 'Signed in', className: 'small', render: (r) => new Date(r.created_at).toLocaleString() },
          { key: 'ip', header: 'From', className: 'small muted' },
        ]} />
      </Card>
      <Card flush title="Portal activity" hint="Every sign-in, view, download and message.">
        <DataTable rows={p.audit} empty={<div className="small muted" style={{ padding: '12px 18px' }}>Nothing yet.</div>} columns={[
          { key: 'created_at', header: 'When', className: 'small', render: (r) => new Date(r.created_at).toLocaleString() },
          { key: 'name', header: 'Who' },
          { key: 'action', header: 'What', render: (r) => <Badge>{r.action.replace('_', ' ')}</Badge> },
          { key: 'target', header: 'Item', className: 'small mono' },
          { key: 'ip', header: 'From', className: 'small muted' },
        ]} />
      </Card>
    </>
  );
}
