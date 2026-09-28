import { Alert, Badge, Card, DataTable, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * A company's client-portal switches (#47): on or off, which sections,
 * which contacts, who signed in, and everything they looked at.
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
