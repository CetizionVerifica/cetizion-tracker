# Hero

The hero is the one dark, tinted card per screen that carries its headline number.

## Use
- One per screen at most, at the top: Today's collected money, a PO's value, a report's total.
- `hero-glass` fill with the `hero-glow` ember in the top-right corner, `hero-edge` border, radius `radius-hero` (28). Dark in both themes; text uses `on-hero` and `on-hero-2`.
- A soft spotlight follows the cursor (`--mx`/`--my`, set by the bundle).
- The figure is `hero-figure` (62/700, −.045em) and counts up over 1.5s with `data-count`; it never overshoots.
- The progress bar: solid `on-hero` for money in, a hatched band for money expected, and a shimmer every 3.2s.
