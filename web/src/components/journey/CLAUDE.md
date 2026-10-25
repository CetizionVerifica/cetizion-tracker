# Web layer: the sales journey

Module layer under the feature spec
[`docs/specs/sales-journey/CLAUDE.md`](../../../../docs/specs/sales-journey/CLAUDE.md)
and the UI rule book [`web/CLAUDE.md`](../../../CLAUDE.md). Read both first.
`web/CLAUDE.md` wins on anything visual (tokens, type, layout, components,
writing, accessibility); this file only adds what is specific to the journey.

The server contract is
[`server/src/lib/journey/CLAUDE.md`](../../../../server/src/lib/journey/CLAUDE.md)
§5. Build against that shape; do not wait for the server, and do not reshape
data the server already shaped. Never compute a step, a small step, days in
step, a flag or a next action in the browser: show what the server returns
(`web/CLAUDE.md` §2.3).

## 1. Where things live

| Piece | File | Stream |
| --- | --- | --- |
| API calls and link helpers | `web/src/lib/journey.js` | R |
| Rail primitives, extended (backwards compatible: Trip keeps working unchanged) | `web/src/components/record.jsx` (`FlowStep`, `RecordFlow`) | R |
| The journey rail for one record | `web/src/components/journey/JourneyRail.jsx` | R |
| Rail on record pages | `pages/QuotationDetail.jsx`, `pages/PurchaseOrderDetail.jsx`, `pages/ProjectDetail.jsx` | R |
| Enquiry page | `pages/EnquiryDetail.jsx`, route `/enquiries/:key` in `App.jsx`, links from `pages/Enquiries.jsx` | E |
| Journey board (the Pipeline's default view) | `components/journey/JourneyBoard.jsx`, switch in `pages/Pipeline.jsx` | B |
| Step drawer | `components/journey/JourneyDrawer.jsx` | B |
| Rule-book pins | `web/test/uiConsistency.test.js`, `web/CLAUDE.md` §4 | R |
| Unit tests | `web/test/journey.test.js` (R: `lib/journey.js`), `web/test/journeyBoard.test.js` (B: pure helpers) | R, B |

## 2. Contracts between the web streams

### `lib/journey.js` (R)

```js
export const JOURNEY_STEPS = [
  { key: 'enquiry', label: 'Enquiry' },
  { key: 'quotation', label: 'Quotation' },
  { key: 'po', label: 'PO' },
];
export function journeyBoard(params) {}      // GET /api/journey?…  → data (qs drops empty values)
export function journeyOf(of) {}            // of = { enquiry } | { quotation } | { po } | { project } → GET /api/journey/of → data
export function recordPath(kind, no) {}     // 'enquiry' → `/enquiries/${encodeURIComponent(no)}`,
                                            // 'quotation' → `/quotations/${…}`, 'po' → `/purchase-orders/${…}`,
                                            // 'project' → `/projects/${…}`; null for a missing number
export function currentRecordPath(card) {}  // the record of card.step, from card.records (spec C4)
```

Use `api.raw` from `lib/api.js`; never build `/api` URLs elsewhere.

### `record.jsx` extensions (R)

All new props optional; a call with today's props renders exactly as today.

- `FlowStep` gains `to` (renders the step as a `Link`, focusable, with the
  hover surface), `meta` (a muted line under the label, e.g. the record
  number and date), `badge` (a `Chip` beside the label, e.g. days in step
  with its tone), `peek` (content for a `Tooltip` shown on hover and focus).
  States gain `skipped` (hollow, like future, label reads "Not recorded" in
  `meta`) and `exit` (filled `late` with a `!` glyph, sr-only "stopped
  here").
- `RecordFlow` gains `substeps` (`{ label: 'Inside Quotation', steps: [{ label, state, date }] }`),
  drawn as a slim row under the rail, aligned under the current step on wide
  screens, full width on narrow ones; and `nowLabel` to override the
  "Now · <step>" eyebrow (e.g. "Now · Quotation · Accepted").

### `JourneyRail` (R; used by E)

```jsx
<JourneyRail
  of={{ quotation: q.quotation_no }}   // or { enquiry }, { po }, { project }
  verdict={…} actions={…} note={…}     // the page's own sentence, buttons and small print, passed through
  refreshKey={…}                       // change it to refetch after the page acts
/>
```

- Fetches `journeyOf(of)` and renders `<RecordFlow>` with the three big
  steps: done → `to` its record, `meta` "<no> · <date>", `peek` its first
  three facts; current → `badge` days in step (tone from `flag.tone`, plain
  when no flag), plus `substeps` of the current step; exited → `exit` state
  and the eyebrow says "Lost at Quotation" / "Unqualified at Enquiry"; paid
  → all done, eyebrow "Complete · paid".
- Loading: a `Skeleton` of the rail's height, verdict and actions already
  shown. Error: the verdict and actions still show, with one muted line
  "The journey for this record could not be loaded." and a retry. 404 is an
  answer, not a failure: "This record is not part of a sale yet.", no
  retry. The page never loses its primary button because the journey
  failed.
- A step with `reachable: false` (a record the viewer does not own) shows
  its number and date but is not a link and has no preview.
- The PO page asks by `{ po }`, or by its quotation or project when the PO
  is cancelled or replaced (those are in no journey).
- On a phone the rail scrolls sideways with the current step centred, as
  `RecordFlow` already does.

### `JourneyDrawer` (B)

```jsx
<JourneyDrawer card={card} open={…} onOpenChange={…} />   // card from the board; fetches journeyOf for the full journey
```

- `Sheet` from the right (`components/ui/sheet.tsx`), 460px, full width on
  a phone. Header: client, service, value. A vertical rail of the three
  steps as buttons (`aria-pressed` on the open one); opening shows the
  current step. ↑/↓ move between steps, Esc closes and focus returns to
  the card.
- Body for the open step: its facts (formatted with `lib/format.js`), its
  small steps, and the record's `Timeline` (`entity`/`id` of that record)
  limited to what the component shows by default.
- Footer: on the current step, one primary button with `next.label`
  linking to `currentRecordPath(card)`; on any step with a record, **Open
  full page**. A step with no record says "Not recorded" and offers
  nothing. A step with `reachable: false` says someone else owns it, shows
  no timeline and offers no **Open full page**.

### `JourneyBoard` (B)

Rendered by `Pipeline.jsx` unless `?view=stages`. Reads and writes its
filters in the URL (`useSearchParams`): `sales_person`, `service`, `stuck`,
`closed`, `from`, `to`, `cohort`.

## 3. Screens

### Pipeline (B)

- `PageHeader` title stays "Pipeline"; subtitle "Every open sale from
  enquiry to paid PO. The button on a card moves it on." A two-option
  switch (`Tabs`) **Journey | Quotation stages** sits in the header
  actions with the owner select. Quotation stages is today's board,
  untouched; keep its code, moved into its own function in the same file.
- Toolbar: period (Last 30 / 90 / 365 days, or This financial year:
  April to March), owner, service, **Stuck only** toggle with its count
  (the server's `stuck_count`, the same with the switch on or off),
  **Show closed** toggle.
- Funnel strip: four figures, Started, Quoted, Won, With PO, each a button
  that sets `cohort`; a conversion chip between figures ("74% quoted")
  computed from the server's counts (division only). An active cohort shows
  as a removable chip ("Showing: quoted in the last 90 days ×").
- Three columns: label, count, `money(value_inr, 'INR', { compact: true })`,
  "median N days here"; `without_rate` > 0 says how many were left out and
  where to add the rate, as the stage board does.
- Card (a `button` opening the drawer): client, owner initials, service,
  value in its own currency, the flag chip or plain days, a three-segment
  progress mark (`progress`, `aria-hidden`, the small step as text beside
  it), and the next action as a link to `currentRecordPath(card)` that does
  not open the drawer. Exited cards (only with Show closed or a cohort)
  show the exit as a `late` chip ("Lost", "Unqualified") or `settled`
  ("Paid").
- Empty column: "No sales at <step>." with nothing to click. Empty board:
  says what will appear and links to New enquiry. Loading: three skeleton
  columns. Error: `ErrorState` with retry.
- Below `lg`: `Tabs` Enquiry / Quotation / PO with counts, one column at a
  time; the funnel wraps to two by two.

### Enquiry page (E)

- `RecordPage` with parent "Enquiries" (`/enquiries`), title
  "<client> · <service>" (or the client alone), facts: received date,
  source, status chip, owner.
- `flow`: `<JourneyRail of={{ enquiry: e.enquiry_no }} …>` with the page's
  own sentence and one primary button: status Qualified → **Convert to
  quotation**, which opens the existing enquiry form with status set to
  Converted (the server creates the draft quotation, as from the list);
  otherwise **Log a call** (`TouchDialog` from `Timeline.jsx`). Once a
  quotation exists the button is **Open the quotation**. Edit and the rest
  are in the ⋯ menu.
- Body: "About the enquiry" (contact, services interested, estimated value,
  sector, country, next follow-up, notes), the `QuestionnaireCard` content
  or a link to open it as the list does, `EmailOrigin` for the enquiry,
  and the `Timeline` at the end of the body (as on the other record pages,
  `web/CLAUDE.md` §4 item 5).
- Load with the generic resource route by `enquiry_no`
  (`api.get('enquiries', key)`); check `lib/crud.js` reads `naturalKey`.
  404 → `NotFound`.
- Do not copy the enquiry form's field list: it lives in
  `lib/enquiries.js` (`enquiryFields`) and both pages use it.

## 4. Rules specific to this feature

- Three big steps, labelled exactly Enquiry, Quotation, PO, everywhere.
- Every link to an enquiry, quotation or PO uses `recordPath` (numbers have
  slashes and spaces). The questionnaire link in `QuotationAnswers.jsx`
  still opens the list (`/enquiries?q=…&questionnaire=1`), because the
  list is where that dialog lives; server emails (`notify`, `followUps`)
  still link to the list's search too.
- Status is word + tone + glyph: `late` for overdue and stuck, `waiting` for
  slow, unsent, approval and price, `info` for nurturing, `settled` for
  done. Use `Chip`/`Badge`, never a hand-rolled pill.
- One primary button per view: on the board there is none in the header;
  each card's next action is a text link styled as one, not a `default`
  button.
- No drag on the Journey board.
- Money with `lib/format.js`; another currency is named; a missing value
  reads "No estimate" or "No value", never ₹0.

## 5. Tests

- `web/test/journey.test.js`: `recordPath` encodes slashes and spaces and
  returns null for a missing number; `currentRecordPath` per step.
- `web/test/journeyBoard.test.js`: the funnel's conversion percentages
  (zero denominators), filter ⇄ URL round trip, cohort chip text, a step
  open unless the server says `reachable: false`.
- `web/test/uiConsistency.test.js`: Enquiry, Quotation, PO and Project pages render
  `<JourneyRail`; `JourneyRail.jsx` renders `<RecordFlow`; Trip keeps
  `<RecordFlow` and `flowSteps(`; `JOURNEY_STEPS` labels are exactly
  Enquiry, Quotation, PO.
- One Playwright flow in `web/e2e/` if the demo data supports it: Pipeline
  opens on Journey with three columns; a card opens the drawer; Open full
  page reaches the record whose rail shows the same step.
- `npm test`, `npm run typecheck`, `npm run build` in `web/`; light and
  dark at 1440 and 390.
