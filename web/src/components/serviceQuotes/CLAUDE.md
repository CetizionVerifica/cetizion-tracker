# Web layer: quotation from answers and quotation designs (#208, phases 2–3)

Module layer under the feature spec
[`docs/specs/service-quotations/CLAUDE.md`](../../../../docs/specs/service-quotations/CLAUDE.md)
and the UI rule book [`web/CLAUDE.md`](../../../CLAUDE.md). Read both first.
`web/CLAUDE.md` wins on anything visual (tokens, type, layout, components,
writing, accessibility); this file only adds what is specific to this feature.

The server contract is in
[`server/src/lib/serviceQuotes/CLAUDE.md`](../../../../server/src/lib/serviceQuotes/CLAUDE.md)
§7. Call it through `lib/api.js`; never build URLs by hand.

## 1. Where things live

| Piece | File | State |
| --- | --- | --- |
| The form, one step at a time (client page, staff fill-in, preview) | `components/QuestionnaireForm.jsx` | Phase 1. Reuse for sample answers in previews |
| The builder | `components/QuestionnaireBuilder.jsx` in `pages/Templates.jsx` (Settings › Templates › Questionnaires) | Phase 1. Gains a Pricing tab |
| Questionnaire status and answers on an enquiry | `components/QuestionnaireCard.jsx`, opened from the Questionnaire column in `pages/Enquiries.jsx` | Phase 1. Gains *Generate quotation* |
| Client page `/q/<token>` | `pages/FillQuestionnaire.jsx` | Phase 1. Unchanged by phases 2–3 |
| Pricing tab on a version | `components/serviceQuotes/PricingEditor.jsx` | Phase 2 |
| Generate dialog (new vs revise, result) | `components/serviceQuotes/GenerateQuotationDialog.jsx` | Phase 2 |
| Answers section on a quotation | `components/serviceQuotes/QuotationAnswers.jsx` in `pages/QuotationDetail.jsx` | Phase 2 |
| Design editor (branding, sections, preview) | `components/serviceQuotes/QuotationDesigner.jsx` as a new kind in `pages/Templates.jsx` | Phase 3 |
| Rich-text editor with placeholder picker | `components/serviceQuotes/RichTextEditor.jsx` | Phase 3 |
| Per-quotation wording | `components/serviceQuotes/QuotationSections.jsx` in `pages/QuotationDetail.jsx` | Phase 3 |

New components go in this folder. Do not move the phase 1 components here in
a feature PR; that is a separate refactor.

## 2. Screens

### Settings › Templates › Questionnaires › a version › Pricing (phase 2)

- A table of pricing lines (description, when included, quantity, rate,
  multipliers, unit), editable only while the version is a draft; a published
  version shows it read-only with "Published versions are frozen. Make a new
  version to change pricing."
- Quantity and rate pickers offer only the server's vocabulary; answer pickers
  list only questions of a compatible type from the same version.
- Band tables are edited as rows (from, to, value), inclusive at both ends.
- **Preview pricing**: fill sample answers with `QuestionnaireForm` (or pick
  a submitted response), see the lines, *Price needed* reasons and total.
  Nothing is saved.
- Problems from the server are listed beside the line they belong to; Publish
  stays disabled with one sentence saying what is missing (`web/CLAUDE.md` §2.2).

### Enquiry › Questionnaire dialog (phase 2)

- On a submitted response, one primary button: **Generate quotation**. When
  the enquiry already has a Draft or Submitted quotation, the dialog says it
  will be revised (its current version kept in the history) and that lines you
  added by hand stay. Won or Lost: the button is replaced by a sentence saying
  why it cannot be generated.
- On success, go to the quotation.

### Quotation page (phases 2–3)

- A banner above the lines when generated: "Generated from the questionnaire
  answers on 7 Oct 2026" plus "; edited since" when the server says so.
- Lines with *Price needed* show the `waiting` tone chip "Price needed" and the
  reason, and the rate cell reads "Enter rate", never ₹0 (`web/CLAUDE.md` §6).
  Send and *Acceptance link* are disabled with "3 lines need a price before
  this can go to the client."
- **Answers** section: the response the quotation was built from, grouped by
  step, read-only, with a link back to the enquiry's dialog.
- Phase 3: a **Design** picker (Standard or the service's designs) and a
  **Wording** section listing editable sections with an edit button each;
  fixed sections are listed as "From the design" with no edit control.
- The process rail stays as it is; generation does not add a step.

### Settings › Templates › Quotation designs (phase 3)

- List of designs by service; one default per service.
- Editor: branding (logo and cover uploaded through the documents API, accent
  chosen from a short preset list, footer text), sections as a reorderable
  list (type, heading, editable or fixed, content), and **Preview** that opens
  the server-rendered PDF with sample answers.
- The placeholder picker inserts only keys the server accepts; an unknown
  placeholder from the server is shown on its section on save.

## 3. Rules specific to this feature

- The client never sees any of these screens. Only `/q/<token>` and the
  acceptance page are public, and phases 2–3 do not change them.
- Show answers as text. Never render a client's answer as HTML or Markdown.
- Never compute a price, total or *Price needed* in the browser; show what the
  server returns (`web/CLAUDE.md` §2.3). Preview pricing calls the server.
- Money in Indian grouping through `lib/format.js`; another currency is named.
- The PDF preview is exempt from the token rule; the designer screen itself is
  not.
- Admin-only screens are hidden from sales users and the server refuses them
  anyway; do not rely on hiding alone.

## 4. Tests

- Unit tests in `web/test/` for pure helpers (band row editing, placeholder
  picker list).
- Playwright in `web/e2e/flows.spec.js`, extending the phase 1 flow: submit
  a questionnaire → *Generate quotation* → a *Price needed* line blocks Send
  → enter the rate → Send for acceptance → the PDF opens. Phase 3 adds: pick a
  design → edit a wording section → the PDF shows it.
- `test/uiConsistency.test.js` must stay green.
- Check light and dark at 1440 and 390 wide before opening the PR.
