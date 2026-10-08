import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from 'cn';
import { SettingsPane } from './SettingsArea.jsx';
import { useToast } from '../components/ui.jsx';
import { FailedCard, LoadingPanel } from '../components/daily.jsx';
import { Tone } from '../components/sales.jsx';
import { undoToast } from '../components/settings.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Settings › Lists › Report categories (docs/sales-report-rework-plan.md
 * §4.3, §4.4), Wave 8.
 *
 * Sector and service are free text on quotations and enquiries, so the
 * Reports page puts each spelling in a headline category. This is where an
 * admin says what those categories are and which spellings belong in each.
 * Nothing on a record changes: the next report simply reads them again.
 * An unsaved order sits in a bar with Undo / Save order; removing an alias
 * offers Undo.
 */

const OTHER = 'Other';
const KEYWORDS = '__keywords__';

export default function ReportCategories() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/reports/categories'));
  const c = data?.data;

  return (
    <SettingsPane
      title="Report categories"
      description="The headline sectors and service lines the Reports page groups POs into. Sector and service stay free text on every record; these lists decide which category each spelling counts under. Anything not listed counts as Other."
    >
      {error ? <FailedCard title="Couldn’t load report categories" text="The server didn’t answer, so nothing is shown. This isn’t “nothing set”: nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !c ? <LoadingPanel rows={5} />
      : c && (
        <>
          <div className="set-two">
            <CategoryList id="set-hs" title="Headline sectors" settingKey="report_sectors" names={c.sectors} onSaved={refetch} />
            <CategoryList id="set-sl" title="Service lines" settingKey="report_service_lines" names={c.service_lines} onSaved={refetch} />
          </div>
          <SectorAliases categories={c.sectors} aliases={c.aliases} usage={c.sector_usage} onChanged={refetch} />
          <ServiceMapping lines={c.service_lines} services={c.services} onChanged={refetch} />
        </>
      )}
    </SettingsPane>
  );
}

/** An ordered list of names, edited locally and saved in one go. */
function CategoryList({ id, title, settingKey, names, onSaved }) {
  const toast = useToast();
  const [list, setList] = useState(names);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setList(names), [names]);

  const dirty = JSON.stringify(list) !== JSON.stringify(names);
  const moved = new Set(list.filter((n, i) => names.indexOf(n) !== i));
  const move = (i, by) => setList((l) => {
    const next = [...l];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    return next;
  });
  function add() {
    const name = adding.trim();
    if (!name) return;
    setList((l) => [...l, name]);
    setAdding('');
  }
  async function save() {
    setBusy(true);
    try {
      await api.update('settings', settingKey, { value: JSON.stringify(list) });
      toast('Order saved', 'success');
      onSaved();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }
  const added = list.filter((n) => !names.includes(n));
  const removed = names.filter((n) => !list.includes(n));
  const what = [
    added.length && `${added.join(', ')} added`,
    removed.length && `${removed.join(', ')} removed`,
    !added.length && !removed.length && 'the order changed',
  ].filter(Boolean).join('; ');

  return (
    <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby={id} style={{ gap: 10 }}>
      <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id={id}>{title}</h2><span className="mg-panel__hint">In the order the report lists them.</span></div>
      <ol className="set-olist">
        {list.map((name, i) => (
          <li key={`${name}-${i}`} className={cn(moved.has(name) && 'is-moved')}>
            <span className="set-olist__n">{i + 1}</span>
            <span className="set-olist__t">{name}</span>
            {moved.has(name) && names.includes(name) && <Tone tone="wait">{names.indexOf(name) > i ? 'Moved up' : 'Moved down'}</Tone>}
            <button type="button" className="mg-iconbtn" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" aria-hidden="true" /></button>
            <button type="button" className="mg-iconbtn" aria-label={`Move ${name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" aria-hidden="true" /></button>
            <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Remove ${name} from ${title.toLowerCase()}`} onClick={() => setList((l) => l.filter((_, j) => j !== i))}>Remove</button>
          </li>
        ))}
        <li className="text-muted-foreground"><span className="set-olist__n" /><span className="set-olist__t font-medium">{OTHER}: everything not listed above</span></li>
      </ol>
      <div className="set-addrow">
        <input className="mg-input" placeholder="Add a category" aria-label={`Add to ${title.toLowerCase()}`} value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button type="button" className="mg-btn mg-btn--sm" onClick={add} disabled={!adding.trim()}>Add</button>
      </div>
      {dirty && (
        <div className="set-dirtybar" role="status">
          <span>Not saved yet: {what}.</span>
          <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" onClick={() => setList(names)} disabled={busy}>Undo</button>
          <button type="button" className="mg-btn mg-btn--sm mg-btn--primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save order'}</button>
        </div>
      )}
    </section>
  );
}

/** A native glass select of the headline sectors (or service lines). */
function CategoryPicker({ value, options, onChange, label, placeholder, extra }) {
  return (
    <span className="mg-select-wrap">
      <select className="mg-select" aria-label={label} value={value ?? ''} onChange={(e) => e.target.value && onChange(e.target.value)}>
        {placeholder && <option value="">{placeholder}</option>}
        {extra}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </span>
  );
}

