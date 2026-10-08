# IconRail

The desktop navigation: an 84px glass rail with the bean logo, icon buttons and a coffee-drop marker on the current page.

## Anatomy
- `.mg-rail.mg-glass`, radius `radius-rail` (30). Logo on top, `.mg-rail__nav` in the middle, theme switch and avatar at the foot.
- Icon buttons are 48px, 56px apart, `on-pill-idle` at rest and `on-pill` when current (`aria-current="page"`).
- `.mg-drop`: the `pill` coffee-drop shape. It moves on the Brew spring over 700ms with `MochaGlass.drop(rail, i)`. No extra squish, no rigid slide.
- Pressing an icon gives the jelly (540ms).
- Hover shows `.mg-tip`, a glass name tooltip with the count; `MochaGlass.tip(rail, i, html)`.
- Counts on icons use `.mg-count`.

## Phone and tablet
Below 1024px the rail becomes a bottom bar (see the shell wave); same icons, same drop marker turned sideways.
