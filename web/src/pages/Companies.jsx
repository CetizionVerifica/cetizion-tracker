import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from 'cn';
import { ListPage } from '../components/ListPage.jsx';
import { ChevronDown, ChevronUp, Copy, ExternalLink, Merge, TriangleAlert, X } from 'lucide-react';
import { Modal, useToast } from '../components/ui.jsx';
import { Tone } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
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
  // Spotting duplicates is everybody's; folding two clients into one is not
  // (#85). The route is requireAdmin, so this only spares a sales user a
  // button that answers 403.
  const { isAdmin } = useAuth();
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
    { key: 'name', header: 'Company', className: 'strong', render: (r) => <><Link className="font-bold text-foreground no-underline" to={`/companies/${r.id}`}>{r.name}</Link>{r.city && <span className="app-sub font-normal">{r.city}</span>}</> },
    { key: 'sector', header: 'Sector', render: (r) => r.sector || <span className="text-muted-foreground">—</span> },
    { key: 'contacts', header: 'Contacts', align: 'right' },
    { key: 'enquiries', header: 'Enquiries', align: 'right' },
    { key: 'quotations', header: 'Quotations', align: 'right', render: (r) => <>{r.quotations}<span className="text-[12px] text-muted-foreground"> · {r.won_quotations || 0} won</span></> },
    { key: 'projects', header: 'Projects', align: 'right' },
    { key: 'po_value_inr', header: 'PO value', align: 'right', className: 'strong', render: (r) => money(r.po_value_inr) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => (r.outstanding > 0 ? <Tone tone="wait">{money(r.outstanding)}</Tone> : <span className="text-muted-foreground">—</span>) },
    { key: 'last_activity', header: 'Last activity', render: (r) => (r.last_activity ? date(r.last_activity) : <span className="text-muted-foreground">—</span>) },
  ];

  const fields = [
    { name: 'name', label: 'Company name', required: true, span: 2, hint: 'Renaming here renames the client on every record' },
    { name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors, hint: 'Pick from the list, or type a new sector' },
    { name: 'city', label: 'City' },
    { name: 'gstin', label: 'GSTIN' },
    { name: 'website', label: 'Website' },
    { name: 'address', label: 'Address', type: 'textarea', span: 'all' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];

  // Possible duplicates: a glass panel over the list, or one quiet line
  // when hidden (hidden, not gone).
  const dupes = groups.length === 0 ? null : hidden ? (
    <p className="m-0 flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
      {groups.length} possible duplicate group{groups.length === 1 ? '' : 's'} hidden
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => hide(false)}>Show them</button>
    </p>
  ) : (
    <section className="mg-glass app-dupes" aria-labelledby="dupes-title" data-a="rise">
      <div className="app-dupes__head">
        <span className="app-sq app-sq--sm bg-wait-soft text-caramel-text"><Copy aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <h2 id="dupes-title" className="mg-panel__title">{groups.length} group{groups.length === 1 ? '' : 's'} may be one client spelt more than once</h2>
          <p className="mg-panel__hint m-0">Open one to choose which spellings are really the same, and which to keep.{!isAdmin && ' An admin does the merging.'}</p>
        </div>
        <button type="button" className="mg-iconbtn app-iconbtn" aria-label="Hide duplicate suggestions" title="Hide" onClick={() => hide(true)}>
          <X aria-hidden="true" />
        </button>
      </div>
      {listed.map((g) => (
        <div key={g.members[0].id} className="app-dupes__row">
          <span className="app-dupes__name">
            <Link to={`/companies/${g.members[0].id}`}>{g.members[0].name}</Link>
            <span> +{g.size - 1} more spelling{g.size - 1 === 1 ? '' : 's'}</span>
          </span>
          <span className="app-dupes__count">{g.records} record{g.records === 1 ? '' : 's'}</span>
          <Tone tone={g.certain ? 'wait' : 'plain'}>{g.confidence}</Tone>
          <button type="button" className="mg-btn mg-btn--sm" onClick={() => openGroup(g)}>Review</button>
        </div>
      ))}
      {groups.length > SHOWN && (
        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm self-start" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
          {expanded ? `Show the first ${SHOWN}` : `Show all ${groups.length}`}
        </button>
      )}
    </section>
  );

  return (
    <>
      <ListPage
        eyebrow="Records"
        title="Companies"
        noun="companies"
        subtitle="Every client once: contacts, sector and everything the tracker holds for them."
        summary={dupes}
        resource="companies"
        columns={columns}
        fields={fields}
        newLabel="Company"
        formTitle="company"
        searchPlaceholder="Search company, sector, city, GSTIN"
        quick={['sector', 'contacts']}
        phone={(r) => ({
          title: r.name,
          amount: money(r.po_value_inr),
          meta: <>{[r.sector, r.city].filter(Boolean).join(' · ') || 'No sector yet'} · {r.contacts} contact{r.contacts === 1 ? '' : 's'} · {r.quotations} quotation{r.quotations === 1 ? '' : 's'}{r.last_activity && <> · {date(r.last_activity)}</>}</>,
          state: r.outstanding > 0 ? <Tone tone="wait">{money(r.outstanding)} owed</Tone> : null,
          to: `/companies/${r.id}`,
        })}
        deleteTitle={(r) => `Delete ${r.name}?`}
        deleteText={(r) => `${r.name} and its contacts leave the tracker. Records that name it keep the name. This cannot be undone.`}
        onRowClick={(row) => navigate(`/companies/${row.id}`)}
        refreshToken={refresh}
        onSaved={() => { invalidateLookups(); setRefresh((n) => n + 1); }}
        filters={[
          { name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sectors] },
          { name: 'contacts', label: 'Contacts', options: [{ value: '0', label: 'None yet' }] },
        ]}
      />
      {review && (
        <Modal
          size="lg"
          title={review.certain ? 'The same name, spelt differently' : 'Which of these are the same client?'}
          subtitle={!isAdmin
            ? 'You can see the spellings and what each holds. Merging them is an admin’s job.'
            : review.certain
              ? 'These differ only by punctuation, so there is nothing to weigh up.'
              : 'These share a brand. That does not make them one company: a plant, a unit or a subsidiary is its own client. Tick only the ones that are genuinely the same.'}
          onClose={() => setReview(null)}
          footer={(
            <>
              <p className="mr-auto text-[12.5px] text-muted-foreground max-sm:w-full">
                {!isAdmin
                  ? `${review.size} spellings · ${review.records} records`
                  : losing.length
                    ? `${losing.length} of ${review.size} fold in · ${losing.reduce((n, m) => n + m.records, 0)} record${losing.reduce((n, m) => n + m.records, 0) === 1 ? '' : 's'} move`
                    : 'Nothing ticked yet'}
              </p>
              <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setReview(null)}>{isAdmin ? 'Cancel' : 'Close'}</button>
              {/* Spotting duplicates is everybody's; folding two clients into one
                  is not (#85). POST /companies/:id/merge is requireAdmin, so this
                  only spares a sales user a button that answers 403. The list and
                  this review stay open — seeing the duplicates is ordinary work. */}
              {isAdmin && (
                <button type="button" className="mg-btn mg-btn--danger" disabled={busy || !losing.length} onClick={merge}>
                  <Merge className="size-4" aria-hidden="true" />
                  {busy ? 'Merging…' : losing.length ? `Merge into ${keep?.name}` : 'Merge'}
                </button>
              )}
            </>
          )}
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {review.members.map((m) => {
              const keeping = m.id === keepId;
              const ticked = chosen.has(m.id);
              const facts = [m.sector, `${m.records} record${m.records === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
              return (
                <li key={m.id} className={cn('app-member', keeping && 'is-keep', ticked && !keeping && 'is-ticked')}>
                  {keeping ? (
                    <>
                      <Tone tone="ok">Keeping</Tone>
                      <span className="app-member__text"><b>{m.name}</b><span>{facts}</span></span>
                    </>
                  ) : isAdmin ? (
                    // The whole label is the hit target, not the 20px box.
                    <label className="mg-check app-member__text" style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={ticked}
                        onChange={() => toggle(m.id)}
                        aria-label={`Fold ${m.name} into ${keep?.name ?? 'the one kept'}`}
                      />
                      <span className="flex min-w-0 flex-col"><b>{m.name}</b><span className="text-[12px] text-muted-foreground">{facts}</span></span>
                    </label>
                  ) : (
                    <span className="app-member__text"><b>{m.name}</b><span>{facts}</span></span>
                  )}
                  <a href={`/companies/${m.id}`} target="_blank" rel="noopener noreferrer" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Open ${m.name} in a new tab`}>
                    Open<ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                  {!keeping && isAdmin && (
                    <button
                      type="button"
                      className="mg-btn mg-btn--sm"
                      onClick={() => { setKeepId(m.id); setChosen((prev) => { const n = new Set(prev); n.delete(m.id); return n; }); }}
                    >
                      Keep this one
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          {isAdmin && losing.length > 0 && (
            <div className="mg-banner mg-banner--late mt-4" role="note">
              <TriangleAlert aria-hidden="true" />
              <div className="mg-banner__body">
                Every enquiry, quotation, project and contact under{' '}
                <b>{losing.map((m) => m.name).join(', ')}</b> moves to{' '}
                <b>{keep?.name}</b> and takes that name.{' '}
                {losing.length === 1 ? 'That company is' : 'Those companies are'} then deleted. This cannot be undone.
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
