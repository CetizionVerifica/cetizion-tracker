# States

Every list and panel has three extra states: empty, loading and failed.

## Use
- Empty (`.mg-empty`): a round mark, a title that says what is true ("Nothing is waiting"), one line on what fills it, and the action that adds the first one if there is one.
- Loading: `.mg-skel` bars in the shape of the content, shimmering. Never a spinner for a whole page.
- Error: the same layout in `late`, saying what failed and offering Try again. A failed load is never shown as empty.
