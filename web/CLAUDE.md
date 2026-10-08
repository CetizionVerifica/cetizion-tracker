# Frontend UI guide

Read this before changing anything a user sees in `web/`. It is the rule book
for the redesign (the design brief and the mockups live in the project's
design files, outside this repository). The aim is one
product that is **consistent, clean, modern and easy to follow**: anyone should be
able to see where a piece of work is in the process and what to do next.

When a screen and this file disagree, this file wins. When this file is silent,
copy the nearest screen that already follows it rather than inventing a new pattern.

---

## 1. Tokens: the only source of colour, type and size

All colours live as CSS variables in `src/styles/globals.css` (`:root` for light,
`.dark` for dark) and are exposed to Tailwind as `bg-*`, `text-*`, `border-*`.

- **Never write a hex value, `rgb()` or a Tailwind palette colour** (`bg-blue-600`,
  `text-slate-500`) in a component. Use a token class (`bg-primary`, `text-muted-foreground`,
  `border-border`, `text-late`). Exceptions: third-party brand marks (the Microsoft and
  Google sign-in logos) and the Company profile preview, which mirrors the PDF.
- Need a colour that has no token? Add a token to both themes in `globals.css` and to
  the table below, in the same PR. Do not add a one-off.
- Light is the default theme; dark must work for every screen. Check both.

### Palette (light / dark)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#f8fafc` | `#0b1220` | Page ground |
| `card` | `#ffffff` | `#111a2b` | Cards, tables, dialogs |
| `foreground` | `#0f172a` | `#e2e8f0` | Headings, body text |
| `secondary-text` | `#334155` | `#cbd5e1` | Body copy that is not the main line |
| `muted-foreground` | `#475569` | `#94a3b8` | Meta, captions, table headers (never the only carrier of meaning) |
| `border` | `#e2e8f0` | `#1e293b` | Rules, card borders |
| `input` / `border-strong` | `#7c889a` / `#cbd5e1` | `#64748b` / `#334155` | Control borders (3:1) / stronger rules |
| `primary` | `#1d5fa8` | `#60a5fa` | **The only action colour**: primary buttons, links, active nav, focus ring |
| `secondary`, `muted`, `accent` | slate tints | slate shades | Secondary button fill, sunken wells, hover surface |
| `sidebar*` | navy `#0b1f33` | navy `#08172a` | The app sidebar, in both themes |

### Status: four tones, always word + colour

| Tone token | Light text | Means | Examples |
| --- | --- | --- | --- |
| `settled` | emerald `#047857` | Done, good | Paid, Approved, Won, Converted, Valid |
| `waiting` | amber `#b45309` | Needs attention soon | To Invoice, Due, Partially Paid, Submitted, Under Negotiation, Expiring |
| `late` | rose `#be123c` | Wrong or overdue | Overdue, Lost, Rejected, Failed, Disconnected, Expired |
| `info` | blue `#1d5fa8` | Information | Not Due, Draft, New, Contacted, On Hold, "Client confirmed" |
| `forecast` | slate `#94a3b8` | Not yet certain money | Forecast bars, weighted pipeline |

A chip is the tone at about 12% as its fill, the tone as its text, plus a word (and,
where it helps, a glyph: ✓ ◷ ! i). Never colour alone. Use the shared `Badge`
from `components/ui.jsx`; do not hand-roll chips.

### Type

| Role | Font | Size / weight | Tailwind |
| --- | --- | --- | --- |
| Page title | Plus Jakarta Sans (`font-display`) | 24px / 700 | `font-display text-2xl font-bold` |
| Section title | Plus Jakarta Sans | 16px / 700 | `font-display text-base font-bold` |
| Body | Inter (`font-sans`) | 14px / 400 | default |
| Table cells, meta | Inter | 13px / 400 | `text-[13px]` |
| Label, button | Inter | 13–14px / 600 | `font-semibold` |
| Key figure | Inter | 24–28px / 600, tabular | `text-2xl font-semibold num` |
| Eyebrow | Inter | 11px / 700, uppercase, 0.12em | `eyebrow` (class in globals.css) |

