import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import {
  Building2, CheckCircle2, ChevronRight, Clock, CreditCard, FileText,
  FolderKanban, Home, Inbox, Plane, Receipt, Search, X,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { api } from '../lib/api.js';
import { bodyFor, commandsFor, initialValues, missingFields } from '../lib/commands.js';
import { useToast } from './ui.jsx';

/**
 * ⌘K — verbs above records.
 *
 * The sidebar used to list thirty screens, which is a poor way to find
 * anything and a worse way to find out how to *do* anything. This is the
 * replacement: type what you want to happen, and the thing you want is
 * either a step you can complete here or a record you can open.
 *
 * A step runs in the palette. The page underneath never changes, so
 * recording a payment while reading a project does not cost you the
 * project — which is the whole reason this exists rather than being a
 * tidier set of links.
 */

const ICONS = {
  today: Home, search: Search, inbox: Inbox, company: Building2, deal: FileText,
  project: FolderKanban, order: Receipt, money: CreditCard, trip: Plane,
  done: CheckCircle2, waiting: Clock,
};

const Icon = ({ name, className }) => {
  const Glyph = ICONS[name] || FileText;
  return <Glyph className={className} strokeWidth={1.75} aria-hidden="true" />;
};

/** The three sections a search result can fall into, in reading order. */
const GROUP_ORDER = ['deal', 'enquiry', 'company', 'contact', 'project', 'order', 'stage', 'trip'];

const PLURAL = {
  deal: 'Deals', enquiry: 'Enquiries', company: 'Companies', contact: 'Contacts',
  project: 'Projects', order: 'Purchase orders', stage: 'Payment stages', trip: 'Trips',
};

const ROW = 'group flex h-11 cursor-pointer items-center gap-3 rounded-[6px] border border-transparent px-3 text-[14px] ' +
  'data-[selected=true]:border-primary/30 data-[selected=true]:bg-primary/12';

/**
 * Match on the words somebody typed, not on a fuzzy subsequence.
 *
 * cmdk scores by subsequence, which is generous enough that "hind" — a
 * client's name — scores a hit on "Log a c**h**ase on an overdue **in**voice
 * an**d**…". A verb offered against a query that is plainly a record is
 * noise in the one place the design puts first, so the bar here is a real
 * substring, or every typed word starting a word in the entry.
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
 * The group heading, styled through cmdk's own hook.
 *
 * Every utility carries the variant prefix itself. Building this by
 * interpolating a plain class list into one `[&_…]:` prefix looks the same
 * and is not: only the first token gets the prefix and the rest land on
 * the group, which is how `uppercase` ended up on every row in it.
 */
const GROUP = [
  '[&_[cmdk-group-heading]]:px-3',
  '[&_[cmdk-group-heading]]:pt-4',
  '[&_[cmdk-group-heading]]:pb-1.5',
  '[&_[cmdk-group-heading]]:text-[10.5px]',
  '[&_[cmdk-group-heading]]:font-semibold',
  '[&_[cmdk-group-heading]]:uppercase',
  '[&_[cmdk-group-heading]]:tracking-[0.1em]',
  '[&_[cmdk-group-heading]]:text-muted-foreground',
].join(' ');

/** A short word for what a record is waiting on, where the row carries one. */
function StateChip({ state }) {
  if (!state) return null;
  const late = /overdue|lost|rejected/i.test(state);
  const waiting = /to invoice|pending|submitted|negotiation|hold/i.test(state);
  const tone = late ? 'border-late/30 bg-late/10 text-late'
    : waiting ? 'border-waiting/30 bg-waiting/10 text-waiting'
    : 'border-border bg-secondary text-secondary-text';
  return (
    <span className={`inline-flex h-[22px] shrink-0 items-center rounded-[6px] border px-2.5 text-[11.5px] font-semibold ${tone}`}>
      {state}
    </span>
  );
}

/** The form a step turns into once it has its record. */
function StepForm({ step, record, values, setValues, error, busy, onRun, onBack }) {
  const firstField = useRef(null);
  useEffect(() => { firstField.current?.focus(); }, []);

  const set = (name) => (value) => setValues({ ...values, [name]: value });

  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(event) => { event.preventDefault(); onRun(); }}
    >
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} className="h-6 gap-1 px-1.5 text-[12.5px]">
          <X className="size-3.5" strokeWidth={2} aria-hidden="true" />Back
        </Button>
        {record && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">
              <span className="font-mono text-foreground">{record.title}</span>
              {record.subtitle && <span className="text-secondary-text"> · {record.subtitle}</span>}
            </span>
          </>
        )}
      </div>

      {step.fields.map((field, index) => (
        <div key={field.name} className="flex flex-col gap-1.5">
          <Label htmlFor={`step-${field.name}`} className="text-[12px] font-semibold text-secondary-text">
            {field.label}{field.required && <span className="ml-0.5 text-late">*</span>}
          </Label>

          {field.type === 'select' ? (
            <Select value={values[field.name] ?? ''} onValueChange={set(field.name)}>
              <SelectTrigger id={`step-${field.name}`} ref={index === 0 ? firstField : undefined} className="h-control w-full bg-muted text-[13px]">
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
              className="min-h-[72px] bg-muted text-[13px]"
              maxLength={field.maxLength}
              value={values[field.name] ?? ''}
              onChange={(e) => set(field.name)(e.target.value)}
            />
          ) : (
            <Input
              id={`step-${field.name}`}
              ref={index === 0 ? firstField : undefined}
              className="h-control bg-muted text-[13px]"
              type={field.type}
              min={field.min}
              step={field.step}
              maxLength={field.maxLength}
              value={values[field.name] ?? ''}
              onChange={(e) => set(field.name)(e.target.value)}
            />
          )}

          {field.hint && <span className="text-[11.5px] text-muted-foreground">{field.hint}</span>}
        </div>
      ))}

      {error && (
        <Alert variant="destructive" className="border-late/30 bg-late/10 text-late">
          <AlertDescription className="text-[12.5px] text-late">{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy} className="h-control gap-2 text-[13px] font-semibold">
          {busy ? 'Working…' : step.verb}
          <ChevronRight className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
        </Button>
        <span className="text-[12.5px] text-secondary-text">{step.hint}</span>
      </div>
    </form>
  );
}

