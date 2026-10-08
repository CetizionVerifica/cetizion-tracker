import { useState } from 'react';
import { Bookmark, Pin, PinOff, Trash2, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { useToast } from './ui.jsx';
import { useAuth } from '../lib/auth.jsx';

/**
 * The views on this list, as a row of chips above it.
 *
 * A view is the filters you have already set, given a name. That is the
 * whole feature: the work of getting to "overdue, this sector, mine" is
 * the filtering, and until now it had to be redone every morning.
 *
 * Pinning one puts it in the sidebar with its count. Sharing one puts it
 * in everybody's sidebar, which is why only an admin may.
 */

/** Same filters, same values — so the chip can show which view you are on. */
function sameAs(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (String(a[key] ?? '') !== String(b[key] ?? '')) return false;
  }
  return true;
}

export function SavedViews({ resource, filters, search, onApply, allLabel }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [pinned, setPinned] = useState(true);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, refetch } = useFetch(() => api.raw('/views'), [resource]);
  const mine = (data?.data || []).filter((view) => view.resource === resource);

  // Search is stored alongside the filters, because "the ones mentioning
  // Hindalco" is as much a view as "the overdue ones".
  const current = { ...filters, ...(search ? { q: search } : {}) };
  const active = mine.find((view) => sameAs(view.filters, current));
  const isFiltered = Object.keys(current).length > 0;

  async function save(event) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.create('views', { resource, name: name.trim(), filters: current, pinned, shared, tone: 'info' });
      toast(pinned ? `Saved. "${name.trim()}" is in the sidebar.` : 'View saved.', 'success');
      setNaming(false);
      setName('');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  // `next`, not `pinned`: the naming form already has a `pinned` state and
  // a shadowed name here would be read as that one by the next person.
  async function pin(view, next) {
    try {
      await api.update('views', view.id, { pinned: next });
      toast(next ? `"${view.name}" is in the sidebar.` : `"${view.name}" is no longer pinned.`, 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function remove(view) {
    try {
      await api.remove('views', view.id);
      toast(`Removed "${view.name}".`, 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }


  return (
    <div className="app-chiprow app-views-row" role="group" aria-label="Saved views">
      <Bookmark strokeWidth={1.8} aria-hidden="true" />

      {/* Everything: the list with no view on, so a view can be left as easily as picked. */}
      {allLabel && (
        <button type="button" className="mg-chip" aria-pressed={!isFiltered} onClick={() => onApply({})}>
          {allLabel}
        </button>
      )}

      {mine.map((view) => {
        const on = active?.id === view.id;
        return (
          <span key={view.id} className="inline-flex items-center">
            <button type="button" className="mg-chip" aria-pressed={on} onClick={() => onApply(view.filters)}>
              {view.name}
              {view.pinned && <Pin className="opacity-60" strokeWidth={2} aria-hidden="true" />}
            </button>
            {/* Yours to remove; a shared one only an admin may. */}
            {(view.owner !== null || isAdmin) && (
              <button
                type="button"
                onClick={() => remove(view)}
                aria-label={`Remove the view "${view.name}"`}
                title="Remove this view"
                className="mg-iconbtn app-view-x"
              >
                <Trash2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}

      {isFiltered && !active && !naming && (
        <button type="button" className="mg-chip is-dashed" onClick={() => setNaming(true)}>
          Save these filters
        </button>
      )}

      {/* Pinning is the point of saving, so it is offered on the view you
          are looking at rather than only at the moment you name it. */}
      {active && !naming && (
        <button type="button" className="mg-chip" onClick={() => pin(active, !active.pinned)}>
          {active.pinned ? <><PinOff strokeWidth={2} aria-hidden="true" />Unpin from sidebar</>
            : <><Pin strokeWidth={2} aria-hidden="true" />Pin to sidebar</>}
        </button>
      )}

      {!isFiltered && !mine.length && (
        <span className="text-[12px] text-muted-foreground">
          Filter this list, then save it as a view to keep it a click away.
        </span>
      )}

      {naming && (
        <form onSubmit={save} className="app-naming">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name this view"
            aria-label="Name this view"
            maxLength={80}
            className="mg-input"
          />
          <label className="mg-check text-[12.5px]">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            Pin to sidebar
          </label>
          {isAdmin && (
            <label className="mg-check text-[12.5px]">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              Everybody&rsquo;s
            </label>
          )}
          <button type="submit" disabled={busy || !name.trim()} className="mg-btn mg-btn--primary mg-btn--sm">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => { setNaming(false); setName(''); }}
            aria-label="Cancel"
            className="mg-iconbtn app-view-x"
          >
            <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        </form>
      )}
    </div>
  );
}
