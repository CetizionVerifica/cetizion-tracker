import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  BarChart3, ChevronDown, CircleAlert, Inbox, Pencil, Plus, Search, SearchX, SlidersHorizontal, Trash2, X,
} from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { DataTable, ConfirmDialog, useToast } from './ui.jsx';
import { ExportMenu, MoreMenu } from './sales.jsx';
import { RecordForm } from './RecordForm.jsx';
import { SavedViews } from './SavedViews.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { mayDeleteResource } from '../lib/permissions.js';
import { useDebounced, useList } from '../lib/hooks.js';
import { date } from '../lib/format.js';

/**
 * The standard list screen: search, filters, CSV export, create / edit /
 * delete. Pages supply the columns, the form fields and the filters —
 * nothing else, so every list behaves the same way.
 */
export function ListPage({
  title,
  subtitle,
  resource,
  columns,
  fields,
  filters = [],
  searchPlaceholder = 'Search…',
  newLabel,
  newButton,
  formTitle,
  formSubtitle,
  formIntro,
  formSize,
  formSubmitLabel,
  onRowClick,
  extraActions,
  emptyState,
  initialFilters,
  initialSearch,
  dateFilterLabel = 'Date',
  refreshToken,
  onSaved,
  rowActions = true,
  rowExtras,
  rowMenu,
  canDelete,
  banner,
  eyebrow,
  nav,
  summary,
  phone,
  quick,
  allLabel,
  extraFilterLabels = {},
  deleteTitle,
  deleteText,
  noun,
}) {
  const toast = useToast();
  const [urlParams, setUrlParams] = useSearchParams();

  /**
   * A filter named in the address bar is applied, whatever list this is.
   *
   * A saved view is a resource and a set of filters, and it links here as
   * `?stage_status=Overdue`. Reading the URL once, here, is what lets a
   * view work on every list without each page being taught about it —
   * before this, each page mapped its own handful of parameters by hand,
   * and a view pointing at any other filter quietly did nothing.
   */
  const fromUrl = {};
  for (const { name } of filters) {
    const value = urlParams.get(name);
    if (value) fromUrl[name] = value;
  }
  // The records behind a Reports chart (?report_from=&report_outcome=…).
  // Not a dropdown on any list: the server runs the report's own rules on
  // them, so they ride along with the filters to the list, its exports and
  // a saved view, and the banner below says why the list is short.
  const fromReport = {};
  for (const [name, value] of urlParams) if (name.startsWith('report_') && value) fromReport[name] = value;
  Object.assign(fromUrl, fromReport);
  const urlSearch = urlParams.get('q') || '';
  const { pathname } = useLocation();

  // Companies, contacts, purchase orders, their service lines and their
  // payment stages are an admin's to delete (#85) — shared master data and
  // the rows every billing figure is computed from. A page may still say
  // canDelete={false} outright; left unsaid, the resource's own rule decides,
  // so a list cannot forget the way every list did before.
  const { isAdmin } = useAuth();
  const mayDelete = canDelete ?? mayDeleteResource(resource, isAdmin);

  const [search, setSearch] = useState(initialSearch || urlSearch);
  // Arriving from a dashboard tile pre-selects the matching filter, so the
  // chip shows why the list is short.
  const [filterValues, setFilterValues] = useState(() => ({ ...initialFilters, ...fromUrl }));

  // Those props come from the URL, and this screen stays mounted when the URL
  // changes under it — a second tile, or another ?q= link. Without this the
  // address bar would say one thing and the table show another. Compared by
  // value, so a filter the user picked by hand is left alone.
  const initialFiltersKey = JSON.stringify({ ...initialFilters, ...fromUrl });
  useEffect(() => {
    setFilterValues(JSON.parse(initialFiltersKey));
  }, [initialFiltersKey]);
  useEffect(() => {
    setSearch(initialSearch || '');
  }, [initialSearch]);
  // The server already understands `?sort=column:dir`; nothing in the UI
  // ever asked for it, so a sixty-row list could only be read in the one
  // order the resource happened to default to.
  const [sort, setSort] = useState('');
  const [editing, setEditing] = useState(null); // record | 'new' | null
  const [allOpen, setAllOpen] = useState(false);
  // The shell's New menu and dock open this list's own "+ New" form with
  // ?new=<resource>; the parameter is dropped once the form is open, so a
  // reload or Back does not open it again.
  const askedNew = urlParams.get('new') === resource;
  useEffect(() => {
    if (!askedNew || !fields) return;
    setEditing('new');
    setUrlParams((prev) => { const next = new URLSearchParams(prev); next.delete('new'); return next; }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedNew]);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const debouncedSearch = useDebounced(search);
  const params = { q: debouncedSearch, ...filterValues, ...(sort ? { sort } : {}) };
  // refreshToken lets a parent pull fresh rows after an action without
  // remounting, so the user's search and filters survive.
  const { rows, total, loading, error, refetch } = useList(resource, params, [refreshToken]);

  const setFilter = (name, value) =>
    setFilterValues((current) => {
      const next = { ...current };
      if (value === '' || value == null) delete next[name];
      else next[name] = value;
      return next;
    });
  const clearAll = () => { setSearch(''); setFilterValues({}); };
  const filtered = Boolean(search) || Object.keys(filterValues).length > 0;
  const word = noun || title.toLowerCase();
  const newText = newButton || `New ${String(newLabel || 'record').toLowerCase()}`;

  async function confirmDelete() {
    setBusy(true);
    try {
      await api.remove(resource, deleting.id);
      toast('Deleted', 'success');
      setDeleting(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  /**
   * A column is sortable when its key is a field the rows actually carry.
   *
   * Derived from the data rather than declared per page, so it cannot
   * name a field that does not exist — and a column that only renders
   * something computed has no key in the row, so it stays unsorted rather
   * than sorting by something the reader cannot see. A page can still say
   * `sortBy` explicitly when the visible column and the field differ.
   */
  const sortable = columns.map((col) => ({
    ...col,
    sortBy: col.sortBy ?? (rows[0] && Object.hasOwn(rows[0], col.key) ? col.key : undefined),
  }));

  const tableColumns = rowActions
    ? [
        ...sortable,
        {
          key: '__actions',
          header: '',
          align: 'right',
          render: (row) => (
            <span className="app-rowacts">
              {rowExtras?.(row)}
              {fields && (
                <button type="button" className="mg-iconbtn" aria-label="Edit" title="Edit" onClick={() => setEditing(row)}>
                  <Pencil strokeWidth={1.8} aria-hidden="true" />
                </button>
              )}
              {mayDelete && (
                <button type="button" className="mg-iconbtn" aria-label="Delete" title="Delete" onClick={() => setDeleting(row)}>
                  <Trash2 strokeWidth={1.8} aria-hidden="true" />
                </button>
              )}
            </span>
          ),
        },
      ]
    : sortable;

  // A phone row: what it is and how much, the meta line and its state, then
  // a ⋯ menu with what the table's row buttons do (D1-2).
  const phoneRow = phone ? (row) => {
    const r = phone(row);
    const menu = [
      ...(rowMenu?.(row) || []),
      rowActions && fields && { label: 'Edit', icon: Pencil, onSelect: () => setEditing(row) },
      rowActions && mayDelete && { label: 'Delete', icon: Trash2, danger: true, onSelect: () => setDeleting(row) },
    ].filter(Boolean);
    const open = r.to || onRowClick;
    return (
      <div className={cn('mg-row', open && 'is-clickable')} onClick={(e) => { if (!r.to && onRowClick && !e.target.closest('button, a')) onRowClick(row); }}>
        <span className="mg-row__title" style={{ whiteSpace: 'normal' }}>
          {r.to ? <Link to={r.to} className="text-inherit no-underline">{r.title}</Link> : r.title}
        </span>
        <span className="mg-row__amount mg-num">{r.amount}</span>
        <span className="mg-row__meta" style={{ whiteSpace: 'normal' }}>{r.meta}</span>
        <span className="mg-row__state" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
          {r.state}
          {menu.length > 0 && <MoreMenu items={menu} size="sm" label={`Actions for ${typeof r.title === 'string' ? r.title : 'this row'}`} />}
        </span>
      </div>
    );
  } : undefined;

  // Chips for every filter that is on: those in the panel, the ones only a
  // link sets (Insights' close month, one owner), and the date range.
  const known = Object.fromEntries(filters.map((f) => [f.name, f]));
  const optionLabel = (f, value) => {
    const opt = (f.options || []).find((o) => String(typeof o === 'string' ? o : o.value) === String(value));
    return opt ? (typeof opt === 'string' ? opt : opt.label) : value === '__none__' ? 'Not set' : value === '__any__' ? 'Set' : value;
  };
  const activeChips = Object.entries(filterValues)
    .filter(([name]) => name !== 'from' && name !== 'to' && !name.startsWith('report_'))
    .map(([name, value]) => {
      const f = known[name];
      const label = f ? f.label : extraFilterLabels[name] || name.replace(/_/g, ' ');
      const said = value === '__none__' ? 'Not set' : value === '__any__' ? 'Set' : value;
      return { name, text: `${label}: ${f ? optionLabel(f, value) : said}` };
    });
  const quickNames = quick || filters.slice(0, 3).map((f) => f.name);
  const quickIdle = filters.filter((f) => quickNames.includes(f.name) && !filterValues[f.name]);

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        eyebrow={eyebrow}
        nav={nav}
        actions={
          <>
            {extraActions}
            <ExportMenu resource={resource} params={params} />
            {fields && (
              <button type="button" className="mg-btn mg-btn--primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" strokeWidth={2} aria-hidden="true" />{newText}
              </button>
            )}
          </>
        }
      />

      <div className="app-page">
        {typeof summary === 'function' ? summary({ filters: filterValues, setFilter, setFilters: setFilterValues, rows, total }) : summary}

        <section className="mg-glass mg-glass--strong app-panel" aria-label={title} data-a="rise" style={{ position: 'relative', zIndex: 6 }}>
          {(fromReport.report_from || banner) && (
            <div className="flex flex-col gap-3 px-[18px] pt-[14px] empty:hidden">
              {fromReport.report_from && (
                <div className="mg-banner" role="note">
                  <BarChart3 aria-hidden="true" />
                  <div className="mg-banner__body">{reportBannerText(fromReport, total)}</div>
                  <Link to={pathname} className="mg-btn mg-btn--sm self-center">Show all {word}</Link>
                </div>
              )}
              {typeof banner === 'function' ? banner(rows, { filters: filterValues, setFilters: setFilterValues, setFilter }) : banner}
            </div>
          )}

          <SavedViews
            resource={resource}
            filters={filterValues}
            search={debouncedSearch}
            allLabel={allLabel || `All ${word}`}
            onApply={(saved) => {
              const { q, ...rest } = saved || {};
              setSearch(q || '');
              setFilterValues(rest);
            }}
          />

          <div className="mg-filterbar app-filters" style={{ position: 'relative' }}>
            <label className="mg-search">
              <Search aria-hidden="true" />
              <input className="mg-input" placeholder={searchPlaceholder} aria-label={`Search ${word}`} value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <div className="app-chiprow app-filters__chips">
              {activeChips.map((c) => (
                <button key={c.name} type="button" className="mg-chip" aria-pressed="true" aria-label={`${c.text}. Remove this filter`} onClick={() => setFilter(c.name, '')}>
                  {c.text}<X className="mg-chip__x" strokeWidth={2.2} aria-hidden="true" />
                </button>
              ))}
              {/* A date range arrives only from a report link, so show it and let it be removed. */}
              {(filterValues.from || filterValues.to) && (
                <button type="button" className="mg-chip" aria-pressed="true" aria-label="Remove date filter" onClick={() => setFilterValues(({ from, to, ...rest }) => rest)}>
                  {dateFilterLabel}: {filterValues.from ? date(filterValues.from) : 'start'} – {filterValues.to ? date(filterValues.to) : 'today'}
                  <X className="mg-chip__x" strokeWidth={2.2} aria-hidden="true" />
                </button>
              )}
              {quickIdle.map((f) => (
                <span key={f.name} className="app-chipselect">
                  <select aria-label={`Filter by ${f.label.toLowerCase()}`} value="" onChange={(e) => setFilter(f.name, e.target.value)}>
                    <option value="">{f.label}</option>
                    {f.options.map((opt) => {
                      const value = typeof opt === 'string' ? opt : opt.value;
                      return <option key={value} value={value}>{typeof opt === 'string' ? opt : opt.label}</option>;
                    })}
                  </select>
                  <ChevronDown aria-hidden="true" />
                </span>
              ))}
              {filters.length > 0 && (
                <button type="button" className="mg-chip" aria-haspopup="dialog" aria-expanded={allOpen} onClick={() => setAllOpen((o) => !o)}>
                  <SlidersHorizontal strokeWidth={1.8} aria-hidden="true" />
                  All filters{activeChips.length ? ` · ${activeChips.length}` : ''}
                </button>
              )}
              {filtered && <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={clearAll}>Clear</button>}
              <span className="app-count" aria-live="polite">{loading ? 'Loading…' : `${rows.length} of ${total}`}</span>
            </div>
            {allOpen && (
              <AllFilters
                filters={filters}
                values={filterValues}
                onChange={setFilter}
                onClear={() => setFilterValues({})}
                onClose={() => setAllOpen(false)}
                showing={loading ? null : total}
                word={word}
              />
            )}
          </div>

          {error ? (
            <div className="mg-empty" role="alert" style={{ borderTop: '1px solid var(--line)' }}>
              <span className="mg-empty__mark bg-late-soft text-late"><CircleAlert className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
              <h2 className="mg-empty__title">Couldn't load the {word}</h2>
              <p className="mg-empty__text">{error}</p>
              <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>
            </div>
          ) : (
            <DataTable
              columns={tableColumns}
              rows={rows}
              loading={loading}
              onRowClick={onRowClick}
              label={title}
              sort={sort}
              onSort={setSort}
              stickyHeader
              phone={phoneRow}
              empty={
                emptyState || (filtered ? (
                  <div className="mg-empty" style={{ borderTop: '1px solid var(--line)' }}>
                    <span className="mg-empty__mark"><SearchX className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
                    <h2 className="mg-empty__title">Nothing matches those filters</h2>
                    <p className="mg-empty__text">Clear a filter or the search to widen the list.</p>
                    <button type="button" className="mg-btn mg-btn--sm" onClick={clearAll}>Clear filters</button>
                  </div>
                ) : (
                  <div className="mg-empty" style={{ borderTop: '1px solid var(--line)' }}>
                    <span className="mg-empty__mark"><Inbox className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
                    <h2 className="mg-empty__title">No {word} yet</h2>
                    {fields && <p className="mg-empty__text">Add the first one to get started.</p>}
                    {fields && (
                      <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setEditing('new')}>
                        <Plus className="size-4" strokeWidth={2} aria-hidden="true" />{newText}
                      </button>
                    )}
                  </div>
                ))
              }
            />
          )}
        </section>
      </div>

      {editing && fields && (
        <RecordForm
          title={editing === 'new' ? `New ${formTitle || title}` : `Edit ${formTitle || title}`}
          subtitle={formSubtitle}
          intro={editing === 'new' ? formIntro : undefined}
          resource={resource}
          size={formSize}
          submitLabel={editing === 'new' ? formSubmitLabel : undefined}
          fields={typeof fields === 'function' ? fields(editing === 'new' ? null : editing) : fields}
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            refetch();
            onSaved?.(saved, editing === 'new' ? null : editing);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={deleteTitle ? deleteTitle(deleting) : 'Delete this record?'}
          message={deleteText ? deleteText(deleting) : 'This cannot be undone. Anything computed from it will update straight away.'}
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
          busy={busy}
        />
      )}
    </>
  );
}

/**
 * Every filter, labelled, in one glass pop-up over the list. Each choice
 * applies at once (the list behind it updates); "Show N" just closes it.
 */
function AllFilters({ filters, values, onChange, onClear, onClose, showing, word }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="mg-glass mg-glass--strong mg-pop app-allfilters" role="dialog" aria-label="All filters">
      <div className="app-allfilters__head">
        <h2 className="mg-panel__title">All filters</h2>
        <span className="mg-panel__hint">each one narrows the list at once</span>
        <button type="button" className="mg-iconbtn ml-auto" style={{ width: 36, height: 36 }} aria-label="Close the filters" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <div className="app-allfilters__grid">
        {filters.map((f) => (
          <label key={f.name} className="mg-field">
            <span className="mg-field__label">{f.label}</span>
            <span className="mg-select-wrap">
              <select className="mg-select" value={values[f.name] || ''} onChange={(e) => onChange(f.name, e.target.value)}>
                <option value="">All</option>
                {f.options.map((opt) => {
                  const value = typeof opt === 'string' ? opt : opt.value;
                  return <option key={value} value={value}>{typeof opt === 'string' ? opt : opt.label}</option>;
                })}
              </select>
            </span>
          </label>
        ))}
      </div>
      <div className="app-allfilters__foot">
        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={onClear}>Clear all</button>
        <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={onClose}>{showing == null ? 'Show them' : `Show ${showing} ${word}`}</button>
      </div>
    </div>
  );
}

const SLICE_LABEL = {
  outcome: {
    converted: 'converted to a PO', pipeline: 'still in the pipeline', quoted_not_won: 'quoted, not won', lost: 'lost before a quotation',
    not_quoted: 'in the pipeline, not yet quoted', quoted: 'in the pipeline, quoted',
  },
  customer: {
    new: 'from new customers', existing: 'from existing customers', first: 'first orders', repeat: 'repeat orders',
  },
};

/** "The 4 records behind the Reports chart: 1 Sep 2026 – 30 Sep 2026, lost before a quotation." */
function reportBannerText(q, total) {
  const parts = [`${date(q.report_from)} – ${date(q.report_to)}`];
  if (q.report_outcome) parts.push(SLICE_LABEL.outcome[q.report_outcome] ?? q.report_outcome);
  if (q.report_customer) parts.push(SLICE_LABEL.customer[q.report_customer] ?? q.report_customer);
  if (q.report_sector) parts.push(`sector ${q.report_sector}`);
  if (q.report_service) parts.push(`service ${q.report_service}`);
  if (q.report_month) parts.push(`month ${q.report_month}`);
  if (q.report_owner) parts.push('one owner');
  const count = total == null ? 'The records' : `The ${total} record${total === 1 ? '' : 's'}`;
  return `${count} behind the Reports chart: ${parts.join(', ')}.`;
}
