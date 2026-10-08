# Chart

Charts draw money in `figure`, expected money hatched in `caramel`, and labels in `muted`.

## Use
- Inline SVG with `.mg-chart`; gridlines `line`, labels `muted` 11px, every label a value the scale reaches.
- Bars: `figure` (`.bar`), quiet series `latte` (`.bar-soft`), radius 10 on top. Expected or not-yet-ready money is the caramel hatch pattern.
- Lines: `figure` 2.2px with an emphasised end point; an expected line is dashed `caramel`. Areas fill `track`.
- Motion, once: bars grow with a 6% overshoot (`data-a="grow"`), lines draw (`draw`), areas sweep (`sweep`).
- Always a legend or direct labels; never colour alone.
