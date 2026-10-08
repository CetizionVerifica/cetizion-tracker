# FilePicker

File fields are a drop zone, never the browser's bare "Choose file" control.

## Use
- `<label class="mg-file">` holds an icon, `.mg-file__text` saying what to drop ("Drop a PDF here"), a `.mg-btn mg-btn--sm` saying "Choose a file", and the real `<input type="file">`, which covers the zone invisibly so a click or a drop anywhere on it works.
- States: hover and focus give a caramel border (focus adds the `wait-soft` ring); **dragging a file over** turns the border solid caramel on a `wait-soft` ground with a small jelly (`.is-drag`); **chosen** shows the file's name and size on strong glass with a sage tick and the button saying "Change" (`.has-file`, `data-file`); **uploading** shows `.mg-file__file` with a hatched caramel bar (`.mg-file__bar`); **error** (`.is-error` on the field) says what went wrong and what to do.
- `pickers.js` adds `.is-drag` and `.has-file` by itself on canvases, so any zone shows the file you choose.
- The window that lists your files is the operating system's own; no page can restyle it.
