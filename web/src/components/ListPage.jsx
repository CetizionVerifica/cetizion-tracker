import { useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Card, DataTable, Empty, ErrorState, ConfirmDialog, useToast } from './ui.jsx';
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
  const [urlParams] = useSearchParams();

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
  const urlSearch = urlParams.get('q') || '';

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
