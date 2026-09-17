import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Card, DataTable, Empty, ErrorState, ConfirmDialog, useToast } from './ui.jsx';
import { RecordForm } from './RecordForm.jsx';
import { api } from '../lib/api.js';
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
  canDelete = true,
  banner,
}) {
  const toast = useToast();
  const [search, setSearch] = useState(initialSearch || '');
  // Arriving from a dashboard tile pre-selects the matching filter, so the
  // dropdown shows why the list is short.
  const [filterValues, setFilterValues] = useState(() => initialFilters || {});
  const [editing, setEditing] = useState(null); // record | 'new' | null
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const debouncedSearch = useDebounced(search);
  const params = { q: debouncedSearch, ...filterValues };
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

  const tableColumns = rowActions
    ? [
        ...columns,
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
              {canDelete && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDeleting(row)}>
                  ✕
                </button>
              )}
            </div>
          ),
        },
      ]
    : columns;

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
        {banner}

        <Card flush>
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