- Sentence case everywhere ("Raise invoice", not "Raise Invoice" or "RAISE INVOICE").
- Every number is tabular (`.num`). Money: ₹ with Indian grouping (₹5,90,000) via
  `lib/format.js`; another currency is named; GST shown as taxable / GST / total
  wherever a client sees money.
- Dates read "7 Oct 2026".

### Size, space, shape

- **Heights:** 32px control (`h-control`), 36px table row (`h-row`), 44px touch target
  (`h-touch`) on phone.
- **Spacing:** 4px grid. Gaps are 8, 12, 16, 24, 32. Page padding 24px (16px on phone).
  Card padding 16–24px.
- **Radius:** 6px small controls (`rounded-sm`), 8px buttons and inputs (`rounded-md`),
  12px cards (`rounded-lg`), 16px dialogs and sheets (`rounded-xl`), pill for status
  chips only. 2px and 4px only for tiny marks (a legend dot, a kbd). No other values.
- **Shadow:** none on cards at rest (a border is enough); `shadow-sm` on hover or on the
  one promoted card; `shadow-lg` for dialogs only.
- **Motion:** 120–180ms ease-out; nothing under `prefers-reduced-motion`.
- **Icons:** Lucide only, 16px in UI (`size-4`), stroke 1.75, `aria-hidden` when a label
  sits beside them. No emoji.

## 2. Layout rules

1. **One primary action per screen.** It is the only `primary` button on the page and
   sits beside the sentence that explains it. Everything else is secondary, ghost, or in
   the overflow menu (⋯).
