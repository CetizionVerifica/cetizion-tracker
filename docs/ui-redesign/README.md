# UI redesign: Mocha Glass (handover)

This branch restyles the whole tracker to **Mocha Glass**: warm glass panels over a coffee-lit canvas, light and dark designed together, motion that is smooth and a little playful where people look and absent where they work. Behaviour is unchanged unless listed under "Behaviour changes" below. Read this file first; the component guides are in [`design-system/`](design-system/README.md).

## For a reviewer (in 5 minutes)

- **Scope:** every screen in `web/`: shell, daily work, sales, inbox, money, projects/travel/HR, reports, settings, client portal, quotation acceptance, questionnaires. One small server fix (questionnaire uploads, see below). No migrations, no API changes.
- **Default theme is now light** (dark is complete too; the client portal and acceptance page get their own theme switch, stored separately from staff's).
- **Tests:** web typecheck, web unit tests (48), build, server tests (734), and all three Playwright suites (`e2e`, `e2e-smoke`, `e2e-authz`) pass on a throwaway database. Pinned e2e labels that changed were updated in the same commits.
- **How it was checked:** every route at 1440 / 1024 / 768 / 390 px in light and dark, as admin, sales, HR and shared sign-in; loading, empty and error states; every dialog and menu opened and closed; a narrow-window sweep (1280 → 340 px) for sideways scroll and overlapping text; uploads exercised with made-up files.

## Where things live (for your Claude)

| What | Where |
|---|---|
| Tokens (light/dark colours, fonts, radii) | `web/src/styles/mocha/tokens.css` |
| Design-system classes (`mg-*`: glass, buttons, fields, tables, tabs, banners, dialogs, charts, calendar) | `web/src/styles/mocha/bundle.css` |
| Pop-ups as solid glass, dialog closing, blur safety | `web/src/styles/mocha/surfaces.css` |
| Feel: hover/press/focus timings, rounded hover tints, scrollbars, reduced motion | `web/src/styles/mocha/feel.css` |
| Shell (icon rail, phone tab bar, dock, header) styles | `web/src/styles/mocha/shell.css` |
| Per-area styles | `web/src/styles/mocha/{daily,sales,inbox,money,travel,reports,settings,client,questionnaire,qbuilder,app}.css` |
| Motion runtime (page arrival, count-ups, jelly/press, pause, theme shockwave, hero glow) | `web/src/styles/mocha/motion.js` |
| Date/time calendar, combobox, file drop zones (replace the browser's own pickers) | `web/src/styles/mocha/pickers.js` |
| Restyled shadcn primitives (same props as before) | `web/src/components/ui/*` |
| App shell, Ctrl K, error boundary | `web/src/components/shell/*`, `web/src/components/CommandPalette.jsx` |
| Scene backdrop (drifting blobs + grain) | `web/src/components/SceneBackdrop.jsx` |
| Component guides | `docs/ui-redesign/design-system/` |

`web/CLAUDE.md` still holds the non-visual rules (copy, accessibility, process); its visual rules are superseded by Mocha Glass (a note at its top says so).

## Rules to keep when changing the UI

1. Use the `mg-*` classes, `components/ui` and the tokens. No one-off colours, fonts or radii.
2. **Pop-ups are solid glass** (opaque fill with sheen, bright top edge, glow and shadow) so text behind them is never readable. The page around a dialog is not dimmed or blurred. Only the side-menu tooltip keeps see-through glass.
3. **Never put a blur inside a blur** (a glass element inside another glass element turns see-through). Pop-ups render as siblings/portals.
4. **No cursor ripple.** The hero panel's glow follows the cursor and fades in/out; that is the only cursor effect.
5. Motion: transform/opacity only; repeated work (typing, sorting, filtering, tables, keyboard) stays instant; `prefers-reduced-motion` and the pause button (`html.mg-paused`) turn it all off.
6. Every screen must look right at any width from 1440 down to 340 (no sideways scroll, no overlapping or squashed text). Phone (< 720 px) uses rows instead of tables and bottom sheets instead of dialogs.
7. Native `<input type="date|time|month|datetime-local">`, `<select>`, `<input list>` and file inputs are kept for behaviour; `pickers.js` and the CSS give them the Mocha Glass look.
8. Opening animations must not leave a `filter` on a glass surface (it switches its blur off in Chrome); closing animations must keep their end state (no flash). See `surfaces.css`.

## How to run and check it

```bash
npm run typecheck --prefix web
npm test --prefix web
npm run build --prefix web
npm test --prefix server
```

E2E: run against a throwaway database and **set `E2E_DATABASE_URL`**. Without it, the PO-from-email tests fall back to the database in `server/.env` and write rows there.

## Behaviour changes (small, deliberate)

- Ctrl K "Record a payment" lists overdue, due and part-paid invoices (it used to offer stages that had no invoice yet).
- Inbox: picking a team inbox shows only that inbox's threads (uses the API's `inbox_id`); search works on the Done view; Close / Not an enquiry / Snooze have Undo.
- Company page: admins can remove a contact (it never worked before).
- Forms name an empty required field instead of saving nothing; oversized files are refused as soon as they are chosen.
- Record pages keep their content (and any open dialog) while they refresh after a save. Before, the one-time acceptance link could be lost.
- Sales opening Scheduled reports see "Scheduled reports are for admins" instead of a not-found page.
- Every browser `confirm()` is now an in-app dialog; a few actions that changed things instantly now ask first (revoking a token, changing a role, turning a webhook off, signing out everywhere).

## Server fix included

`server/src/lib/questionnaires.js`: `documentStorageReady` is a value, but was called as a function, so **every questionnaire file upload failed with a 500 in production**. Now it is read as a value; without storage the client gets the 503 "File storage is not set up on this server".

## Questions for the reviewer

1. **HR in Ctrl K:** today HR sees every Ctrl K entry, though the server refuses most of them. Limit HR's palette to travel pages, and make "Approve or reject an expense claim" admin-only (dropping its "Decided by" field)? Kept as today for now.
2. **"Show margins to sales":** several screens refer to this setting, but there is no settings row for `margin_visible_to_sales`, so saving it returns 404. Add a migration for it?
3. **Unused dependencies:** `recharts` and `react-is` are no longer used. Remove them? (Changes `package-lock.json`.)
4. **Questionnaire builder:** "Several from a list" and "Tick boxes" are offered as one question type in the builder, while the server keeps them as two. Keep them merged, or split them back?
5. **Deferred because they need server work** (kept as the og tracker does today, listed so they are not lost): Today's period switch (Today/Week/Month); an Inbox Snoozed view and Undo for Not a PO / Not an invoice; History tabs on trips and vendor bills (needs an activity log); a travel-dashboard period switch; Trips quick filters "Missing documents" and "Chargeable, not billed"; owner filter applying to Reports › More analysis; "link expired" vs "link already used" as separate messages on the client sign-in; "Mark matched" for a client's payment advice whose money is already recorded; "Set a password" for SSO-only accounts.
6. **Two copies of a few screens existed in the design** (vendor invoices in Money and in Travel; Settings › Assumptions in Sales and in Settings). The code has one of each: the travel bill page and the Settings pane.
7. **Known test quirks (not app bugs):** "Import a sales sheet" passes on fresh data but fails if run twice on the same data; the tracking-pixel test only runs against the Vite dev server.

## If you are your team's Claude

- Start with this file, then the component guide for whatever you touch in `design-system/components/`.
- Prefer editing `styles/mocha/*` and `components/ui/*` over page-level overrides; most visual bugs are fixed once there.
- After any visual change: typecheck, unit tests, build, then look at the page at 1440 and 390 px in light and dark, open and close its dialogs, and check the browser console.
- Do not reintroduce the cursor ripple, translucent pop-ups, or Liquid-Glass-style see-through surfaces; those were tried and rejected.
