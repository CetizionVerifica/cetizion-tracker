# DatePicker

Every date, month, date-and-time and time field opens the Mocha Glass calendar, never the browser's own picker.

## Use
- Keep the native input (`<input class="mg-input" type="date">`, `month`, `datetime-local`, `time`) inside `.mg`. `pickers.js` (also inside `bundle.js`) hides the browser's picker and opens `.mg-cal` instead; the field shows a calendar or clock icon on the right.
- Opens on a click anywhere in the field, or Alt+Down, F4 or Space from the keyboard. Typing the date into the field still works and stays instant; the calendar follows what is typed.
- The calendar is strong glass in the top layer (never glass inside glass), placed under the field, or above it when there is no room. It unfolds from the field like every pop-up and closes on Escape, a click outside, or a pick.
- **Days**: the week starts on Sunday (en-IN). Today has a caramel ring; the chosen day is the coffee pill and pops in; days outside `min`/`max` are struck through and can't be picked. The month name opens a month grid; arrows page months (years in the month grid).
- **Month** fields open the month grid. **Date and time** shows the days with a 15-minute time list beside them, and a Done button. **Time** fields show the time list alone.
- Footer: Today (This month, Now) and Clear (not on required fields).
- Keyboard: arrows move a day (a week up and down), Page Up/Down a month, Home/End the week, Enter picks, Escape closes and returns to the field.
- Light and dark follow the page's theme. Reduced motion and the pause button stop the motion.

## In code
A React component with the same look and keys (for example react-day-picker styled with these classes), not the browser's picker.
