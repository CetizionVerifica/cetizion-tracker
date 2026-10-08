# Motion

Motion is smooth and a little jiggly where people look, and absent where they work.

## The motions (all from Glass 2)
- **Arrival**, on every route change (the shell calls `MochaGlass.arrive(main)`; query changes such as filters don't count): sections with `data-a="rise"` (up to 8) rise 14px on the soft spring, 55ms apart; the first 10 rows fade up 6px, 28ms apart; progress bars fill; figures count up. It catches content that lands with its data for 1.2s, then stops, so re-renders, sorting and filtering stay instant. Each element animates once.
- **Entrance** (first view of a record page, `enter(root)`): sections rise 22px from blur(10px), staggered 75ms, on the soft spring (peak ≈1.056). `MochaGlass.enter(root)` with `data-a="rise"`.
- **No cursor ripple.** removed on 8 Oct: glass surfaces do nothing when the cursor enters them.
- **Rail drop**: 700ms on the Brew spring. No squish on the marker.
- **Jelly** (primary buttons, rail icons, the dock +): scale (1.1,.88) → (.94,1.06) → (1.02,.99) → 1, 540ms. **Press** (other buttons, chips, tabs, segments, calendar cells): a quick dip to scale .97 (80ms) that springs back on release (`scale` on the soft spring, so it never fights a transform or the jelly). Rows and menu items never scale.
- **Figures** count up over 1.5s and never overshoot. **Charts**: bars grow with 6% overshoot, lines draw, areas sweep.
- **Ambient**: blobs drift on 20s+ loops; the progress shimmer every 3.2s.

- **Pop-ups** (menus, dropdowns, panels): unfold from the control that opened them. Scale .9 → 1 with a blur(8px) → 0 on the soft spring, 480ms, origin at the control (`.mg-pop` with `--pop-origin`, `--pop-x`, `--pop-y`); their rows slide up 6px one after another (20ms apart). Dialogs rise 18px out of a blur (560ms) over a fading scrim; Ctrl K drops 16px from above; phone sheets slide up on the Brew spring; toasts pop up with a little overshoot. Closing is quick: 160ms fade and scale .97.
- **Theme shockwave**: switching to dark spreads the dark page out of the mode button inside a growing circle, with a glowing caramel ring (`wave`) riding its edge (1400ms at an even pace: a gentle start so it visibly leaves the button, a soft finish, always past the farthest corner). Switching to light pulls the dark page back into the button, the ring closing in at the same even pace (1300ms), and the button jellies as it absorbs it. `MochaGlass.switchTheme(next, button, apply)`, built on View Transitions; reduced motion or an older browser switches instantly.

- **Feel** (timings: `--mg-fast` 140ms, `--mg-med` 220ms, `--mg-slow` 360ms): hovers ease in fast and out slower; the caramel focus ring draws in; linked cards lift 2px; arrows and chevrons nudge; tab underlines, the segment thumb, the rail drop, the settings mark and the phone tab-bar drop glide between options; counts bump when they change; switches, ticks and toasts spring. The rail tooltip waits 250ms of intent, then glides between icons. Scroll areas show their thin thumb fading in on hover and out after. The blobs hold still while the page scrolls.

## Rules
- Repeated work stays instant: typing, keyboard (menus and lists skip their highlight fade while keys drive them), sorting, filtering, the invoice run, amounts in tables.
- The pause button (`MochaGlass.pause()`) and `prefers-reduced-motion` stop all of it.
