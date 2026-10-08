# Mocha Glass

The design system for the Cetizion tracker redesign. Warm glass panels float over a coffee-lit canvas; motion is smooth and a little jiggly where people look, and absent where they work. It is copied exactly from the approved Claude Design canvas **"Mocha mix · Glass 2"** (approved 7 Oct 2026). Nothing here drifts from that canvas without the product owner's OK.

Every screen canvas in the redesign is built from this system only: no new colours, fonts or one-off components. A new component is added here first.

## Content fundamentals

The tracker is a work tool for a small sales, billing and travel team, and for their clients in the portal. Write the way a careful colleague talks.

- **Plain words, the user's side of the screen.** "Record payment", not "Create receipt entity". "Waiting on you", not "Pending items".
- **Say what is true, then what to do.** Empty: "Nothing is waiting." Error: "Couldn't load collections. Try again." Blocked: "Only ₹80,000 is outstanding on this invoice."
- **Buttons say what happens**, and the toast repeats it: "Record payment" → "Payment recorded".
- **Numbers are Indian.** Rupees as ₹18,42,500 (en-IN grouping), lakhs and crores in chart axes (₹20L), dates as 6 Oct or Tuesday, 6 October.
- **Sentence case** everywhere except small uppercase labels (`label`, `label-sm`).
- Greeting on Today only: "Good morning, Demo", with one line on what needs attention.

## Visual foundations

**Colour.** The canvas (`canvas`) carries four slow-drifting blobs (`b1`–`b4`) and a film grain. On it sit glass panels (`glass`, `glass-strong`) with an edge (`glass-edge`), a top highlight (`glass-hi`) and a sheen (`sheen`). One dark tinted hero (`hero-glass`, `hero-glow`) per screen carries the headline number.
- Accent: `caramel` (fills) and `caramel-text` (text) for expected money, counts, focus and the greeting's key word.
- Secondary fills: `latte`. Calm events: `sage`.
- States, the only four: `late`, `wait`, `ok`, `info`, each with a `-soft` ground. A state is always said in words too.
- Money in is `figure`; money expected is caramel and **hatched** everywhere (bars, progress, the draft segment).
- Light and dark are designed together; both are complete. Dark is near-black espresso with an ember glow.

**Type.** Fraunces for greetings and page titles only; Plus Jakarta Sans for everything else, every figure in tabular numerals. Scale: 11–12px caps labels, 12.5–13.5px body, 15px section titles, 32px tile figures, 62px hero figure. Both faces have the ₹ sign.

**Shape and space.** A 4px grid. Panels radius 26, the hero 28, the rail 30, controls 14, pills 999. Controls 36 / 44 / 48px. Panels pad 22–24px and sit 18–20px apart.

**Glass recipe.** `linear-gradient(180deg, var(--sheen) 0%, transparent 42%), var(--glass)`, `backdrop-filter: blur(28px) saturate(165%)`, 1px `glass-edge`, `inset 0 1px 0 var(--glass-hi)`, `0 30px 60px -38px var(--shade)`. Use `glass-strong` wherever text is read at length (tables, dialogs, forms, menus).

**Motion** (see the Motion card). Entrance once per page view; no cursor ripple (removed 8 Oct); the rail's coffee-drop marker on the Brew spring (700ms); a jelly press on primary buttons and rail icons; count-ups that never overshoot; bars that grow, lines that draw. Typing, keyboard, sorting, filtering and tables stay instant. A pause button and reduced motion stop everything.

**Layout.** Desktop: the 84px icon rail on the left, the page on the right with its header and glass control bar, the quick-add dock floating bottom centre. Phone (390): a bottom bar instead of the rail, rows instead of tables, sheets instead of dialogs, 16px gutters.

## Iconography

Lucide line icons (the app already uses `lucide-react`), on the 24 grid at stroke 1.8 with round caps and joins, sized 20 in the rail, 18 in the control bar, 16 in buttons. They take `currentColor`. The brand mark is the coffee bean drawn in the rail (`btn` with a `caramel` crease); there is no other logo. No emoji anywhere.

## Using it

- Load `tokens.css`, then `components/bundle.css` (it pulls both Google fonts), then `components/bundle.js` (it includes the pickers). A canvas that does not load `bundle.js` loads `components/pickers.js` after `bundle.css`, so date fields open the Mocha Glass calendar. Put `class="mg"` on the app root and `mg-scene` on the page ground.
- Components are CSS classes prefixed `mg-`; each card here shows the markup and states.
- `window.MochaGlass` adds the motion: presses wire themselves; call `MochaGlass.enter(root)` once per page view, `MochaGlass.drop(rail, i)` for the rail, `MochaGlass.seg(el, i)` for segmented controls, `MochaGlass.pause()` for the pause button. `<i data-icon="name">` becomes a Lucide icon.
- Theme: `data-theme="light"` or `"dark"` on `<html>`.
