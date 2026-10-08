# Dialog

Dialogs hold one task: a short form, or a confirm.

## Use
- `.mg-dialog` in strong glass, radius 28, 560px wide (720 for wide forms), over `.mg-scrim` (blur 6).
- Head: the title says the task ("Record payment"), the subtitle says what it is about and the key number. Close button top right; Esc closes.
- Body: fields in `.mg-grid2`. Footer: Cancel (ghost) then the primary, which repeats the title's verb.
- Confirms are the same dialog with one sentence on what will happen and a danger button for irreversible actions ("Delete deal").
- Opening: rise from 12px with blur on the soft spring; closing is instant.
- On a phone, dialogs become a Sheet.
