# Combobox

A text field with suggestions: type to narrow the list, or pick. Used where the value may be new (Client, Sector, Service asked for, Also on, the task's For).

## Use
- A native `<input class="mg-input" list="id">` with a `<datalist id>` of `<option value label>`. `pickers.js` (also in `bundle.js`) replaces the browser's suggestion list with a glass list under the field (`.mg-list`), and the field gets a chevron.
- Typing filters by the value and its label; the matching part is shown in caramel. The current value is the coffee pill.
- When the typed text is not in the list, the last row offers it: "Use “X”", or the field's `data-new-label` ("Add as a new company:"). `data-new="no"` turns that off, for fields that must match.
- Keys: Down/Up move, Enter picks, Escape closes. Typing stays instant; the list never takes focus from the field.
- The list is strong glass in the top layer, never glass inside glass; it opens below the field, or above it when there is no room.
