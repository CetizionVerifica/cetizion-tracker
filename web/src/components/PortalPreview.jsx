import { useCallback, useState } from 'react';
import { Card } from './ui.jsx';
import { Button } from './ui/button';
import { PortalSection, PORTAL_LABEL } from '../pages/Portal.jsx';
import { api } from '../lib/api.js';

/**
 * Preview as client (#198, G7): the company's portal as its contacts see it,
 * drawn by the portal's own components from the same server functions, so
 * the preview cannot drift from the real thing. Admins only, like the rest
 * of the portal switches. Nothing loads until it is opened.
 */
export function PortalPreview({ companyId, sections }) {
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

  return (
    <Card title="Preview as client" hint="What this client's contacts see in the portal, figures and all. Files open only in the client's own session."
      actions={<Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show the client\'s view'}</Button>}>
      {open && (
        <div className="accept__card portal portal--preview">
          <div className="portal__tabs">
            {names.map((s) => (
              <button type="button" key={s} className={`portal__tab ${tab === s ? 'is-on' : ''}`} onClick={() => setTab(s)}>
                {PORTAL_LABEL[s]}{meta[s] && !meta[s].enabled ? ' (off)' : ''}
              </button>
            ))}
          </div>
          {meta[tab] && !meta[tab].enabled && <p className="accept__muted">This section is switched off: the client does not see it.</p>}
          <PortalSection key={tab} name={tab} sections={all} load={load} preview />
        </div>
      )}
    </Card>
  );
}
