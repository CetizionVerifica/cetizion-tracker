# Server layer: quotation from answers and quotation designs (#208, phases 2–3)

Module layer under the feature spec
[`docs/specs/service-quotations/CLAUDE.md`](../../../../docs/specs/service-quotations/CLAUDE.md).
Read that first for the process, acceptance criteria and decisions. This file
says how the server side is built.

This folder is new: it holds the code phases 2 and 3 add. Phase 1 code stays
where it shipped, and is reused, not moved.

## 1. Where things live

| Concern | File | State |
| --- | --- | --- |
| Questionnaire definition: shape, show-if, answer checks, prefill | `lib/questionnaireDefinition.js` | Phase 1. Reuse `allQuestions`, `isVisible`, `checkAnswers` |
| Links, reach, emails, submit, reminders | `lib/questionnaires.js` | Phase 1. Reuse `responseClause` for row scoping |
| Questionnaire and response routes | `routes/questionnaires.js` (`questionnaireRouter`, `questionnaireVersionRouter`, `questionnaireResponseRouter`) | Phase 1. New response routes go on `questionnaireResponseRouter` |
| Pricing rules: schema, validation, evaluation | `lib/serviceQuotes/pricing.js` | Phase 2 |
| Generate a Draft quotation from a response | `lib/serviceQuotes/generate.js` | Phase 2 (lines), phase 3 (sections) |
| Placeholders: grammar, validation, filling | `lib/serviceQuotes/placeholders.js` | Phase 3 |
| Rich text: safe JSON shape, to pdfmake blocks | `lib/serviceQuotes/richText.js` | Phase 3 |
| Design schema and resolution (what a quotation prints with) | `lib/serviceQuotes/designs.js` | Phase 3 |
| The PDF | `lib/quotationPdf.js` `quotationDocument(q)` | Exists. Phase 3 extends it; it stays the only entry point |
| Quotation load, revise, send | `routes/quotations.js` (`fullQuotation`, `/:key/revise`, `/:key/send`) | Exists. Phases 2–3 extend |
| Acceptance link and snapshot | `routes/acceptance.js` | Exists. Phase 2 adds the *Price needed* block; phase 3 extends the snapshot |
| Numbering | `lib/sequences.js` `claimNextId('quotation', client, year)` | Exists |

Files in this folder are plain functions with no Express and no direct
`query` import where avoidable: take a `db`/`client` argument so tests can
run them inside a transaction. New files may be `.ts` (see
`docs/typescript.md`); no `enum`, decorators or parameter properties.

## 2. Data model

New migration at the next free number when the PR is opened (097 or later;
`089_service_questionnaires.sql` is phase 1). Mirror every change in
`server/db/schema.sql`; computed values go in `server/db/views.sql`.

### Phase 2

```sql
ALTER TABLE quotations
  ADD COLUMN questionnaire_response_id int REFERENCES questionnaire_responses(id) ON DELETE SET NULL,
  ADD COLUMN generated_at timestamptz;          -- when lines were last generated
ALTER TABLE quotation_lines
  ADD COLUMN generated    boolean NOT NULL DEFAULT false,   -- written by a pricing rule
  ADD COLUMN rule_key     text,                              -- which pricing line made it
  ADD COLUMN price_needed boolean NOT NULL DEFAULT false;
```

`questionnaire_versions.pricing` (jsonb, default `{"lines":[]}`) already
exists and is frozen with the version by phase 1's trigger.

