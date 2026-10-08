# Field

Fields stack a label, the control, then a hint or an error.

## Use
- `.mg-field` wraps `.mg-field__label` (12.5/700; `.req` marks required), the control, and `.mg-field__hint` or `.mg-field__error`.
- Controls are 44px, radius `radius-control` (14), `glass-strong` fill and a `line` border. Focus: a `caramel` border with a `wait-soft` ring.
- `.mg-select` sits inside `.mg-select-wrap` for its chevron. Date, month, time and date-and-time fields are native inputs that open the Mocha Glass calendar (see DatePicker); files go in a drop zone (see FilePicker).
- Money: `.mg-affix` with a ₹ prefix and `.mg-input--money` (right-aligned, tabular). Show what is outstanding as the hint.
- Errors: `.is-error` on the field turns the border `late` and says what to fix, in words.
- Lay forms out with `.mg-grid2` (two columns that stack on a phone).
