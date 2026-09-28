import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from 'cn';
import { ListPage } from '../components/ListPage.jsx';
import { ChevronDown, ChevronUp, Merge, X } from 'lucide-react';
import { Alert, Badge, Modal, useToast } from '../components/ui.jsx';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/** Where this browser remembers that the duplicates banner was dismissed. */
const DUPES_HIDDEN = 'cetizion.companies.duplicates';

/**
 * Every client once (#20). A company is created the moment a name is typed
 * on an enquiry, quotation or project; this page is where its spelling,
 * sector and contacts are kept, and where two spellings of one client are
 * folded together.
 */
export default function Companies() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const toast = useToast();
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState(null);   // the group being looked at
  const [keepId, setKeepId] = useState(null);  // the spelling that survives
  const [chosen, setChosen] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Remembered per browser, like the sidebar. Reading it can throw in a
  // locked-down browser, and a page that will not render because of a
  // preference is worse than a preference that does not stick.
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(DUPES_HIDDEN) === 'hidden'; } catch { return false; }
  });
  const hide = (value) => {
    setHidden(value);
    setExpanded(false);
    try { localStorage.setItem(DUPES_HIDDEN, value ? 'hidden' : 'shown'); } catch { /* not this browser's to remember */ }
  };
  const dups = useFetch(() => api.raw('/companies/duplicates'), [refresh]);
  const groups = dups.data?.data ?? [];
  const SHOWN = 8;
  const listed = expanded ? groups : groups.slice(0, SHOWN);

  /**
   * Open a group. A same-name group has nothing to weigh up, so everything
   * starts ticked; a shares-a-brand group starts with nothing ticked,
   * because "Hindalco - Belur" and "Hindalco FRP" are two plants and the
   * whole point of the group is to ask which of these are one client.
   */
  function openGroup(group) {
    setReview(group);
    setKeepId(group.suggested_keep);
    setChosen(new Set(group.certain ? group.members.map((m) => m.id) : []));
  }

  const toggle = (id) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** Fold every ticked spelling into the chosen one, oldest history last. */
  async function merge() {
    const losers = review.members.filter((m) => m.id !== keepId && chosen.has(m.id));
    if (!losers.length) return;
    setBusy(true);
    try {
      for (const m of losers) await api.action(`/companies/${m.id}/merge`, { into: keepId });
      const keep = review.members.find((m) => m.id === keepId);
      toast(`${losers.length} spelling${losers.length === 1 ? '' : 's'} folded into ${keep.name}`, 'success');
      invalidateLookups();
      setReview(null);
      setRefresh((n) => n + 1);
    } catch (err) {
      // Merges run one at a time, so some may already have happened.
      toast(`${err.message}. Reopen the group to see what is left.`, 'danger');
      setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  const keep = review?.members.find((m) => m.id === keepId);
  const losing = review ? review.members.filter((m) => m.id !== keepId && chosen.has(m.id)) : [];

  const columns = [
    { key: 'name', header: 'Company', className: 'strong', render: (r) => <>{r.name}{r.city && <div className="small muted">{r.city}</div>}</> },
    { key: 'sector', header: 'Sector', render: (r) => r.sector || <span className="muted">—</span> },
    { key: 'contacts', header: 'Contacts', align: 'right' },
    { key: 'enquiries', header: 'Enquiries', align: 'right' },
    { key: 'quotations', header: 'Quotations', align: 'right', render: (r) => <>{r.quotations}{r.won_quotations > 0 && <span className="small muted"> · {r.won_quotations} won</span>}</> },
    { key: 'projects', header: 'Projects', align: 'right' },
    { key: 'po_value_inr', header: 'PO value (INR)', align: 'right', render: (r) => money(r.po_value_inr) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => (r.outstanding > 0 ? <Badge tone="warning">{money(r.outstanding)}</Badge> : <span className="muted">—</span>) },
    { key: 'last_activity', header: 'Last activity', render: (r) => date(r.last_activity) },
  ];

  const fields = [
    { name: 'name', label: 'Company name', required: true, span: 2, hint: 'Renaming here renames the client on every record' },
    { name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors },
    { name: 'city', label: 'City' },
    { name: 'gstin', label: 'GSTIN' },
    { name: 'website', label: 'Website' },
    { name: 'address', label: 'Address', type: 'textarea', span: 'all' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];

  return (
    <>
      <ListPage
        title="Companies"
        subtitle="Every client once: contacts, sector and everything the tracker holds for them"
        resource="companies"
        columns={columns}
        fields={fields}
        newLabel="Company"
        formTitle="company"
        searchPlaceholder="Search company, sector, city, GSTIN…"
        onRowClick={(row) => navigate(`/companies/${row.id}`)}
        refreshToken={refresh}
        onSaved={() => { invalidateLookups(); setRefresh((n) => n + 1); }}
        filters={[
          { name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sectors] },
          { name: 'contacts', label: 'Contacts', options: [{ value: '0', label: 'None' }] },
        ]}
        banner={groups.length > 0 && (hidden ? (
          // Hidden, not gone. Something that can never be found again is not
          // a preference, it is a trapdoor.
          <div className="mb-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span>{groups.length} possible duplicate{groups.length === 1 ? '' : 's'}</span>
            <Button variant="link" size="xs" className="h-auto p-0" onClick={() => hide(false)}>Show</Button>
          </div>
        ) : (
          <Alert tone="warning">
            <div className="w-full">
              <div className="flex items-start gap-3">
                <p className="measure flex-1">
                  <strong>{groups.length} group{groups.length === 1 ? '' : 's'} of companies may be one client spelt more than once.</strong>{' '}
                  Open one to choose which spellings are really the same, and which to keep.
                </p>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="-mr-1 -mt-0.5 shrink-0 text-current/70 hover:text-current"
                  aria-label="Hide duplicate suggestions"
                  onClick={() => hide(true)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>

              <ul className="mt-2.5 divide-y divide-current/10 border-t border-current/10">
                {listed.map((g) => (
                  <li key={g.members[0].id} className="flex items-center gap-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">
                      <Link to={`/companies/${g.members[0].id}`} className="font-medium underline-offset-2 hover:underline">
                        {g.members[0].name}
                      </Link>
                      <span className="text-current/70"> +{g.size - 1} more</span>
                    </span>
                    <span className="hidden shrink-0 tabular-nums text-[12px] text-current/70 sm:inline">
                      {g.records} record{g.records === 1 ? '' : 's'}
                    </span>
                    <Badge tone={g.certain ? 'warning' : 'neutral'} className="hidden shrink-0 md:inline-flex">{g.confidence}</Badge>
                    <Button variant="outline" size="xs" className="shrink-0" onClick={() => openGroup(g)}>Review</Button>
                  </li>
                ))}
              </ul>

              {groups.length > SHOWN && (
                <Button variant="link" size="xs" className="mt-1.5 h-auto p-0" onClick={() => setExpanded(!expanded)}>
                  {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                  {expanded ? `Show first ${SHOWN}` : `Show all ${groups.length}`}
                </Button>
              )}
            </div>
          </Alert>
        ))}
      />
      {review && (
        <Modal
          size="lg"
          title={review.certain ? 'The same name, spelt differently' : 'Which of these are the same client?'}
          subtitle={review.certain
            ? 'These differ only by punctuation, so there is nothing to weigh up.'
            : 'These share a brand. That does not make them one company \u2014 a plant, a unit or a subsidiary is its own client. Tick only the ones that are genuinely the same.'}
          onClose={() => setReview(null)}
          footer={(
            <div className="flex w-full items-center justify-between gap-3">
              <p className="text-[12px] text-muted-foreground">
                {losing.length
                  ? `${losing.length} of ${review.size} fold in \u00b7 ${losing.reduce((n, m) => n + m.records, 0)} record${losing.reduce((n, m) => n + m.records, 0) === 1 ? '' : 's'} move`
                  : 'Nothing ticked yet'}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setReview(null)}>Cancel</Button>
                <Button variant="destructive" disabled={busy || !losing.length} onClick={merge}>
                  <Merge aria-hidden="true" />
                  {busy ? 'Merging\u2026' : losing.length ? `Merge into ${keep?.name}` : 'Merge'}
                </Button>
              </div>
            </div>
          )}
        >
          <ul className="space-y-1.5">
            {review.members.map((m) => {
              const keeping = m.id === keepId;
              const ticked = chosen.has(m.id);
              return (
                <li
                  key={m.id}
                  className={cn(
                    'flex items-center gap-3 rounded-[10px] border px-3 py-2.5 transition-colors',
                    keeping
                      ? 'border-l-[3px] border-primary/40 border-l-primary bg-primary/5'
                      : ticked
                        ? 'border-late/40 bg-late/5'
                        : 'border-border hover:border-muted-foreground/40 hover:bg-accent/40'
                  )}
                >
                  {keeping ? (
                    <Badge tone="success" className="shrink-0">Keeping</Badge>
                  ) : (
                    // The whole label is the hit target, not the 16px box.
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                      <Checkbox
                        className="size-[18px] border-muted-foreground/60"
                        checked={ticked}
                        onCheckedChange={() => toggle(m.id)}
                        aria-label={`Fold ${m.name} into ${keep?.name ?? 'the one kept'}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{m.name}</span>
                        <span className="block text-[12px] text-muted-foreground">
                          {[m.sector, `${m.records} record${m.records === 1 ? '' : 's'}`].filter(Boolean).join(' \u00b7 ')}
                        </span>
                      </span>
                    </label>
                  )}

                  {keeping && (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">{m.name}</span>
                      <span className="block text-[12px] text-muted-foreground">
                        {[m.sector, `${m.records} record${m.records === 1 ? '' : 's'}`].filter(Boolean).join(' \u00b7 ')}
                      </span>
                    </span>
                  )}

                  <Link
                    to={`/companies/${m.id}`}
                    className="shrink-0 text-[12px] text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Open
                  </Link>
                  {!keeping && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0"
                      onClick={() => { setKeepId(m.id); setChosen((prev) => { const n = new Set(prev); n.delete(m.id); return n; }); }}
                    >
                      Keep this one
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>

          {losing.length > 0 && (
            <div className="mt-4">
              <Alert tone="danger">
                <span className="measure">
                  Every enquiry, quotation, project and contact under{' '}
                  <strong>{losing.map((m) => m.name).join(', ')}</strong> moves to{' '}
                  <strong>{keep?.name}</strong> and takes that name.{' '}
                  {losing.length === 1 ? 'That company is' : 'Those companies are'} then deleted. This cannot be undone.
                </span>
              </Alert>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
