import { useState } from 'react';
import { Check, Copy, Globe } from 'lucide-react';
import { ConfirmDialog, DataTable, useToast } from './ui.jsx';
import { Sec, Tone } from './sales.jsx';
import { api } from '../lib/api.js';

/**
 * A company's client-portal switches (#47): on or off, which sections,
 * which contacts, who signed in, and everything they looked at. Drawn flat,
 * as the company page's Client portal tab; the page loads the settings
 * (`portal`: { data, loading, error, refetch }) so its header and the
 * preview can read them too. Turning the portal off and withdrawing access
 * both ask first, because both end open sessions.
 */
export const PORTAL_SECTION_LABEL = { projects: 'Projects', documents: 'Documents', invoices: 'Invoices', certificates: 'Certificates', contact: 'Contact us' };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);

export function PortalSettings({ companyId, companyName, portal }) {
  const toast = useToast();
  const p = portal.data?.data;
  const [confirm, setConfirm] = useState(null);   // { kind: 'off' } | { kind: 'withdraw', contact }
  const [busy, setBusy] = useState(false);
  async function run(fn, ok) {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success'); portal.refetch(); return true; }
    catch (err) { toast(err.message, 'danger'); return false; }
    finally { setBusy(false); }
  }
  const patch = (body, ok) => run(() => api.raw(`/portal-admin/companies/${companyId}`, { method: 'PATCH', body }), ok);
  const address = `${window.location.origin}/portal`;
  async function copy() {
    try { await navigator.clipboard.writeText(address); toast('Portal address copied', 'success'); } catch { toast('Select the address and copy it', 'info'); }
  }

  if (portal.error) {
    return (
      <div className="mg-empty app-box" role="alert">
        <h4 className="mg-empty__title">Couldn't load the portal settings</h4>
        <p className="mg-empty__text">{portal.error}</p>
        <button type="button" className="mg-btn mg-btn--sm" onClick={portal.refetch}>Try again</button>
      </div>
    );
  }
  if (!p) {
    return <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the portal settings"><div className="mg-skel" style={{ height: 120 }} /><div className="mg-skel" style={{ height: 160 }} /></div>;
  }

  return (
    <div className="app-portal">
      <div className="app-soft flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="m-0 flex-1 text-[14.5px] font-bold">Client portal</h3>
          <label className="mg-switch">
            <input
              type="checkbox"
              role="switch"
              checked={p.portal_enabled}
              disabled={busy}
              aria-label={`Client portal for ${companyName}`}
              onChange={() => (p.portal_enabled ? setConfirm({ kind: 'off' }) : patch({ portal_enabled: true }, 'Portal on: contacts with access can sign in'))}
            />
            <span className="text-[13px] font-bold">{p.portal_enabled ? 'On' : 'Off'}</span>
          </label>
        </div>
        {p.portal_enabled ? (
          <p className="m-0 text-[12.5px] text-secondary-text">Contacts of {companyName} sign in with a link sent to their email, and see only this company. Choose what they see:</p>
        ) : (
          <div className="mg-banner" role="status">
            <Globe aria-hidden="true" />
            <div className="mg-banner__body"><strong>The portal is off for this client.</strong>Nobody from {companyName} can sign in. Turn it on, then send a contact their link.</div>
            <button type="button" className="mg-btn mg-btn--primary mg-btn--sm self-center" disabled={busy} onClick={() => patch({ portal_enabled: true }, 'Portal on: contacts with access can sign in')}>Turn on</button>
          </div>
        )}
        <div className="app-portal__sections" role="group" aria-label="Sections the client sees">
          {p.sections.map((s) => {
            const on = p.portal_sections.includes(s);
            return (
              <button type="button" key={s} className="mg-chip" aria-pressed={on} disabled={busy} onClick={() => patch({ portal_sections: on ? p.portal_sections.filter((x) => x !== s) : [...p.portal_sections, s] }, `${PORTAL_SECTION_LABEL[s] || s} ${on ? 'hidden from' : 'shown to'} the client`)}>
                {on && <Check aria-hidden="true" />}{PORTAL_SECTION_LABEL[s] || s}{!on && <span className="sr-only"> (off)</span>}
              </button>
            );
          })}
        </div>
        <p className="m-0 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
          Portal address <b className="text-foreground [overflow-wrap:anywhere]">{address.replace(/^https?:\/\//, '')}</b>
          <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={copy}><Copy className="size-3.5" aria-hidden="true" />Copy</button>
        </p>
      </div>

      <Sec id="portal-who" title="Who can sign in" hint="a contact needs an email and access">
        {p.contacts.length === 0 ? (
          <div className="mg-empty app-box"><h4 className="mg-empty__title">No contacts yet</h4><p className="mg-empty__text">Add a contact with an email under People, then send them their link.</p></div>
        ) : (
          <div className="app-box">
            <DataTable
              rows={p.contacts}
              label="Who can sign in"
              phone={(r) => (
                <div className="mg-row">
                  <span className="mg-row__title">{r.name}</span>
                  <span className="mg-row__amount"><Tone tone={r.portal_access ? 'ok' : 'late'}>{r.portal_access ? 'Allowed' : 'Withdrawn'}</Tone></span>
                  <span className="mg-row__meta" style={{ gridColumn: '1 / -1', whiteSpace: 'normal' }}>{r.email || 'No email yet'} · last sign-in {r.last_login ? when(r.last_login) : 'never'}</span>
                  {!r.email && <span className="col-span-2 mt-2"><AddEmail contact={r} onSave={(email) => run(() => api.update('contacts', r.id, { email }), `Email saved for ${r.name}`)} /></span>}
                  <span className="col-span-2 mt-2 flex flex-wrap justify-end gap-2">{acts(r)}</span>
                </div>
              )}
              columns={[
                { key: 'name', header: 'Contact', className: 'strong' },
                { key: 'email', header: 'Email', render: (r) => r.email || <AddEmail contact={r} onSave={(email) => run(() => api.update('contacts', r.id, { email }), `Email saved for ${r.name}`)} /> },
                { key: 'last_login', header: 'Last sign-in', render: (r) => (r.last_login ? when(r.last_login) : <span className="text-muted-foreground">Never</span>) },
                { key: 'portal_access', header: 'Access', render: (r) => <Tone tone={r.portal_access ? 'ok' : 'late'}>{r.portal_access ? 'Allowed' : 'Withdrawn'}</Tone> },
                { key: 'act', header: '', align: 'right', render: acts },
              ]}
            />
          </div>
        )}
      </Sec>

      <Sec id="portal-log" title="Portal activity" hint="every sign-in, view, download and message">
        {p.audit.length === 0 ? (
          <div className="mg-empty app-box"><h4 className="mg-empty__title">Nothing yet</h4><p className="mg-empty__text">Sign-ins, views, downloads and messages from {companyName} show here.</p></div>
        ) : (
          <div className="app-box">
            <DataTable
              rows={p.audit}
              label="Portal activity"
              phone={(r) => (
                <div className="mg-row">
                  <span className="mg-row__title">{r.name}</span>
                  <span className="mg-row__amount text-[12.5px]">{when(r.created_at)}</span>
                  <span className="mg-row__meta" style={{ gridColumn: '1 / -1' }}>{r.action.replace(/_/g, ' ')}{r.target ? ` · ${r.target}` : ''}</span>
                </div>
              )}
              columns={[
                { key: 'created_at', header: 'When', render: (r) => when(r.created_at) },
                { key: 'name', header: 'Who' },
                { key: 'action', header: 'What', render: (r) => <Tone tone="plain">{r.action.replace(/_/g, ' ')}</Tone> },
                { key: 'target', header: 'Item', render: (r) => r.target || <span className="text-muted-foreground">—</span> },
                { key: 'ip', header: 'From', render: (r) => <span className="text-muted-foreground">{r.ip}</span> },
              ]}
            />
          </div>
        )}
      </Sec>

      {confirm?.kind === 'off' && (
        <ConfirmDialog
          title={`Turn the portal off for ${companyName}?`}
          message="Nobody from this client can sign in, and every open session ends at once. The sections and who has access are kept for when you turn it back on."
          confirmLabel="Turn it off"
          cancelLabel="Keep it on"
          busy={busy}
          onConfirm={async () => { if (await patch({ portal_enabled: false }, 'Portal off; open sessions ended')) setConfirm(null); }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'withdraw' && (
        <ConfirmDialog
          title={`Withdraw ${confirm.contact.name}'s access?`}
          message={`${confirm.contact.name} can no longer sign in, and any open session ends at once. You can allow it again later.`}
          confirmLabel="Withdraw access"
          busy={busy}
          onConfirm={async () => { if (await run(() => api.raw(`/portal-admin/contacts/${confirm.contact.id}`, { method: 'PATCH', body: { portal_access: false } }), 'Access withdrawn; sessions ended')) setConfirm(null); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );

  function acts(r) {
    return (
      <span className="app-rowacts">
        {r.portal_access && r.email && p.portal_enabled && <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => run(() => api.action(`/portal-admin/contacts/${r.id}/invite`), (x) => `Link sent to ${x.data.sent_to}`)}>Send link</button>}
        {r.portal_access
          ? <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setConfirm({ kind: 'withdraw', contact: r })}>Withdraw</button>
          : <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" disabled={busy} onClick={() => run(() => api.raw(`/portal-admin/contacts/${r.id}`, { method: 'PATCH', body: { portal_access: true } }), `Access allowed for ${r.name}`)}>Allow</button>}
      </span>
    );
  }
}

/**
 * A contact with no email cannot sign in, and most have none
 * (docs/client-data-gaps.md). Their email is typed here, where it is
 * missed, rather than on another page (#198 phase 3). Saving… while it
 * goes, and the server's refusal under the field (K-5).
 */
function AddEmail({ contact, onSave }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    const email = value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Type a whole email address'); return; }
    setBusy(true); setError(null);
    const ok = await onSave(email);
    setBusy(false);
    if (!ok) setError('Not saved. Check the address and try again');
  }
  return (
    <form className="flex flex-col gap-1" title="No email: cannot sign in until one is added" onSubmit={submit} noValidate>
      <span className="flex items-center gap-1.5">
        <input className="mg-input" style={{ height: 36, width: '100%', minWidth: 120, maxWidth: 200, borderRadius: 999, fontSize: 12.5 }} type="email" maxLength={160} value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} placeholder="Add an email" aria-label={`Email for ${contact.name}`} aria-invalid={error ? true : undefined} aria-describedby={error ? `email-err-${contact.id}` : undefined} disabled={busy} />
        <button type="submit" className="mg-btn mg-btn--sm" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save'}</button>
      </span>
      {error && <span id={`email-err-${contact.id}`} className="text-[12px] font-semibold text-late">{error}</span>}
    </form>
  );
}