2. **Say why.** A locked or disabled action explains itself in one sentence ("Unlocks
   when the project has a delivery date"). Never a bare disabled button.
3. **Never offer to type a derived value.** Status, outstanding, due date and stage
   amount are computed by the server. Show them; do not make them fields.
4. **Filters live in the URL**, so a link carries them: `ListPage` reads them from the
   address and writes them back as they change. Lists use `ListPage` and `SavedViews`;
   do not build a new list shell. A list shows search and its three most-used filters;
   the rest sit behind "More filters", which opens by itself when one of them is set.
5. **Every figure and chart opens the records behind it**, and every chart has a table twin.
6. **The next action sits on the row** (a won deal shows "Register").
7. **Empty, loading and error states** exist on every screen: an empty state says what
   will appear and offers the one action to start; loading uses `Skeleton`; errors say
   what failed in plain words with a retry.
8. **Reference-only columns never hold a task** (e.g. the right column of Today).
9. **Responsive:** design at 1280–1440 and check at 390. Sidebar becomes a drawer below
   `lg`; header actions wrap under the title; wide tables scroll inside their box.

## 3. App shell and navigation

- The sidebar is **dark navy in both themes** and grouped by the process, in this order:
  Today and Inbox; **Sell** (Enquiries, Deals, Pipeline, Renewals, Companies);
  **Deliver** (Projects, Schedule, Certificates); **Money** (Orders, Invoicing,
  Collections, Cash flow, and Accounting for admins); **Travel** (Trips, Expense claims);
  **Insights** (Insights, Reports); then **Pinned** saved views with counts.
  Groups collapse, and the choice is remembered per browser.
- HR sees its own sidebar: Travel dashboard; **Travel desk** (Trips, Vendor invoices,
  Payables); Pinned.
- **No company name or logo in the app.** The product is called "Sales Tracker" in the
  sidebar, the sign-in page, the client portal and the browser tab. Company details
  belong only where they are data (the quotation PDF, Company profile).
- Settings, My account, theme and sign out stay in the menu beside the person's name.
  ⌘K ("Search or do anything") is always one key away.
- A page's title is its sidebar name ("Deals", "Orders", "Invoicing"), so where you
  clicked and where you landed read the same. Breadcrumbs use the same name.
- Every page uses `PageHeader` (optional eyebrow, title, one-sentence subtitle, actions). Do not draw a
  custom header except where the screen genuinely needs one (Inbox).
- Adding a page: add its route in `App.jsx`, its sidebar entry in the right group (or
  none, if it is reached from a record), and a ⌘K entry in `lib/commands.js` if it has a verb.

## 4. Record pages and the process rail

Every record that moves through a process (enquiry, quotation, project, PO, payment stage,
trip) follows the same order, top to bottom:

1. Breadcrumb, then header: identity, status chip, owner, overflow menu.
2. **Process rail** (`RecordFlow` and `flowSteps` in `components/record.jsx`; never draw
   one by hand): the steps of its journey as numbered discs; done steps filled `settled`
   with a tick, the current step filled `primary` with a halo, later steps hollow and
   muted. The current step is the one after the furthest step reached, so a skipped step
   stays hollow instead of dragging the marker back. Under it, a "Now · <step>" eyebrow,
   **one sentence** saying what the current step waits on and who, and the one primary
   button that moves it on. Each step is read off a stored fact, never typed.
3. Key figures strip (2–4 stat tiles).
4. Body sections, each with a section title.
5. Timeline (tasks, notes, files, activity with who did what).

The sales flow is Enquiry → Quoted → Sent → Negotiation → Won → Project → Order →
Invoiced → Paid. Travel is Trip → Agency bill → Agency paid → Client invoice → Client paid.

## 5. Components

Use what exists before writing anything:

- Primitives: `src/components/ui/*.tsx` (shadcn/Radix: Button, Badge, Card, Dialog,
  Sheet, Tabs, Table, Select, Popover, Tooltip, DropdownMenu, Command, Skeleton…).
- App pieces: `components/ui.jsx` (toasts, pills, stat tiles), `ListPage.jsx`,
  `SavedViews.jsx`, `Timeline.jsx`, `RecordForm.jsx`, `charts.jsx`, `PaneRail.jsx`.
- Legacy classes (`.btn`, `.card`, `.table`, `.muted`, `.page`) are restyled from the
  same tokens so old pages match; convert a page to the primitives when you are changing
  it anyway, not as a drive-by.

Button variants: `default` (primary, once per view), `outline` (secondary), `ghost`
(tertiary), `destructive` (removes something; asks to confirm).

## 6. Writing in the UI

- Plain verbs, sentence case, no internal names (`stage_status`, `po_value`).
- Say what happened and what's next: "Invoice raised. It's due on 6 Nov."
- No exclamation marks, no emoji, no "Oops".
- A blank amount shows as a gap to fill ("Enter amount"), never as ₹0.

## 7. Accessibility (non-negotiable)

- Text contrast 4.5:1 in both themes (3:1 for 24px+, control borders, icons, focus ring).
- Visible focus ring on everything focusable (`:focus-visible`, 3px `ring`, 2px offset).
- Real `<button>`, `<a href>`, `<label>`; icon-only buttons get `aria-label`.
- Keyboard: lists with arrow keys where they already do, Esc closes overlays, ⌘K works.

## 8. Before you open a PR that touches the UI

- `npm run build`, `npm test` and `npm run typecheck` pass in `web/`.
- Checked in light and dark, at 1440 and 390 wide.
- No new hex values or Tailwind palette colours in components (`grep -rnE "#[0-9a-fA-F]{6}" src --include=*.jsx`).
- Screens you changed follow §2 and, for records, §4.

`test/uiConsistency.test.js` checks the parts of this file a machine can: no hex or
Tailwind palette colours in components, every token defined in both themes, the
contrast of every text/ground pair, every CSS variable defined, radii on the scale,
page titles matching their sidebar names, the process rail on the Deal,
Order and Project pages (and the Deal's nine steps), and no company name in the app. If it fails,
fix the screen or the token; add to its exceptions only for something that is
deliberately not themed (a third-party logo, an email body, the PDF preview).
