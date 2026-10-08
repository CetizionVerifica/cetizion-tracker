import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { Download, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { Alert, Card, DataTable, Empty, ErrorState, ConfirmDialog, useToast } from './ui.jsx';
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
  formTitle,
  formSubtitle,
  formIntro,
  onRowClick,
  extraActions,
  emptyState,
  initialFilters,
  initialSearch,
  dateFilterLabel = 'Date',
  refreshToken,
  onSaved,
  rowActions = true,
  canDelete,
  banner,
  /**
   * Picking rows, for a page that can do something with several at once.
   *
   * `{ ids, label, blockedReason, onToggle, onToggleAll, onVisible }`. This
   * owns the column and the select-all box; the page owns what is picked and
   * which rows may be. The split is deliberate — the rule about *why* a row
   * cannot join a selection belongs with the feature that has the rule, not
   * in the list screen every page shares.
   */
  selection,
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
  // dropdown shows why the list is short.
  const [filterValues, setFilterValues] = useState(() => ({ ...initialFilters, ...fromUrl }));

  // Those props come from the URL, and this screen stays mounted when the URL
  // changes under it — a second tile, or another ?q= link. Without this the
  // address bar would say one thing and the table show another. Compared by
  // value, so a filter the user picked by hand is left alone.
  const initialFiltersKey = JSON.stringify({ ...initialFilters, ...fromUrl });
  // The address the list itself last wrote (below). When the URL changes
  // because of that write, the filters already say it; only a change from
  // outside (a link, a tile, the back button) is read back in.
  const lastWrite = useRef(null);
  useEffect(() => {
    if (lastWrite.current === urlParams.toString()) return;
    setFilterValues(JSON.parse(initialFiltersKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiltersKey]);
  useEffect(() => {
    setSearch(initialSearch || '');
  }, [initialSearch]);
  // The server already understands `?sort=column:dir`; nothing in the UI
  // ever asked for it, so a sixty-row list could only be read in the one
  // order the resource happened to default to.
  const [sort, setSort] = useState('');
  const [editing, setEditing] = useState(null); // record | 'new' | null
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const debouncedSearch = useDebounced(search);
  const params = { q: debouncedSearch, ...filterValues, ...(sort ? { sort } : {}) };
  // refreshToken lets a parent pull fresh rows after an action without
  // remounting, so the user's search and filters survive.
  const { rows, total, loading, error, refetch } = useList(resource, params, [refreshToken]);

  /**
   * Filters live in the URL (web/CLAUDE.md §2), so a link or a refresh
   * carries them. Each dropdown and the search are written back as they
   * change, replacing the history entry rather than adding one per click.
   */
  useEffect(() => {
    const next = new URLSearchParams(urlParams);
    for (const { name } of filters) {
      if (filterValues[name]) next.set(name, filterValues[name]);
      else next.delete(name);
    }
    if (debouncedSearch) next.set('q', debouncedSearch);
    else next.delete('q');
    if (next.toString() !== urlParams.toString()) {
      lastWrite.current = next.toString();
      setUrlParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filterValues), debouncedSearch]);

  // Three filters show; the rest wait behind "More filters", which opens by
  // itself when one of them is already set so a filter is never hidden.
  const INLINE = 3;
  const extra = filters.slice(INLINE);
  const extraSet = extra.filter((f) => filterValues[f.name]).length;
  const [moreOpen, setMoreOpen] = useState(false);
  const showMore = moreOpen || extraSet > 0;
  const filtering = Boolean(search) || Object.keys(filterValues).length > 0;

  const setFilter = (name, value) =>
    setFilterValues((current) => {
      const next = { ...current };
      if (value === '') delete next[name];
      else next[name] = value;
      return next;
    });

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
  /**
   * A pick that is no longer on the list stops being a pick.
   *
   * Filters and the search change what the list holds, and a selection the
   * reader can no longer see is a selection they cannot check before acting
   * on it. Skipped while loading, where `rows` is empty for a moment and
   * would otherwise clear everything on every refetch.
   */
  const visibleIds = rows.map((row) => row.id).join(',');
  useEffect(() => {
    if (!selection?.onVisible || loading) return;
    selection.onVisible(rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds, loading]);

  const sortable = columns.map((col) => ({
    ...col,
    sortBy: col.sortBy ?? (rows[0] && Object.hasOwn(rows[0], col.key) ? col.key : undefined),
  }));

  /**
   * The tick box, and the one in the header that takes the lot.
   *
   * A row the page has blocked is drawn disabled with the reason on it, so
   * the rule is readable where the reader is, rather than discovered after
   * they press the button. A row already picked is never disabled: unticking
   * has to stay possible however the rule changed under it.
   */
  const selectColumn = selection && {
    key: '__select',
    identifies: false,
    width: 40,
    header: (
      <SelectAllBox
        rows={rows}
        selection={selection}
        label={`Select all ${title.toLowerCase()}`}
      />
    ),
    render: (row) => {
      const picked = selection.ids.has(row.id);
      const blocked = picked ? null : selection.blockedReason?.(row);
      return (
        <input
          type="checkbox"
          className="size-4 accent-[var(--primary)] align-middle"
          checked={picked}
          disabled={Boolean(blocked)}
          title={blocked || undefined}
          aria-label={`${selection.label || 'Select'} ${row[sortable[0]?.key] ?? row.id}${blocked ? ` — ${blocked}` : ''}`}
          onClick={(e) => e.stopPropagation()}
          onChange={() => selection.onToggle(row)}
        />
      );
    },
  };

  const picking = selectColumn ? [selectColumn] : [];

  const tableColumns = rowActions
    ? [
        ...picking,
        ...sortable,
        {
          key: '__actions',
          header: '',
          align: 'right',
          width: 110,
          render: (row) => (
            <div className="table__actions">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(row)}>
                Edit
              </button>
              {mayDelete && (
                <button type="button" className="btn btn--sm btn--ghost" aria-label="Delete" onClick={() => setDeleting(row)}>
                  <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
                </button>
              )}
            </div>
          ),
        },
      ]
    : [...picking, ...sortable];

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {extraActions}
            <a className="btn" href={api.exportUrl(resource, params)} download title="What the list shows now, with the same search and filters">
              <Download className="size-4" strokeWidth={1.75} aria-hidden="true" />
              CSV
            </a>
            <a className="btn" href={api.exportXlsxUrl(resource, params)} download title="What the list shows now, as an Excel workbook">
              <Download className="size-4" strokeWidth={1.75} aria-hidden="true" />
              Excel
            </a>
            {fields && (
              <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
                {newText(newLabel)}
              </button>
            )}
          </>
        }
      />

      <div className="page stack">
        {fromReport.report_from && (
          <Alert tone="info">
            <span>
              {reportBannerText(fromReport, total)}{' '}
              <Link to={pathname}>Show all {title.toLowerCase()}</Link>
            </span>
          </Alert>
        )}
        {typeof banner === 'function' ? banner(rows) : banner}

        <Card flush>
          <SavedViews
            resource={resource}
            filters={filterValues}
            search={debouncedSearch}
            onApply={(saved) => {
              const { q, ...rest } = saved || {};
              setSearch(q || '');
              setFilterValues(rest);
            }}
          />
          <div className="toolbar">
            <div className="search">
              <Search className="search__icon size-4" strokeWidth={1.75} aria-hidden="true" />
              <input
                className="input"
                type="search"
                aria-label={`Search ${title.toLowerCase()}`}
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {(showMore ? filters : filters.slice(0, INLINE)).map((filter) => (
              <FilterSelect key={filter.name} filter={filter} value={filterValues[filter.name] || ''} onChange={(v) => setFilter(filter.name, v)} />
            ))}

            {extra.length > 0 && extraSet === 0 && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-expanded={showMore}
                onClick={() => setMoreOpen((open) => !open)}
              >
                <SlidersHorizontal className="size-4" strokeWidth={1.75} aria-hidden="true" />
                {showMore ? 'Fewer filters' : `More filters (${extra.length})`}
              </button>
            )}

            {/* A date range arrives only from a report link, so show it and let it be removed. */}
            {(filterValues.from || filterValues.to) && (
              <span className="small nowrap">
                {dateFilterLabel}: {filterValues.from ? date(filterValues.from) : 'start'} – {filterValues.to ? date(filterValues.to) : 'today'}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label="Remove date filter"
                  onClick={() => setFilterValues(({ from, to, ...rest }) => rest)}
                >
                  <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            )}

            {filtering && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setSearch('');
                  setFilterValues({});
                }}
              >
                Clear
              </button>
            )}

            <div className="spacer" />
            <span className="small muted nowrap num" aria-live="polite">
              {loading ? 'Loading…' : rows.length === total ? `${total} ${total === 1 ? 'record' : 'records'}` : `${rows.length} of ${total}`}
            </span>
          </div>

          {error ? (
            <ErrorState message={error} onRetry={refetch} />
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
              empty={
                emptyState || (
                  <Empty
                    title={filtering ? 'Nothing matches those filters' : `No ${title.toLowerCase()} yet`}
                    text={
                      filtering
                        ? 'Try clearing the search or filters.'
                        : fields && `Each one you add shows here, with its status and what it waits on.`
                    }
                    action={
                      filtering ? (
                        <button type="button" className="btn" onClick={() => { setSearch(''); setFilterValues({}); }}>
                          Clear the filters
                        </button>
                      ) : fields && (
                        <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
                          <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
                          {newText(newLabel)}
                        </button>
                      )
                    }
                  />
                )
              }
            />
          )}
        </Card>
      </div>

      {editing && fields && (
        <RecordForm
          title={editing === 'new' ? `New ${formTitle || title}` : `Edit ${formTitle || title}`}
          subtitle={formSubtitle}
          intro={editing === 'new' ? formIntro : undefined}
          resource={resource}
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
          title="Delete this record?"
          message="This cannot be undone. Anything computed from it will update straight away."
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
          busy={busy}
        />
      )}
    </>
  );
}

