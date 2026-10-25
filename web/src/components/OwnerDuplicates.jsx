import { useState } from 'react';
import { cn } from 'cn';
import { ChevronDown, ChevronUp, Merge, X } from 'lucide-react';
import { Alert, Badge, Field, Modal, Select, useToast } from './ui.jsx';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox.tsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';

/** Where this browser remembers that the owner duplicates banner was dismissed. */
const DUPES_HIDDEN = 'cetizion.owners.duplicates';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 enquiries · 1 deal · 2 projects", or "No records yet" for a bare account name. */
function describe(m) {
  const parts = [
    m.enquiries && `${m.enquiries} enquir${m.enquiries === 1 ? 'y' : 'ies'}`,
    m.quotations && plural(m.quotations, 'deal'),
    m.projects && plural(m.projects, 'project'),
  ].filter(Boolean);
  return [m.sales_user && 'Sales user', parts.length ? parts.join(' · ') : 'No records yet'].filter(Boolean).join(' · ');
}

/**
 * Owners written more than once, and folding them into one: the Companies
 * duplicates banner (#20), for the free-text Owner on enquiries, deals and
 * projects. Admins only: the groups count records across the whole book,
 * and both routes are requireAdmin.
 *
 * @param onMerged  called after a merge, so the page around it can reload
 */
export function OwnerDuplicates({ onMerged }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return null;
  return <OwnerDuplicatesBanner onMerged={onMerged} />;
}

