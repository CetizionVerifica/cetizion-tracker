# Button

Buttons are fully rounded pills; one primary per view.

## Variants
- `.mg-btn--primary`: `btn` fill, `on-btn` text, a `glow` shadow. The one main action in a page header, dialog or card. Presses with the jelly.
- `.mg-btn` (secondary): `glass-strong` with a `glass-edge` border. Other actions.
- `.mg-btn--ghost`: no fill until hover (`track`). Cancel, quiet actions.
- `.mg-btn--danger`: `late` fill, `on-late` text. Only for irreversible actions, and only inside a confirm.
- `.mg-btn--icon`: square to its height, needs an `aria-label`.

## Sizes and states
- Heights 36 (`--sm`), 44 (default), 48 (`--lg`, phone primary).
- `:disabled` fades to 45%; `.is-loading` hides the label and spins; keep the width.
- Labels say what happens: "Record payment", then the toast "Payment recorded".
