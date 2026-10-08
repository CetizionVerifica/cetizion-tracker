# DataTable

Tables list records on desktop and tablet; they sit on strong glass and stay instant.

## Use
- Wrap in `.mg-glass.mg-glass--strong.mg-tablewrap` (scrolls sideways inside itself, never the page).
- Header cells: 11px caps `text2`, sticky. Sortable headers carry `aria-sort`.
- Rows 52px with `line` dividers, `track` on hover, `wait-soft` when selected.
- `.num` right-aligns money and dates in tabular figures. `.sub` adds a second line in `muted`.
- State goes in a badge column, actions in the last column (`.actions`), at most one primary per row.
- Totals go in `tfoot`.
- Sorting, filtering and paging are instant: no entrance or ripple inside a table.
- On a phone, use RowList instead.
