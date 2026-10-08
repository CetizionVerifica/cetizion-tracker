import { useCallback, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { PortalSection, PORTAL_LABEL, PORTAL_ORDER } from '../pages/Portal.jsx';
import { Sec } from './sales.jsx';
import { api } from '../lib/api.js';

/**
 * Preview as client (#198, G7): the company's portal as its contacts see it,
 * drawn by the portal's own sections from the same server functions, so the
 * preview cannot drift from the real thing (Wave 9). Flat inside this panel,
 * no answers, files as names. Admins only, like the rest of the portal
 * switches. Nothing loads until it is opened. `enabled` is the sections
 * switched on, so a tab says "(off)" from the start rather than after it
 * loads; the tabs keep the client's order, and open on the client's first.
 */
export function PortalPreview({ companyId, companyName, enabled }) {
  const on = enabled?.length ? enabled : PORTAL_ORDER;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(() => PORTAL_ORDER.find((s) => on.includes(s)) || 'projects');
  const [meta, setMeta] = useState({});
  // Stable per company: the sections refetch when this changes.
  const load = useCallback(async (path) => {
    const name = path.replace(/^\//, '');
    const res = await api.raw(`/portal-admin/companies/${companyId}/preview/${name}`);
    setMeta((m) => ({ ...m, [name]: res.meta }));
    return res.data;
  }, [companyId]);
  const isOff = (s) => (meta[s] ? !meta[s].enabled : enabled ? !enabled.includes(s) : false);
  const keys = (e) => {
    const i = PORTAL_ORDER.indexOf(tab);
    const next = e.key === 'ArrowRight' ? PORTAL_ORDER[(i + 1) % 5] : e.key === 'ArrowLeft' ? PORTAL_ORDER[(i + 4) % 5] : null;
    if (!next) return;
    e.preventDefault(); setTab(next);
    const host = e.currentTarget.parentElement;
    requestAnimationFrame(() => host?.querySelector('[aria-selected="true"]')?.focus());
  };

  return (
    <Sec
      id="portal-preview"
      title="Preview as client"
      hint={`What ${companyName || 'this client'}’s contacts see in the portal, figures and all. Files open only in the client’s own session.`}
      tools={(
        <button type="button" className="mg-btn mg-btn--sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <><EyeOff className="size-4" aria-hidden="true" />Hide</> : <><Eye className="size-4" aria-hidden="true" />Show the client's view</>}
        </button>
      )}
    >
      {!open ? (
        <p className="m-0 text-[13px] text-secondary-text">Nothing loads until you open it. Use it before you switch the portal on, or when a client asks about a figure.</p>
      ) : (
        <div className="cl-preview">
          <div className="cl-preview__bar">
            <div className="cl-preview__tabs" role="tablist" aria-label="Portal sections, as the client sees them">
              {PORTAL_ORDER.map((s) => (
                <button type="button" key={s} role="tab" aria-selected={tab === s} tabIndex={tab === s ? 0 : -1} className={isOff(s) ? 'is-off' : undefined}
                  onClick={() => setTab(s)} onKeyDown={keys}>
                  {PORTAL_LABEL[s]}{isOff(s) ? ' (off)' : ''}
                </button>
              ))}
            </div>
            <span className="cl-meta cl-preview__note">Same order the client sees</span>
          </div>
          {isOff(tab) && (
            <div className="mg-banner mg-banner--wait" role="note">
              <EyeOff strokeWidth={1.8} aria-hidden="true" />
              <div className="mg-banner__body"><strong>This section is switched off</strong>The client does not see it. Switch it on in the Client portal tab to show it.</div>
            </div>
          )}
          <div className="cl-panel" role="tabpanel" aria-label={PORTAL_LABEL[tab]}>
            <PortalSection key={tab} name={tab} sections={on} load={load} preview company={companyName} />
          </div>
        </div>
      )}
    </Sec>
  );
}