/**
 * The header tick box: every row that may be picked, or none of them.
 *
 * "Mixed" is a DOM property rather than an attribute, so it is set through a
 * ref — without it a part-selected list reads as not selected at all, which
 * is the one state a reader most needs to see.
 */
function SelectAllBox({ rows, selection, label }) {
  const box = useRef(null);
  const offered = rows.filter((row) => selection.ids.has(row.id) || !selection.blockedReason?.(row));
  const picked = offered.filter((row) => selection.ids.has(row.id)).length;
  const all = offered.length > 0 && picked === offered.length;

  useEffect(() => {
    if (box.current) box.current.indeterminate = picked > 0 && !all;
  }, [picked, all]);

  return (
    <input
      ref={box}
      type="checkbox"
      className="size-4 accent-[var(--primary)] align-middle"
      checked={all}
      disabled={offered.length === 0}
      aria-label={label}
      onChange={() => selection.onToggleAll(rows)}
    />
  );
}

/** "New quotation": the verb and the thing, in sentence case. */
function newText(label) {
  return label ? `New ${label.charAt(0).toLowerCase()}${label.slice(1)}` : 'New';
}

/** One filter: a labelled dropdown whose blank choice reads "<Label>: all". */
function FilterSelect({ filter, value, onChange }) {
  return (
    <select
      className="select"
      aria-label={filter.label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{filter.label}: all</option>
      {filter.options.map((opt) => {
        const v = typeof opt === 'string' ? opt : opt.value;
        const label = typeof opt === 'string' ? opt : opt.label;
        return <option key={v} value={v}>{label}</option>;
      })}
    </select>
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
