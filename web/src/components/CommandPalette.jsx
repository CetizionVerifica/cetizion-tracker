import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Building2, CheckCircle2, ChevronRight, CircleAlert, Clock, CreditCard, FileText,
  FolderKanban, Home, Inbox, Plane, Receipt, Search,
} from 'lucide-react';
import { cn } from 'cn';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { api } from '../lib/api.js';
import { bodyFor, commandsFor, initialValues, missingFields } from '../lib/commands.js';
import { useToast } from './ui.jsx';

/**
 * Ctrl K — verbs above records.
 *
 * Type what you want to happen, and the thing you want is either a step you
 * can complete here or a record you can open. A step runs in the palette:
 * the page underneath never changes, so recording a payment while reading a
 * project does not cost you the project.
 *
 * Drawn as the Wave 1 canvas draws it (Mocha Glass): a strong-glass sheet
 * dropping from the top, groups in small caps, 44px rows, and a step as
 * "1 of 2, pick the record" then "2 of 2, the form". On a phone it fills
 * the width from the top, so the keyboard never covers the results.
 */

const ICONS = {
  today: Home, search: Search, inbox: Inbox, company: Building2, deal: FileText,
  project: FolderKanban, order: Receipt, money: CreditCard, trip: Plane,
  done: CheckCircle2, waiting: Clock,
};

const Icon = ({ name, className }) => {
  const Glyph = ICONS[name] || FileText;
  return <Glyph className={className} strokeWidth={1.8} aria-hidden="true" />;
};

/** The sections a search result can fall into, in reading order. */
const GROUP_ORDER = ['deal', 'enquiry', 'company', 'contact', 'project', 'order', 'stage', 'trip'];

const PLURAL = {
  deal: 'Deals', enquiry: 'Enquiries', company: 'Companies', contact: 'Contacts',
  project: 'Projects', order: 'Purchase orders', stage: 'Payment stages', trip: 'Trips',
};

const ROW = 'mg-palette__item group';

/**
 * Match on the words somebody typed, not on a fuzzy subsequence.
 *
 * cmdk scores by subsequence, which is generous enough that "hind" — a
 * client's name — scores a hit on "Log a c**h**ase on an overdue **in**voice
 * an**d**…". The bar here is a real substring, or every typed word starting
 * a word in the entry.
 */
function matches(value, search) {
  const haystack = value.toLowerCase();
  const needle = search.trim().toLowerCase();
  if (!needle) return 1;
  if (haystack.includes(needle)) return 1;
  const words = haystack.split(/\s+/);
  const every = needle.split(/\s+/).every((word) => words.some((w) => w.startsWith(word)));
  return every ? 0.5 : 0;
}

/**
 * The group heading, styled through cmdk's own hook. Every utility carries
 * the variant prefix itself (a single interpolated prefix only reaches the
 * first token).
 */
const GROUP = [
  '[&_[cmdk-group-heading]]:px-3',
  '[&_[cmdk-group-heading]]:pt-2.5',
  '[&_[cmdk-group-heading]]:pb-1.5',
  '[&_[cmdk-group-heading]]:text-[11px]',
  '[&_[cmdk-group-heading]]:font-bold',
  '[&_[cmdk-group-heading]]:uppercase',
  '[&_[cmdk-group-heading]]:tracking-[0.1em]',
  '[&_[cmdk-group-heading]]:text-secondary-text',
].join(' ');

/** A short word for what a record is waiting on, where the row carries one. */
function StateChip({ state }) {
  if (!state) return null;
  const late = /overdue|lost|rejected/i.test(state);
  const waiting = /to invoice|pending|submitted|negotiation|hold/i.test(state);
  return <span className={cn('mg-badge ml-auto shrink-0', late && 'mg-badge--late', waiting && 'mg-badge--wait')}>{state}</span>;
}

