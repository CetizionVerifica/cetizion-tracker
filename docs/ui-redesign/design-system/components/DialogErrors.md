# DialogErrors

How every form dialog and record form shows a save that failed.

## Use
- The dialog stays open with what was typed. A `.mg-banner--late` with `role="alert"` at the top of `.mg-dialog__body` says what happened and that nothing was saved: "Couldn't record the payment. Two fields need a look."
- Each field the server refused gets `.is-error` on its `.mg-field`, `aria-invalid="true"`, and a `.mg-field__error` saying what to fix, in words, with the real numbers ("Only ₹1,80,000 is outstanding on this invoice.").
- A failure that isn't about a field (network, permission) has only the banner, with "Try again" in the footer in place of the primary label.
- While saving: the primary button says what it is doing ("Recording…") and both buttons are disabled.
- Focus moves to the banner; the first refused field is next in the tab order.
