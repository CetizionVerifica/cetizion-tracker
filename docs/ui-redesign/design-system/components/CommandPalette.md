# CommandPalette

Ctrl K opens one search box for every record and every action the person may take.

## Use
- A `glass-strong` panel, radius 28, 640px wide, over the scrim.
- Results are grouped (`.mg-palette__group`): records first, then actions ("Do"). The highlighted row has `aria-selected="true"` and a `track` fill.
- Keyboard first: arrows move, Enter opens, Esc closes. Results update as you type; nothing animates while typing.
- An action that needs details opens its step form in the same panel (see Sheet for steps).