function OwnerDuplicatesBanner({ onMerged }) {
  const toast = useToast();
  // Who a group may be merged into: a sales user on the platform, never
  // another free-text spelling (the server refuses anything else).
  const owners = (useLookups().owners ?? []).map((o) => o.name);
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState(null);   // the group being looked at
  const [keepName, setKeepName] = useState(null); // the spelling that survives
  const [chosen, setChosen] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(DUPES_HIDDEN) === 'hidden'; } catch { return false; }
  });
  const hide = (value) => {
    setHidden(value);
    setExpanded(false);
    try { localStorage.setItem(DUPES_HIDDEN, value ? 'hidden' : 'shown'); } catch { /* not this browser's to remember */ }
  };
  const dups = useFetch(() => api.raw('/owners/duplicates'), [refresh]);
  const groups = dups.data?.data ?? [];
  const SHOWN = 8;
  const listed = expanded ? groups : groups.slice(0, SHOWN);

  /**
   * A same-name group has nothing to weigh up, so everything starts ticked;
   * a shares-a-name group starts with nothing ticked, because "Ravi Kumar"
   * and "Ravi Shankar" may be two people.
   */
  function openGroup(group) {
    setReview(group);
    setKeepName(group.suggested_keep);
    setChosen(new Set(group.certain ? group.members.map((m) => m.name) : []));
  }

  const toggle = (name) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const losing = review && keepName ? review.members.filter((m) => m.name !== keepName && chosen.has(m.name)) : [];
  const moving = losing.reduce((n, m) => n + m.records, 0);

  /** Pick the user to keep; their own spelling cannot also be merged away. */
  function chooseKeep(name) {
    setKeepName(name || null);
    setChosen((prev) => { const n = new Set(prev); n.delete(name); return n; });
  }

  /** One request, one transaction: every ticked spelling becomes the kept one. */
  async function merge() {
    if (!losing.length) return;
    setBusy(true);
    try {
      const { data } = await api.action('/owners/merge', { from: losing.map((m) => m.name), into: keepName });
      const owned = data?.owner_assigned ?? 0;
      toast(`${plural(losing.length, 'spelling')} merged into ${keepName}${owned ? `. ${plural(owned, 'record')} now owned by them.` : ''}`, 'success');
      invalidateLookups();
      setReview(null);
      setRefresh((n) => n + 1);
      onMerged?.();
    } catch (err) {
      toast(`${err.message}. Nothing was changed.`, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (!groups.length) return null;

  return (
    <>
      {hidden ? (
        // Hidden, not gone, as on Companies.
        <div className="mb-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span>{plural(groups.length, 'owner')} possibly written more than once</span>
          <Button variant="link" size="xs" className="h-auto p-0" onClick={() => hide(false)}>Show</Button>
        </div>
      ) : (
        <Alert tone="warning">
          <div className="w-full">
            <div className="flex items-start gap-3">
              <p className="measure flex-1">
                <strong>{groups.length} group{groups.length === 1 ? '' : 's'} of owners may be one person written more than once.</strong>{' '}
                Open one to choose which names are really the same person, and which to keep.
              </p>
              <Button
                variant="ghost"
                size="icon-xs"
                className="-mr-1 -mt-0.5 shrink-0 text-current/70 hover:text-current"
                aria-label="Hide owner duplicate suggestions"
                onClick={() => hide(true)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>

            <ul className="mt-2.5 divide-y divide-current/10 border-t border-current/10">
              {listed.map((g) => (
                <li key={g.members[0].name} className="flex items-center gap-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">
                    <span className="font-medium">{g.members[0].name}</span>
                    <span className="text-current/70"> +{g.size - 1} more</span>
                  </span>
                  <span className="hidden shrink-0 tabular-nums text-[12px] text-current/70 sm:inline">
                    {plural(g.records, 'record')}
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
      )}

      {review && (
        <Modal
          size="lg"
          title={review.certain ? 'The same owner, written differently' : 'Which of these are the same person?'}
          subtitle={review.certain
            ? 'These differ only by case, spacing or punctuation, so there is nothing to weigh up.'
            : 'These share a name. That does not make them one person — two colleagues can share a first name. Tick only the ones that are genuinely the same.'}
          onClose={() => setReview(null)}
          footer={(
            <div className="flex w-full items-center justify-between gap-3">
              <p className="text-[12px] text-muted-foreground">
                {!keepName
                  ? 'Pick the user to merge into'
                  : losing.length
                    ? `${losing.length} of ${review.size} merge in · ${plural(moving, 'record')} change owner name`
                    : 'Nothing ticked yet'}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setReview(null)}>Cancel</Button>
                <Button variant="destructive" disabled={busy || !keepName || !losing.length} onClick={merge}>
                  <Merge aria-hidden="true" />
                  {busy ? 'Merging…' : losing.length ? `Merge into ${keepName}` : 'Merge'}
                </Button>
              </div>
            </div>
          )}
        >
          <div className="mb-3 max-w-sm">
            <Field label="Merge into" hint="A sales user on the platform. Add people in Settings → Users.">
              <Select
                value={keepName ?? ''}
                placeholder="Select a user…"
                options={owners}
                onChange={(e) => chooseKeep(e.target.value)}
              />
            </Field>
          </div>
          <ul className="space-y-1.5">
            {review.members.map((m) => {
              const keeping = m.name === keepName;
              const ticked = chosen.has(m.name);
              return (
                <li
                  key={m.name}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                    keeping
                      ? 'border-l-[3px] border-primary/40 border-l-primary bg-primary/5'
                      : ticked
                        ? 'border-late/40 bg-late/5'
                        : 'border-border hover:border-muted-foreground/40 hover:bg-accent/40'
                  )}
                >
                  {keeping ? (
                    <>
                      <Badge tone="success" className="shrink-0">Keeping</Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold">{m.name}</span>
                        <span className="block text-[12px] text-muted-foreground">{describe(m)}</span>
                      </span>
                    </>
                  ) : (
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                      <Checkbox
                        className="size-[18px] border-muted-foreground/60"
                        checked={ticked}
                        onCheckedChange={() => toggle(m.name)}
                        aria-label={`Merge ${m.name} into ${keepName ?? 'the user kept'}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{m.name}</span>
                        <span className="block text-[12px] text-muted-foreground">{describe(m)}</span>
                      </span>
                    </label>
                  )}

                  {!keeping && m.sales_user && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0"
                      onClick={() => chooseKeep(m.name)}
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
                  Every enquiry, deal and project with the owner{' '}
                  <strong>{losing.map((m) => m.name).join(', ')}</strong> is renamed to{' '}
                  <strong>{keepName}</strong>.{' '}
                  Records nobody owns yet become {keepName}&apos;s, so they appear on their lists. Records someone already owns stay theirs.{' '}
                  This cannot be undone.
                </span>
              </Alert>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