export function CommandPalette({ open, onOpenChange, isAdmin }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [step, setStep] = useState(null);
  const [record, setRecord] = useState(null);
  const [choices, setChoices] = useState([]);
  const [values, setValues] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { steps, jumps } = useMemo(() => commandsFor({ isAdmin }), [isAdmin]);

  const reset = useCallback(() => {
    setQ(''); setFound([]); setStep(null); setRecord(null);
    setChoices([]); setValues({}); setError(''); setBusy(false);
  }, []);

  useEffect(() => { if (!open) reset(); }, [open, reset]);

  // Search runs a beat behind the typing, so a fast typist makes one
  // request rather than one per keystroke.
  useEffect(() => {
    if (step || q.trim().length < 2) { setFound([]); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      api.raw(`/search?q=${encodeURIComponent(q.trim())}`)
        .then((res) => { if (live) setFound(res.data || []); })
        .catch(() => { if (live) setFound([]); });
    }, 160);
    return () => { live = false; clearTimeout(timer); };
  }, [q, step]);

  const close = () => onOpenChange(false);

  /** A step with no record to pick goes straight to its form. */
  const beginStep = async (chosen) => {
    setStep(chosen);
    setValues(initialValues(chosen));
    setError('');
    setQ('');
    if (!chosen.picks) return;
    try {
      const res = await api.list(chosen.picks.resource, { ...chosen.picks.params, limit: 40 });
      setChoices((res.data || []).map((row) => ({
        ...row,
        title: String(row[chosen.key || 'invoice_no'] ?? row.stage_name ?? row.claim_id ?? row.vendor_invoice_no ?? row.id),
        subtitle: [row.client_name, row.po_number, row.employee_name, row.service_quoted]
          .filter(Boolean).slice(0, 2).join(' · '),
      })));
    } catch {
      setChoices([]);
      setError('Could not load the list to pick from. Close and try again.');
    }
  };

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-20 left-1/2 max-h-[min(560px,calc(100vh-10rem))] w-[640px] max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden rounded-[14px] border-[#33333a] bg-[#16161a] p-0 shadow-[0_28px_80px_rgba(0,0,0,0.66)] sm:max-w-[640px]"
      >
        <DialogTitle className="sr-only">Search or do anything</DialogTitle>
        <DialogDescription className="sr-only">
          Type what you want to happen, or the name of a record to open.
        </DialogDescription>

        {step && !picking ? (
          <StepForm
            step={step} record={record} values={values} setValues={setValues}
            error={error} busy={busy} onRun={run}
            onBack={() => { setStep(null); setRecord(null); setChoices([]); setError(''); }}
          />
        ) : (
          <Command shouldFilter={!picking} filter={matches} loop className="flex flex-col overflow-hidden">
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
              <Search className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
              <Command.Input
                autoFocus
                value={q}
                onValueChange={setQ}
                placeholder={picking ? step.picks.label : 'Search or do anything'}
                className="flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
              />
              <kbd className="rounded-[4px] bg-[#22222a] px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-text">esc</kbd>
            </div>

            <Command.List className="max-h-[420px] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                {picking ? 'Nothing is waiting here.' : 'No step and no record matches that.'}
              </Command.Empty>

              {picking ? (
                <Command.Group heading={step.picks.label} className={GROUP}>
                  {choices.map((choice) => (
                    <Command.Item
                      key={choice.id}
                      value={`${choice.title} ${choice.subtitle}`}
                      onSelect={() => setRecord(choice)}
                      className={ROW}
                    >
                      <Icon name={step.icon} className="size-[17px] shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono text-[12.5px] text-foreground">{choice.title}</span>
                        {choice.subtitle && <span className="text-secondary-text"> · {choice.subtitle}</span>}
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
                    </Command.Item>
                  ))}
                </Command.Group>
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
                        <Icon name={entry.icon} className="size-[17px] shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {entry.verb}
                          <span className="font-normal text-secondary-text"> · {entry.hint}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-primary opacity-0 group-data-[selected=true]:opacity-100">↵</span>
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
                        <Icon name={entry.icon} className="size-[17px] shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-foreground">{entry.verb}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>

                  {grouped.map(([type, hits]) => (
                    <Command.Group key={type} heading={`${PLURAL[type]} matching “${q.trim()}”`} className={GROUP}>
                      {hits.map((hit) => (
                        <Command.Item
                          key={`${hit.type}-${hit.id}`}
                          value={`${hit.title} ${hit.subtitle} ${q}`}
                          onSelect={() => { navigate(hit.href); close(); }}
                          className={ROW}
                        >
                          <Icon name={hit.icon} className="size-[17px] shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-mono text-[12.5px] text-foreground">{hit.title}</span>
                            {hit.subtitle && <span className="text-secondary-text"> · {hit.subtitle}</span>}
                          </span>
                          <StateChip state={hit.state} />
                        </Command.Item>
                      ))}
                    </Command.Group>
                  ))}
                </>
              )}
            </Command.List>

            <div className="flex h-9 items-center gap-5 border-t border-border bg-[#111114] px-5 text-[11.5px] text-muted-foreground">
              <span><span className="font-mono text-secondary-text">↑↓</span> move</span>
              <span><span className="font-mono text-secondary-text">↵</span> run</span>
              <span className="ml-auto hidden sm:inline">Steps run here — the page never changes under you</span>
            </div>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** ⌘K anywhere, and / when you are not already typing into something. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event) => {
      const typing = /^(input|textarea|select)$/i.test(event.target?.tagName) || event.target?.isContentEditable;
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((was) => !was);
      } else if (event.key === '/' && !typing) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { open, setOpen };
}
