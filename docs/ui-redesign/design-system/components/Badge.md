# Badge

Badges carry state; chips filter; counts sit on icons and tabs.

## State tones (the only four)
- `--late` (`late` on `late-soft`): overdue, failed, rejected.
- `--wait` (`wait` on `wait-soft`): waiting, ready to bill, due soon.
- `--ok` (`ok` on `ok-soft`): paid, won, done.
- `--info` (`info` on `info-soft`): to review, information.
- No modifier: neutral (`text2` on `track`) for drafts and closed things.

A badge says the state in words ("12 days late"), never colour alone. `caramel` and `sage` are not states.

## Chips, counts, avatars
- `.mg-chip` toggles a filter; `aria-pressed="true"` fills it with `pill`.
- `.mg-count`: `caramel` with `on-caramel`, 18px, for counts on rail icons, tabs and the bell.
- `.mg-avatar`: initials on `latte`.