/** Back, what this is, and where you are in the step. */
function StepHead({ onBack, title, sub, where }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-4 pt-3.5 pb-2.5">
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm shrink-0" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />Back
      </button>
      <div className="min-w-0">
        <strong className="block truncate">{title}</strong>
        {sub && <div className="truncate text-[12.5px] text-muted-foreground">{sub}</div>}
      </div>
      {where && <span className="ml-auto shrink-0 text-[12.5px] text-muted-foreground">{where}</span>}
    </div>
  );
}

/** A line inside the list that is not something to choose: searching, failed, loading. */
function Note({ tone, children, role = 'status' }) {
  return (
    <div role={role} className={cn('flex items-center gap-2.5 px-3 py-3 text-[13px]', tone === 'late' ? 'text-late' : 'text-muted-foreground')}>
      {children}
    </div>
  );
}

/** The form a step turns into once it has its record. */
function StepForm({ step, record, values, setValues, error, busy, onRun, onBack }) {
  const firstField = useRef(null);
  useEffect(() => { firstField.current?.focus(); }, []);

  const set = (name) => (value) => setValues({ ...values, [name]: value });

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); onRun(); }}>
      <StepHead
        onBack={onBack}
        title={record ? <span className="mg-num">{record.title}</span> : step.verb}
        sub={record ? record.subtitle : step.hint}
        where={step.picks ? 'Step 2 of 2' : null}
      />

      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        <div className="grid gap-3.5 sm:grid-cols-2">
          {step.fields.map((field, index) => (
            <div key={field.name} className={cn('flex min-w-0 flex-col gap-1.5', field.type === 'textarea' && 'sm:col-span-2')}>
              <Label htmlFor={`step-${field.name}`}>
                {field.label}{field.required && <span className="ml-0.5 text-late">*</span>}
              </Label>

              {field.type === 'select' ? (
                <Select value={values[field.name] ?? ''} onValueChange={set(field.name)}>
                  <SelectTrigger id={`step-${field.name}`} ref={index === 0 ? firstField : undefined} className="w-full">
                    <SelectValue placeholder={`Choose ${field.label.toLowerCase()}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === 'textarea' ? (
                <Textarea
                  id={`step-${field.name}`}
                  ref={index === 0 ? firstField : undefined}
                  className="min-h-[88px]"
                  maxLength={field.maxLength}
                  value={values[field.name] ?? ''}
                  onChange={(e) => set(field.name)(e.target.value)}
                />
              ) : (
                <Input
                  id={`step-${field.name}`}
                  ref={index === 0 ? firstField : undefined}
                  type={field.type}
                  min={field.min}
                  step={field.step}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder}
                  value={values[field.name] ?? ''}
                  onChange={(e) => set(field.name)(e.target.value)}
                />
              )}

              {field.hint && <span className="text-[12px] text-muted-foreground">{field.hint}</span>}
            </div>
          ))}
        </div>

        {error && (
          <div className="mg-banner mg-banner--late" role="alert">
            <CircleAlert strokeWidth={1.8} aria-hidden="true" />
            <div className="mg-banner__body">{error}</div>
          </div>
        )}
      </div>

      <div className="mg-palette__foot items-center !py-3">
        <span className="hidden min-w-0 truncate sm:inline">{step.hint}</span>
        <button type="submit" disabled={busy} className="mg-btn mg-btn--primary ml-auto shrink-0">
          {busy ? 'Working…' : step.verb}
          <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

const PALETTE = [
  'mg-palette top-20 translate-y-0 flex flex-col gap-0 overflow-hidden rounded-[28px] p-0',
  'w-[640px] max-w-[calc(100%-2rem)] sm:max-w-[640px] max-h-[min(620px,calc(100dvh-7rem))]',
  'data-[state=open]:animate-[mg-drop-in_500ms_var(--mg-spring)_both] [&>.mg-sheet__grab]:hidden',
  // A phone: full width from the top, so the keyboard sits under the results, not over them.
  'max-[719px]:top-2 max-[719px]:bottom-auto max-[719px]:left-2 max-[719px]:right-2 max-[719px]:w-auto max-[719px]:max-w-none',
  'max-[719px]:max-h-[calc(100dvh-1rem)] max-[719px]:rounded-[24px] max-[719px]:border-b max-[719px]:pb-0',
  'max-[719px]:data-[state=open]:animate-[mg-drop-in_500ms_var(--mg-spring)_both]',
].join(' ');

export function CommandPalette({ open, onOpenChange, start, isAdmin, isHr, mode }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [searching, setSearching] = useState('idle'); // idle | loading | error
  const [searchTick, setSearchTick] = useState(0);
  const [step, setStep] = useState(null);
  const [record, setRecord] = useState(null);
  const [choices, setChoices] = useState([]);
  const [listing, setListing] = useState('idle'); // idle | loading | error
  const [values, setValues] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { steps, jumps } = useMemo(() => commandsFor({ isAdmin, mode }), [isAdmin, mode]);

  const reset = useCallback(() => {
    setQ(''); setFound([]); setSearching('idle'); setStep(null); setRecord(null);
    setChoices([]); setListing('idle'); setValues({}); setError(''); setBusy(false);
  }, []);

  useEffect(() => { if (!open) reset(); }, [open, reset]);

  // Search runs a beat behind the typing, so a fast typist makes one
  // request rather than one per keystroke. The travel desk's search is
  // refused by the server, so it is not asked.
  useEffect(() => {
    if (step || isHr || q.trim().length < 2) { setFound([]); setSearching('idle'); return undefined; }
    let live = true;
    setSearching('loading');
    const timer = setTimeout(() => {
      api.raw(`/search?q=${encodeURIComponent(q.trim())}`)
        .then((res) => { if (live) { setFound(res.data || []); setSearching('idle'); } })
        .catch(() => { if (live) { setFound([]); setSearching('error'); } });
    }, 160);
    return () => { live = false; clearTimeout(timer); };
  }, [q, step, isHr, searchTick]);

  const close = () => onOpenChange(false);

  /** A step with no record to pick goes straight to its form. */
  const beginStep = useCallback(async (chosen) => {
    setStep(chosen);
    setRecord(null);
    setValues(initialValues(chosen));
    setError('');
    setQ('');
    if (!chosen.picks) return;
    setChoices([]);
    setListing('loading');
    try {
      const res = await api.list(chosen.picks.resource, { ...chosen.picks.params, limit: 40 });
      setChoices((res.data || []).map((row) => ({
        ...row,
        title: String(row[chosen.key || 'invoice_no'] ?? row.stage_name ?? row.claim_id ?? row.vendor_invoice_no ?? row.id),
        subtitle: [row.client_name, row.po_number, row.employee_name, row.service_quoted]
          .filter(Boolean).slice(0, 2).join(' · '),
      })));
      setListing('idle');
    } catch {
      setChoices([]);
      setListing('error');
    }
  }, []);

  // Opened from the dock, the New sheet or the More sheet's search: start
  // on that step, or with that text already typed.
  useEffect(() => {
    if (!open || !start) return;
    if (start.step) {
      const chosen = steps.find((s) => s.id === start.step);
      if (chosen) beginStep(chosen);
    } else if (start.q) {
      setQ(start.q);
    }
  }, [open, start, steps, beginStep]);

  const run = async () => {
    const missing = missingFields(step, values);
    if (missing.length) { setError(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} needed.`); return; }
    setBusy(true);
    setError('');
    try {
      await api.action(step.endpoint(record || {}), bodyFor(step, record || {}, values));
      toast(step.done, 'success');
      close();
    } catch (err) {
      setError(err.message || 'That did not go through.');
      setBusy(false);
    }
  };

  const grouped = useMemo(() => {
    const byType = new Map();
    for (const hit of found) {
      if (!byType.has(hit.type)) byType.set(hit.type, []);
      byType.get(hit.type).push(hit);
    }
    return GROUP_ORDER.filter((type) => byType.has(type)).map((type) => [type, byType.get(type)]);
  }, [found]);

  const picking = step?.picks && !record;
  const backToSteps = () => { setStep(null); setRecord(null); setChoices([]); setListing('idle'); setError(''); setQ(''); };
  const term = q.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className={PALETTE}>
        <DialogTitle className="sr-only">Search or do anything</DialogTitle>
        <DialogDescription className="sr-only">
          Type what you want to happen, or the name of a record to open.
        </DialogDescription>

        {step && !picking ? (
          <StepForm
            step={step} record={record} values={values} setValues={setValues}
            error={error} busy={busy} onRun={run}
            onBack={() => (step.picks ? (setRecord(null), setError('')) : backToSteps())}
          />
        ) : (
          <Command filter={matches} loop className="flex min-h-0 flex-1 flex-col">
            {picking && <StepHead onBack={backToSteps} title={step.verb} where="Step 1 of 2" />}
            <div className="mg-palette__search shrink-0">
              <Search size={18} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-muted-foreground" />
              <Command.Input
                autoFocus
                value={q}
                onValueChange={setQ}
                placeholder={picking ? step.picks.label : 'Search or do anything'}
                className="outline-none focus:outline-none focus-visible:outline-none"
              />
              <button type="button" className="mg-kbd h-[26px] cursor-pointer px-2" aria-label="Close" onClick={close}>Esc</button>
            </div>

            <Command.List className="mg-palette__list min-h-0 flex-1 max-[719px]:max-h-none">
              <Command.Empty>
                {picking
                  ? listing === 'idle' && (
                    <div className="mg-empty" style={{ padding: 24 }}>
                      <p className="mg-empty__text">
                        {term ? `Nothing in this list matches “${term}”.` : 'Nothing is waiting here.'}
                      </p>
                    </div>
                  )
                  : searching === 'idle' && (
                    <div className="mg-empty" style={{ padding: 24 }}>
                      <p className="mg-empty__text">No step, page or record matches “{term}”.</p>
                    </div>
                  )}
              </Command.Empty>

              {picking ? (
                <>
                  {listing === 'loading' && (
                    <div className="flex flex-col gap-1.5 px-1 py-1" aria-busy="true" aria-label="Loading the list">
                      {[0, 1, 2, 3].map((i) => <span key={i} className="mg-skel" style={{ height: 44, borderRadius: 14 }} />)}
                    </div>
                  )}
                  {listing === 'error' && (
                    <div className="mg-banner mg-banner--late m-1" role="alert">
                      <CircleAlert strokeWidth={1.8} aria-hidden="true" />
                      <div className="mg-banner__body">
                        <strong>Couldn&rsquo;t load the list to pick from</strong>
                        <button type="button" className="mg-btn mg-btn--sm mt-2" onClick={() => beginStep(step)}>Try again</button>
                      </div>
                    </div>
                  )}
                  {choices.length > 0 && (
                    <Command.Group heading={step.picks.label} className={GROUP}>
                      {choices.map((choice) => (
                        <Command.Item
                          key={choice.id}
                          value={`${choice.title} ${choice.subtitle}`}
                          onSelect={() => setRecord(choice)}
                          className={ROW}
                        >
                          <Icon name={step.icon} />
                          <span className="min-w-0 flex-1 truncate">
                            <strong className="mg-num">{choice.title}</strong>
                            {choice.subtitle && <span className="text-muted-foreground"> · {choice.subtitle}</span>}
                          </span>
                          <ChevronRight size={16} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                </>
              ) : (
                <>
                  <Command.Group heading="Do" className={GROUP}>
                    {steps.map((entry) => (
                      <Command.Item
                        key={entry.id}
                        value={`${entry.verb} ${entry.keywords}`}
                        onSelect={() => beginStep(entry)}
                        className={ROW}
                      >
                        <Icon name={entry.icon} className="!text-caramel-text" />
                        <span className="min-w-0 flex-1 truncate">
                          <strong>{entry.verb}</strong>
                          <span className="text-muted-foreground"> · {entry.hint}</span>
                        </span>
                        <span className="mg-kbd opacity-0 group-data-[selected=true]:opacity-100" aria-hidden="true">↵</span>
                      </Command.Item>
                    ))}
                  </Command.Group>

                  <Command.Group heading="Go to" className={GROUP}>
                    {jumps.map((entry) => (
                      <Command.Item
                        key={entry.id}
                        value={`${entry.verb} ${entry.keywords}`}
                        onSelect={() => { navigate(entry.to); close(); }}
                        className={ROW}
                      >
                        <Icon name={entry.icon} />
                        <span className="min-w-0 flex-1 truncate">{entry.verb}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>

                  {grouped.map(([type, hits]) => (
                    <Command.Group key={type} heading={`${PLURAL[type]} matching “${term}”`} className={GROUP}>
                      {hits.map((hit) => (
                        <Command.Item
                          key={`${hit.type}-${hit.id}`}
                          value={`${hit.title} ${hit.subtitle} ${q}`}
                          onSelect={() => { navigate(hit.href); close(); }}
                          className={ROW}
                        >
                          <Icon name={hit.icon} />
                          <span className="min-w-0 flex-1 truncate">
                            <strong className="mg-num">{hit.title}</strong>
                            {hit.subtitle && <span className="text-muted-foreground"> · {hit.subtitle}</span>}
                          </span>
                          <StateChip state={hit.state} />
                        </Command.Item>
                      ))}
                    </Command.Group>
                  ))}

                  {searching === 'loading' && (
                    <Note><span className="app-spin" aria-hidden="true" />Searching the records…</Note>
                  )}
                  {searching === 'error' && (
                    <Note tone="late" role="alert">
                      <CircleAlert size={16} strokeWidth={1.8} aria-hidden="true" />
                      Couldn&rsquo;t search the records. Steps and pages still work.
                      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm ml-auto" onClick={() => setSearchTick((n) => n + 1)}>Try again</button>
                    </Note>
                  )}
                </>
              )}
            </Command.List>

            <div className="mg-palette__foot shrink-0">
              <span className="hidden sm:inline"><kbd className="mg-kbd">↑</kbd> <kbd className="mg-kbd">↓</kbd> move</span>
              <span className="hidden sm:inline"><kbd className="mg-kbd">↵</kbd> {picking ? 'choose' : 'run'}</span>
              <span><kbd className="mg-kbd">Esc</kbd> close</span>
              {!picking && <span className="hidden sm:inline"><kbd className="mg-kbd">/</kbd> opens this too</span>}
              <span className="ml-auto hidden md:inline">{picking ? 'Then fill in the step.' : 'Steps run here. The page stays as it is.'}</span>
            </div>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ctrl K (⌘K) anywhere, and / when you are not already typing into
 * something. `openWith` opens it on a step or with text already typed.
 */
export function useCommandPalette() {
  const [open, setOpenState] = useState(false);
  const [start, setStart] = useState(null);
  useEffect(() => {
    const onKey = (event) => {
      const typing = /^(input|textarea|select)$/i.test(event.target?.tagName) || event.target?.isContentEditable;
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setStart(null);
        setOpenState((was) => !was);
      } else if (event.key === '/' && !typing) {
        event.preventDefault();
        setStart(null);
        setOpenState(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const setOpen = useCallback((value) => {
    setOpenState(value);
    if (!value) setStart(null);
  }, []);
  const openWith = useCallback((opts = {}) => {
    setStart(opts.step || opts.q ? { ...opts } : null);
    setOpenState(true);
  }, []);
  return { open, setOpen, start, openWith };
}
