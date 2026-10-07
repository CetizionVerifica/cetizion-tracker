import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
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
          width: 110,
          render: (row) => (
            <div className="table__actions">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(row)}>
                Edit
              </button>
              {mayDelete && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDeleting(row)}>
                  ✕
                </button>
              )}
            </div>
          ),
        },
      ]
    : sortable;

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {extraActions}
            <a className="btn" href={api.exportUrl(resource, params)} download title="What the list shows now, with the same search and filters">
              Export CSV
            </a>
            <a className="btn" href={api.exportXlsxUrl(resource, params)} download title="What the list shows now, as an Excel workbook">
              Export Excel
            </a>
            {fields && (
              <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
                + {newLabel || 'New'}
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
              <span className="search__icon">⌕</span>
              <input
                className="input"
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {filters.map((filter) => (
              <select
                key={filter.name}
                className="select"
                value={filterValues[filter.name] || ''}
                onChange={(e) => setFilter(filter.name, e.target.value)}
              >
                <option value="">{filter.label}: all</option>
                {filter.options.map((opt) => {
                  const value = typeof opt === 'string' ? opt : opt.value;
                  const label = typeof opt === 'string' ? opt : opt.label;
                  return <option key={value} value={value}>{label}</option>;
                })}
              </select>
            ))}

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
                  ✕
                </button>
              </span>
            )}

            {(search || Object.keys(filterValues).length > 0) && (
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
            <span className="small muted nowrap">
              {loading ? 'Loading…' : `${rows.length} of ${total}`}
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
                    title={search || Object.keys(filterValues).length ? 'Nothing matches those filters' : `No ${title.toLowerCase()} yet`}
                    text={
                      search || Object.keys(filterValues).length
                        ? 'Try clearing the search or filters.'
                        : fields && 'Add the first one to get started.'
                    }
                    action={
                      fields && !search && (
                        <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
                          + {newLabel || 'New'}
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
