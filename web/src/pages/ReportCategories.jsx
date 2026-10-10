import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { SettingsPane } from './SettingsArea.jsx';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { RecordSection } from '../components/record.jsx';
import { Badge, Empty, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Settings → Reports (docs/sales-report-rework-plan.md §4.3, §4.4).
 *
 * Sector and service are free text on quotations and enquiries, so the
 * Reports page puts each spelling in a headline category. This is where an
 * admin says what those categories are and which spellings belong in each.
 * Nothing on a record changes: the next report simply reads them again.
 *
 * Admin-only; GET /api/reports/categories names sectors from every record.
 */

const OTHER = 'Other';
const KEYWORDS = '__keywords__';

export default function ReportCategories() {
  const { data, loading, refetch } = useFetch(() => api.raw('/reports/categories'));
  const c = data?.data;

  if (loading && !c) return <div className="skeleton h-[320px]" />;
  if (!c) return null;

  return (
    <SettingsPane
      title="Reports"
      description="The headline sectors and service lines the Reports page groups POs into. Sector and service stay free text on every record; these lists decide which category each spelling counts under. Anything not listed counts as Other."
    >
      <CategoryList
        title="Headline sectors"
        hint="In the order the report lists them"
        settingKey="report_sectors"
        names={c.sectors}
        onSaved={refetch}
      />
      <SectorAliases categories={c.sectors} aliases={c.aliases} usage={c.sector_usage} onChanged={refetch} />
      <CategoryList
        title="Service lines"
        hint="In the order the report lists them"
        settingKey="report_service_lines"
        names={c.service_lines}
        onSaved={refetch}
      />
      <ServiceMapping lines={c.service_lines} services={c.services} onChanged={refetch} />
    </SettingsPane>
  );
}

/** An ordered list of names, edited locally and saved in one go. */
function CategoryList({ title, hint, settingKey, names, onSaved }) {
  const toast = useToast();
  const [list, setList] = useState(names);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setList(names), [names]);

  const dirty = JSON.stringify(list) !== JSON.stringify(names);
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
      toast('Saved', 'success');
      onSaved();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <RecordSection
      title={title}
      hint={hint}
      action={dirty && (
        <>
          <Button size="sm" variant="ghost" className="h-7 text-[12.5px]" onClick={() => setList(names)} disabled={busy}>Undo</Button>
          <Button size="sm" className="h-7 text-[12.5px]" onClick={save} disabled={busy}>Save</Button>
        </>
      )}
    >
      <ol>
        {list.map((name, i) => (
          <li key={`${name}-${i}`} className="flex items-center gap-2 border-b border-border px-5 py-2 text-[13px]">
            <span className="w-5 text-right text-muted-foreground tabular-nums">{i + 1}</span>
            <span className="flex-1 font-medium text-foreground">{name}</span>
            <button type="button" className="btn btn--sm btn--ghost" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="btn btn--sm btn--ghost" aria-label={`Move ${name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>Remove</button>
          </li>
        ))}
        <li className="flex items-center gap-2 border-b border-border px-5 py-2 text-[13px] text-muted-foreground">
          <span className="w-5" />
          <span className="flex-1">{OTHER} — everything not listed above</span>
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <Input
          className="h-7 w-[16rem] text-[12.5px]"
          placeholder="Add a category"
          aria-label={`Add to ${title.toLowerCase()}`}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <Button size="sm" variant="outline" className="h-7 text-[12.5px]" onClick={add} disabled={!adding.trim()}>Add</Button>
      </div>
    </RecordSection>
  );
}

/** A small picker of the headline sectors (or service lines). */
function CategoryPicker({ value, options, onChange, label, placeholder = 'Choose…', extra }) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-7 w-[13rem] text-[12.5px]" aria-label={label}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {extra}
        {options.map((o) => <SelectItem key={o} value={o} className="text-[12.5px]">{o}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/**
 * Spellings that count under a headline sector, and every spelling in use
 * with where it lands today — so what is hiding in Other is one click from
 * being counted where it belongs.
 */
function SectorAliases({ categories, aliases, usage, onChanged }) {
  const toast = useToast();
  const [alias, setAlias] = useState('');
  const [sector, setSector] = useState('');

  async function create(name, target) {
    try {
      await api.create('sector-aliases', { alias: name, sector: target });
      toast(`"${name}" now counts as ${target}`, 'success');
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
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const inOther = usage.filter((u) => u.category === OTHER);
  return (
    <>
      <RecordSection title="Sector aliases" hint="Other spellings of a headline sector">
        {aliases.length === 0 && <div className="px-5 py-3 text-[13px] text-muted-foreground">No aliases yet. A sector spelled exactly like a headline sector needs none.</div>}
        {aliases.map((row) => (
          <div key={row.id} className="flex items-center gap-3 border-b border-border px-5 py-2 text-[13px]">
            <span className="flex-1 font-medium text-foreground">{row.alias}</span>
            <span className="text-muted-foreground">counts as</span>
            <span className={cn('w-[12rem]', !categories.includes(row.sector) && 'text-muted-foreground line-through')}>{row.sector}</span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(row)}>Remove</button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          <Input className="h-7 w-[14rem] text-[12.5px]" placeholder="Spelling, e.g. Steel" aria-label="Alias" value={alias} onChange={(e) => setAlias(e.target.value)} />
          <CategoryPicker value={sector} options={categories} onChange={setSector} label="Counts as" />
          <Button size="sm" variant="outline" className="h-7 text-[12.5px]" disabled={!alias.trim() || !sector} onClick={() => create(alias.trim(), sector)}>Add alias</Button>
        </div>
      </RecordSection>

      <RecordSection title="Sectors counted as Other" hint={`${inOther.length} spelling${inOther.length === 1 ? '' : 's'} in use`}>
        {inOther.length === 0
          ? <Empty title="Every sector in use counts under a headline sector" />
          : inOther.map((u) => (
            <div key={u.name} className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2 text-[13px]">
              <span className="flex-1 font-medium text-foreground">{u.name}</span>
              <span className="text-muted-foreground tabular-nums">{u.records} record{u.records === 1 ? '' : 's'}</span>
              <CategoryPicker
                value=""
                options={categories}
                onChange={(target) => create(u.name, target)}
                label={`Count ${u.name} as`}
                placeholder="Count as…"
              />
            </div>
          ))}
      </RecordSection>
    </>
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
    <RecordSection title="Catalogue services" hint="The service line each one counts under">
      {services.length === 0 && <Empty title="No services in the catalogue yet" />}
      {services.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2 text-[13px]">
          <span className={cn('flex-1 font-medium', s.active ? 'text-foreground' : 'text-muted-foreground')}>{s.name}</span>
          <span className="text-muted-foreground">{s.lines.join(', ')}</span>
          <Badge tone={s.assigned ? 'info' : 'neutral'}>{s.assigned ? 'Assigned' : 'By keyword'}</Badge>
          <CategoryPicker
            value={s.assigned ? s.report_line : KEYWORDS}
            options={lines}
            onChange={(value) => assign(s, value)}
            label={`Service line for ${s.name}`}
            extra={<SelectItem value={KEYWORDS} className="text-[12.5px]">Match by keyword</SelectItem>}
          />
        </div>
      ))}
    </RecordSection>
  );
}
