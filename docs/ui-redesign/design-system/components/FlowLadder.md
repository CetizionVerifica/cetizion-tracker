# FlowLadder

One record's steps in order: a quotation (quoted → accepted → PO → invoiced → collected), a PO's stages, a project's headline steps. One look everywhere.

## Use
- `<ol class="mg-ladder">` of `.mg-ladder__step`, each a `.mg-ladder__disc` and `.mg-ladder__text` (`.mg-ladder__label`, `.mg-ladder__note` with the date, who, or what is missing).
- States: `.is-done` (coffee disc with a tick), `.is-current` (caramel ring with a soft halo, `aria-current="step"`), `.is-blocked` (late ring with "!", the note says why in words), and next (quiet, numbered). Connectors fill in up to the current step.
- On a phone the ladder stacks into a column with the words beside each disc.
- The verdict sentence ("Ordered across 2 POs; ₹3,40,000 still to bill") sits under the ladder, not inside it.
