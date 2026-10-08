# QuickDock

A floating glass pill at the bottom centre for the things people add all day.

## Use
- `.mg-dock` on `glass-strong`, fixed 24px above the bottom (plus the safe-area inset).
- The round `.mg-dock__add` (48px, `btn`) opens the full new-record menu; then up to three shortcuts by role (admin: Log a payment, Raise an invoice, New deal; HR: New trip, Log expense), a divider, and Search with its `Ctrl K` key.
- Floats in last on page load (`data-a="dock"`, 1s delay).
- On a phone it shrinks to the + and Search only.
