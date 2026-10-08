# Menu

The items inside any pop-up menu: More actions on a record, the row ⋯ menu, the account menu, the New menu.

## Use
- `.mg-menu` on a strong-glass panel (`mg-glass mg-glass--strong`), opened as a pop-up (`.mg-pop` with `--pop-origin` at the button that opened it). Never inside another glass panel: it is a sibling of what it opens from.
- `.mg-menu__item` rows are 40px (44px on a phone), a 16px icon in `text2`, words that say what happens; `small` on the right for a shortcut or why it is off. `.mg-menu__item--danger` for removing or losing things, last, after a `.mg-menu__sep`.
- `.mg-menu__label` heads a group in small caps. Disabled items stay in place and say why.
- Keys: arrows move, Enter picks, Escape closes and returns focus to the button.
