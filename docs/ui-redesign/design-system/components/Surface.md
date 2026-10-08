# Surface

Glass is the only surface: the canvas with its drifting blobs and grain underneath, glass panels on top.

## Use
- `.mg-scene` on the page wrapper paints `canvas`, four blurred blobs (`b1`–`b4`, 20s+ drift) and the grain (5% light, 8% dark). The bundle adds the blobs and grain itself.
- `.mg-glass` is every panel and card: the `sheen` gradient over `glass`, a `glass-edge` border, a `glass-hi` inset highlight and a `shade` shadow. Radius `radius-panel` (26).
- `.mg-glass--strong` swaps in `glass-strong` for anything read at length: tables, dialogs, menus, long text, forms.
- `.mg-panel` gives the standard padding (22/24) and a head row: `.mg-panel__title` (15px/700), a count, and actions pushed right.

## Rules
- A pop-over (menu, tooltip, dropdown, panel) is never placed inside another glass surface: a backdrop blur inside a backdrop blur cannot see the page, so the pop-over turns see-through. Render it as a sibling of the surface it opens from, or portal it to the page (the app's Radix pop-overs already do).
- Never put a glass panel directly on another glass panel; nest plain rows or `track` fills instead.
- Glass surfaces have no cursor ripple (removed 8 Oct).
- Text on glass: `text`, `text2`, `muted`. Never `muted` on bare canvas.
