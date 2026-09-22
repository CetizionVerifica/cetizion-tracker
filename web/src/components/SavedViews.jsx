import { useState } from 'react';
import { Bookmark, Check, Pin, Trash2, X } from 'lucide-react';
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

const CHIP = 'inline-flex h-7 shrink-0 items-center gap-2 rounded-[6px] border px-2.5 text-[12.5px] ' +
  'transition-colors duration-150';

/** Same filters, same values — so the chip can show which view you are on. */
function sameAs(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (String(a[key] ?? '') !== String(b[key] ?? '')) return false;
  }
  return true;
}

export function SavedViews({ resource, filters, search, onApply }) {
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

  async function remove(view) {
    try {
      await api.remove('views', view.id);
      toast(`Removed "${view.name}".`, 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  if (!mine.length && !isFiltered) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
      <Bookmark className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />

      {mine.map((view) => {
        const on = active?.id === view.id;
        return (
          <span key={view.id} className="group/chip inline-flex">
            <button
              type="button"
              onClick={() => onApply(view.filters)}
              className={`${CHIP} ${on
                ? 'border-primary/40 bg-primary/12 font-semibold text-primary'
                : 'border-border bg-secondary text-secondary-text hover:border-muted-foreground hover:text-foreground'}`}
              aria-pressed={on}
            >
              {on && <Check className="size-3" strokeWidth={2.4} aria-hidden="true" />}
              {view.name}
              {view.pinned && <Pin className="size-3 opacity-60" strokeWidth={2} aria-hidden="true" />}
            </button>
            {/* Yours to remove; a shared one only an admin may. */}
            {(view.owner !== null || isAdmin) && (
              <button
                type="button"
                onClick={() => remove(view)}
                aria-label={`Remove the view "${view.name}"`}
                className="ml-0.5 hidden size-7 place-items-center rounded-[6px] text-muted-foreground hover:text-late group-hover/chip:grid"
              >
                <Trash2 className="size-3" strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}

      {isFiltered && !active && !naming && (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className={`${CHIP} border-dashed border-border text-secondary-text hover:border-primary hover:text-primary`}
        >
          Save these filters
        </button>
      )}

      {naming && (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name this view"
            maxLength={80}
            className="h-7 w-48 rounded-[6px] border border-input bg-muted px-2.5 text-[12.5px] text-foreground placeholder:text-muted-foreground"
          />
          <label className="inline-flex items-center gap-1.5 text-[12px] text-secondary-text">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            Pin to sidebar
          </label>
          {isAdmin && (
            <label className="inline-flex items-center gap-1.5 text-[12px] text-secondary-text">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              Everybody&rsquo;s
            </label>
          )}
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex h-7 items-center rounded-[6px] border border-primary bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => { setNaming(false); setName(''); }}
            aria-label="Cancel"
            className="grid size-7 place-items-center rounded-[6px] text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        </form>
      )}
    </div>
  );
}
