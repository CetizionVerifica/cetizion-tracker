import { useCallback, useState } from 'react';
import { Eye } from 'lucide-react';
import { PortalSection, PORTAL_LABEL } from '../pages/Portal.jsx';
import { Sec } from './sales.jsx';
import { api } from '../lib/api.js';

/**
 * Preview as client (#198, G7): the company's portal as its contacts see it,
 * drawn by the portal's own sections from the same server functions, so the
 * preview cannot drift from the real thing (Wave 9 owns their look). Admins
 * only, like the rest of the portal switches. Nothing loads until it is
 * opened. `enabled` is the sections switched on, so a tab says "(off)" from
 * the start rather than after it loads.
 */
export function PortalPreview({ companyId, companyName, sections, enabled }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('invoices');
  const [meta, setMeta] = useState({});
  // Stable per company: the sections refetch when this changes.
  const load = useCallback(async (path) => {
    const name = path.replace(/^\//, '');
    const res = await api.raw(`/portal-admin/companies/${companyId}/preview/${name}`);
    setMeta((m) => ({ ...m, [name]: res.meta }));
    return res.data;
  }, [companyId]);
  const names = ['projects', 'invoices', 'documents', 'certificates'];
  const all = sections?.length ? sections : names;
  const isOff = (s) => (meta[s] ? !meta[s].enabled : enabled ? !enabled.includes(s) : false);

  return (
    <Sec
      id="portal-preview"
      title="Preview as client"
      hint={`what ${companyName || 'this client'}’s contacts see, figures and all`}
      tools={<button type="button" className="mg-btn mg-btn--sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : <><Eye className="size-4" aria-hidden="true" />Show the client's view</>}</button>}
    >
      <p className="m-0 text-[12.5px] text-muted-foreground">Drawn by the portal itself, from the same figures. Files open only in the client’s own session.</p>
      {!open ? (
        <div className="mg-empty app-box">
          <span className="mg-empty__mark"><Eye className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h4 className="mg-empty__title">Not loaded yet</h4>
          <p className="mg-empty__text">Nothing is fetched until you open it, so the client’s figures are read fresh.</p>
        </div>
      ) : (
        <div className="app-preview">
          <div className="app-chiprow" role="group" aria-label="Client portal sections">
            {names.map((s) => (
              <button type="button" key={s} className="mg-chip" aria-pressed={tab === s} onClick={() => setTab(s)}>
                {PORTAL_LABEL[s]}{isOff(s) ? ' (off)' : ''}
              </button>
            ))}
          </div>
          {isOff(tab) && <div className="mg-banner" role="note"><div className="mg-banner__body">This section is switched off: the client does not see it.</div></div>}
          <div className="accept__card portal portal--preview">
            <PortalSection key={tab} name={tab} sections={all} load={load} preview />
          </div>
        </div>
      )}
    </Sec>
  );
}