/**
 * Spellings that count under a headline sector, and every spelling in use
 * with where it lands today — so what is hiding in Other is one pick from
 * being counted where it belongs.
 */
function SectorAliases({ categories, aliases, usage, onChanged }) {
  const toast = useToast();
  const [alias, setAlias] = useState('');
  const [sector, setSector] = useState('');

  async function create(name, target, quiet = false) {
    try {
      await api.create('sector-aliases', { alias: name, sector: target });
      if (!quiet) toast(`“${name}” now counts as ${target}`, 'success');
      setAlias('');
      onChanged();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
  async function remove(row) {
    try {
      await api.remove('sector-aliases', row.id);
      onChanged();
      undoToast(`“${row.alias}” no longer counts as ${row.sector}.`, () => create(row.alias, row.sector, true));
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const inOther = usage.filter((u) => u.category === OTHER);
  return (
    <div className="set-two">
      <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby="set-al" style={{ gap: 10 }}>
        <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="set-al">Sector aliases</h2><span className="mg-panel__hint">Other spellings of a headline sector.</span></div>
        <div className="flex flex-col">
          {aliases.length === 0 && <p className="m-0 text-[13px] text-secondary-text">No aliases yet. A sector spelled exactly like a headline sector needs none.</p>}
          {aliases.map((row) => {
            const gone = !categories.includes(row.sector);
            return (
              <div key={row.id} className="set-kv">
                <b>{row.alias}</b>
                <span className="text-[12.5px] text-muted-foreground">counts as</span>
                <span className={cn('font-semibold', gone && 'text-muted-foreground line-through')}>{row.sector}</span>
                {gone && <Tone tone="wait">No longer a headline sector</Tone>}
                <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost ml-auto" aria-label={`Remove the alias ${row.alias}`} onClick={() => remove(row)}>Remove</button>
              </div>
            );
          })}
        </div>
        <div className="set-addrow pt-1">
          <input className="mg-input" placeholder="Spelling, e.g. Steel" aria-label="Alias" value={alias} onChange={(e) => setAlias(e.target.value)} />
          <CategoryPicker value={sector} options={categories} onChange={setSector} label="Counts as" placeholder="Counts as…" />
          <button type="button" className="mg-btn mg-btn--sm" disabled={!alias.trim() || !sector} onClick={() => create(alias.trim(), sector)}>Add alias</button>
        </div>
      </section>

      <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby="set-ot" style={{ gap: 10 }}>
        <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="set-ot">Sectors counted as Other</h2><span className="mg-panel__hint">{inOther.length} spelling{inOther.length === 1 ? '' : 's'} in use. Pick where each should count.</span></div>
        <div className="flex flex-col">
          {inOther.length === 0
            ? <p className="m-0 text-[13px] text-secondary-text">Every sector in use counts under a headline sector.</p>
            : inOther.map((u) => (
              <div key={u.name} className="set-kv">
                <span className="min-w-0 flex-[1_1_140px]"><b className="block">{u.name}</b><span className="text-[12.5px] text-secondary-text">{u.records} record{u.records === 1 ? '' : 's'}</span></span>
                <CategoryPicker value="" options={categories} onChange={(target) => create(u.name, target)} label={`Count ${u.name} as`} placeholder="Count as…" />
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Each catalogue service and the line it counts under. Unassigned, its name
 * is matched by keyword (EcoVadis, ESIA, ISO…); assigning a line overrides
 * that for every PO and quotation line naming the service.
 */
function ServiceMapping({ lines, services, onChanged }) {
  const toast = useToast();
  async function assign(service, value) {
    try {
      await api.update('services', service.id, { report_line: value === KEYWORDS ? null : value });
      onChanged();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
  return (
    <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby="set-cs" style={{ gap: 10 }}>
      <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="set-cs">Catalogue services</h2><span className="mg-panel__hint">The service line each one counts under. Left on Match by keyword, its name decides.</span></div>
      <div className="flex flex-col">
        {services.length === 0 && <p className="m-0 text-[13px] text-secondary-text">No services in the catalogue yet.</p>}
        {services.map((s) => (
          <div key={s.id} className="set-kv">
            <span className={cn('min-w-0 flex-[1_1_220px] font-bold', !s.active && 'text-muted-foreground')}>{s.name}</span>
            <Tone tone={s.assigned ? 'info' : 'plain'}>{s.assigned ? 'Assigned' : 'By keyword'}</Tone>
            <CategoryPicker
              value={s.assigned ? s.report_line : KEYWORDS}
              options={lines}
              onChange={(value) => assign(s, value)}
              label={`Service line for ${s.name}`}
              extra={<option value={KEYWORDS}>{s.assigned || !s.lines?.length ? 'Match by keyword' : `Match by keyword (now ${s.lines.join(', ')})`}</option>}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