Not stored, computed on read: "edited since generated" (a generated line
whose `updated_at` > the quotation's `generated_at`), the count of
*Price needed* lines, whether the quotation can be sent.

### Phase 3

```sql
CREATE TABLE quotation_designs (
  id          serial PRIMARY KEY,
  service_id  int REFERENCES services(id) ON DELETE CASCADE,  -- null = every service
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  branding    jsonb NOT NULL DEFAULT '{}',   -- logo document id, accent, cover document id, footer
  sections    jsonb NOT NULL,                -- ordered; Zod-validated in designs.js
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quotation_designs_one_default ON quotation_designs (service_id) WHERE is_default;

CREATE TABLE quotation_sections (
  id            serial PRIMARY KEY,
  quotation_id  int  NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  section_key   text NOT NULL,
  heading       text,
  body          jsonb NOT NULL,          -- rich text, placeholders already filled
  sort_order    int  NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quotation_id, section_key)
);
ALTER TABLE quotations ADD COLUMN design_id int REFERENCES quotation_designs(id) ON DELETE SET NULL;  -- null = Standard
```

Only **editable** sections are copied into `quotation_sections`. Fixed ones
(about us, legal terms) are read from the design for the current version, and
resolved into every snapshot (§6).

## 3. Pricing rules (phase 2)

A version's `pricing` is `{ lines: PricingLine[] }`, validated with Zod in
`pricing.js` on save (draft: listed problems) and on publish (must pass).

```jsonc
{
  "key": "stage2_audit",                    // unique in the version, [a-z][a-z0-9_]*
  "description": "Stage 2 audit, {{answers.standards | join}}",  // placeholders, phase 3 grammar
  "include_if": { "key": "previously_certified", "op": "eq", "value": false },  // same ops as show-if
  "qty":  { "band": { "of": { "answer": "employee_count" },
                      "bands": [[1,45,3],[46,125,5],[126,425,7],[426,1000,9]] } },
  "rate": { "catalogue": true },            // or { "fixed": 25000 } or { "band": … }
  "multiply": [{ "count": "standards" }, { "rows": "sites" }],
  "unit": "man-day", "sac_code": null, "gst_rate": null,   // null = from the service
  "sort_order": 20
}
```

Vocabulary, and nothing else: `fixed`, `answer`, `count` (selected options),
`rows` (table rows), `sum` (a table column), `band` (inclusive ranges,
admin-entered), `catalogue` (the service's `default_rate`), `multiply`, `add`,
`min`, `max`, `round_up`. Every `answer`/`count`/`rows`/`sum` key must exist
in the same version's definition with a compatible type; checked on save.

Evaluation (`priceLines(version, answers, service)`) is pure and returns
`[{ rule_key, description, qty, rate, unit, gst_rate, sac_code, price_needed, why }]`:

- `include_if` false, or the question hidden by show-if → line left out.
- Any input missing, non-numeric or outside every band → line kept with
  `rate: 0`, `qty: 1`, `price_needed: true` and `why` naming the answer.
  **Never guess.**
- `qty` must be > 0 (the column's check); round up to 2 decimals.
- No `eval`, no `Function`, no user JavaScript, no AI.

## 4. Generate quotation (phase 2, extended in 3)

`POST /api/questionnaire-responses/:id/quotation` `{ mode: 'new' | 'revise' }`
in `generate.js`, one transaction:

1. Load the response scoped with `responseClause`; it must be `submitted`.
   Load its version (pricing, definition), the service, and in phase 3 the
   service's default design.
2. Enquiry has no quotation → insert a Draft the way `quoteWonEnquiry`
   (`lib/enquiries.js`) does (same numbering, owner, originating salesperson,
   client and contact), with `questionnaire_response_id` and `generated_at`,
   then **write its `quotation_no` onto the enquiry** so marking the enquiry
   won later creates nothing (spec C7).
3. Enquiry has a Draft or Submitted quotation → `mode` must be `revise`:
   take the same snapshot `/:key/revise` takes (factor it into a shared
   function rather than copying it), delete that quotation's `generated` lines,
   keep hand-added lines, insert the new ones. Won or Lost → 422.
4. Insert lines from `priceLines`, then `SELECT quotation_totals($1)` (the
   existing totals and discount check).
5. Phase 3: insert editable sections with placeholders filled, replacing
   earlier generated ones; set `design_id`.
6. Log it in the activity log (`logUpdated`, event `generated_from_answers`).

Sending is blocked while any line has `price_needed`: in `/:key/send` and in
`/:key/acceptance-link`, a 422 saying how many lines need a price. Clearing the
flag happens when a person sets a rate > 0 on the line.

## 5. Placeholders and rich text (phase 3)

Grammar, whitelisted, no other syntax:

- Values: `client.name`, `client.address`, `client.gstin`, `contact.name`,
  `quotation.no`, `quotation.date`, `quotation.valid_until`, `service.name`,
  `total`, `answers.<key>`, `answers.<tableKey>` (with a formatter).
- Formatters: `money`, `date`, `join`, `list:<column>`, `count`.
- Blocks: `{{#if answers.<key>}}…{{/if}}`, one level deep.

`validatePlaceholders(text, definition)` runs when a design is saved and
names every unknown key. `fill(text, ctx)` inserts values as **plain text**
only; a client's answer can never become formatting, a placeholder or markup.

Rich text is JSON, not HTML: blocks `heading`, `paragraph`, `bullets`,
`table` (strings only); inline marks `bold`, `italic`. `richText.js` turns it
into pdfmake nodes and is the only place that does.

Section types: `cover`, `text`, `answers_table`, `commercials`,
`payment_terms`, `terms`, `signature`, `page_break`. Each has `key`, `type`,
`editable` (boolean) and its content.

## 6. Rendering and snapshots (phase 3)

- `quotationDocument(q)` with no `q.design` returns today's definition
  unchanged; `server/test/pdfQuotation.test.js` keeps passing as is and gains a
  test pinning that.
- With a design it walks sections in order. `commercials` reuses today's lines
  table, GST bands and totals code: extract those into functions inside
  `quotationPdf.js`, do not duplicate them.
- `fullQuotation` loads the design and sections and returns `q.design` already
  **resolved**: branding plus every section (fixed ones from the design,
  editable ones from `quotation_sections`).
- The revise snapshot and the acceptance snapshot store that resolved design
  (spec C5, C8), so a revision or an accepted quotation reprints exactly,
  matching its `pdf_sha256`.
- Colours in the PDF come from branding or the existing constants; the PDF is
  exempt from `web/CLAUDE.md`'s token rule.

## 7. Routes and authorization

Every route is declared in `lib/authz/policy.js` with its `access` and
`restrictions`, in the same style as the phase 1 entries.

| Route | Access | Phase |
| --- | --- | --- |
| `POST /api/questionnaire-versions/:id/preview-pricing` `{ answers }` | admin | 2 |
| `POST /api/questionnaire-responses/:id/quotation` | signed in, `record-owner` | 2 |
| `GET/POST/PATCH /api/quotation-designs`, `/:id` | read signed in, write admin | 3 |
| `POST /api/quotation-designs/:id/preview` `{ answers? }` → PDF | admin | 3 |
| `GET/PATCH /api/quotations/:key/sections` | the quotation's reach (`scopeOf`) | 3 |

Pricing lives on the version, so it is written through the existing
`PATCH /api/questionnaire-versions/:id` (admin, draft only).

## 8. Security

- Client answers are data, never instructions: typed values, escaped on every
  screen, plain text in the PDF, never sent to an AI.
- No public route is added in phases 2–3; the client still only reaches
  `/api/public/questionnaire/:token/*` and the acceptance link.
- Sales users generate only from responses on enquiries they own; a design is
  a template, not client data, so every signed-in user may read designs.
- Any new public surface updates `docs/security.md`.

## 9. Tests

In `server/test/`, `node --test`:

| Test | Pins |
| --- | --- |
| `servicePricing.test.js` | Schema refuses unknown blocks, keys missing from the definition, wrong types; each vocabulary item; bands inclusive at both ends; out-of-band and missing → *Price needed*, never a guess; hidden questions drop lines |
| `servicePricingExamples.test.js` | One worked example per configured service (made-up client): answers → lines → total |
| `serviceQuoteGenerate.test.js` | New vs revise; hand-added lines kept on revise; Won/Lost refused; enquiry gets the `quotation_no` and marking it won creates nothing; sales user refused on another's enquiry; send and acceptance link refused while *Price needed* |
| `servicePlaceholders.test.js` | Every formatter; unknown key fails at save; an answer containing `{{…}}` or markup prints literally |
| `quotationDesigns.test.js` | No design = today's definition; sections in order; revision and acceptance reprint identical after the design changes |

The authorization tests (`authorization.test.js`, `authzPolicy.test.js`)
must pass with the new routes declared.
