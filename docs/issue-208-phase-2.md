# Issue #208, phase 2: a quotation from the questionnaire's answers

Phase 1 (`docs/issue-208-guide.md`) put the questionnaire online. Phase 2
turns a client's submitted answers into a **Draft quotation**, priced by
rules an admin sets up per questionnaire. A person always checks the draft
and sends it; nothing reaches a client by itself.

| Step | What | Status |
|---|---|---|
| 2A | Pricing rules and *Preview pricing* (server) | Merged (#241) |
| 2B | *Generate quotation*, *Price needed* and the send block (server) | Merged (#241) |
| 2C | The screens: Pricing tab, Generate dialog, the quotation's Answers | Merged (#241) |
| 2D | Pricing for ISO audits and Ecovadis | Proposed lines and worked examples here; **the figures are the business's to enter** (§4) |

The rules of the feature are in `docs/specs/service-quotations/CLAUDE.md`;
the pricing vocabulary is in `server/src/lib/serviceQuotes/pricing.js`.

---

## 1. At a glance

| What | Where you see it |
|---|---|
| **Pricing tab**: the lines a quotation gets, each with when it is included, its quantity and its rate, built from a small fixed set of blocks (a number, an answer, a count, table rows, a column total, a band lookup, the catalogue rate, and add / multiply / min / max / round up) | Settings › Templates › Questionnaires › a draft › **Pricing** |
| **Preview pricing**: sample answers in, the lines and total out; nothing saved | The Pricing tab |
| **Generate quotation**: from a submitted questionnaire, a Draft quotation, or the next revision of the enquiry's Draft or Submitted one (one quotation per enquiry; each service adds its own lines) | The enquiry's Questionnaire dialog |
| **Price needed**: a line the rules cannot price comes in at 0 with the reason; *Send* and the acceptance link wait until someone enters the rate | The quotation |
| **Answers**: what the client said, read-only, with a link back to the enquiry | The quotation |

## 2. How prices change: in the app, not in code

The product owner asked for pricing to be customisable in the app. It is,
in two places:

| To change | Where | Takes effect |
|---|---|---|
| **The day rate** (any line whose rate is *The catalogue rate*) | Settings › Service offerings › the service › default rate | On the next quotation generated. No new version. A Draft generated before keeps its lines until it is generated again (*Revise*) |
| **Anything else**: bands, fixed amounts, which lines exist | The Pricing tab, on a **new version** of the questionnaire (*Edit as a new version*), then publish | When that version is published. Answers already given keep the version they were given to |

A published version's pricing is frozen with its questions (spec D7), so a
quotation can always be traced to the rules that made it. Salespeople can
still change any line on the Draft before sending it.

Until a figure is set, the line comes out **Price needed** with the reason
as the screen shows it: for example `the service has no default rate in
the catalogue`, or `"employee_count" is 5000, outside every band` (the
question's key). A band over a sum, like the Ecovadis total of employees,
reads `the value is 0, outside every band`. A quotation with such a line
cannot be sent, nor get an acceptance link, so a missing price is never
quoted as 0.

## 3. How to check it

1. Publish a questionnaire with pricing (the Pricing tab, then *Publish*).
2. *Preview pricing* with sample answers: the lines and total appear.
3. On an enquiry, send the questionnaire (*Make a link only*), fill it in
   and submit, then *Generate quotation*. The Draft opens with its lines;
   a *Price needed* line holds *Send* until a rate is entered.

## 4. Step 2D: the proposed lines for ISO audits and Ecovadis

The lines below read the questionnaires' settled keys
(`docs/questionnaires/README.md`). **The numbers are the business's**: an
admin enters them as in §2. The worked examples in
`server/test/servicePricingExamples.test.js` run these lines against the
real forms with *example* numbers (issue #208's own illustration and
invented fees), to show the maths and the conditions are right.

### ISO audits

| Line | Included | Quantity | Rate |
|---|---|---|---|
| Certification audit (Stage 1 and Stage 2) | Always | Audit days: a **band** on *employees in scope* (`employee_count`) | **The catalogue rate**: the day rate in Settings |
| Site visits and travel | Always: **every** site | The **rows** of the *Sites* table (`sites`) | A **fixed** amount per site |
| Transfer review | When *What are you applying for?* is a transfer (`application_type` = `transfer`) | 1 (its own unit, "review", not the service's "day") | A **fixed** amount |

### Ecovadis

| Line | Included | Quantity | Rate |
|---|---|---|---|
| EcoVadis assessment support | Always | 1 | A **band** on total employees: the four employee numbers **added** |
| Data collection, per facility | Always | The **rows** of the *Facilities* table (`facilities`) | A **fixed** amount per facility |

### The figures to fill in

| Service | Figure | Example used in the tests (not a price) |
|---|---|---|
| ISO audits | Audit days for each band of employees | 1–45: 3 · 46–125: 5 · 126–425: 7 · 426–1000: 9 (issue #208's illustration) |
| ISO audits | The day rate (Settings › Service offerings) | 25,000 (issue #208's illustration) |
| ISO audits | Per site | 8,000 (invented: the issue's 8,000 is for sites **outside Pune**, below) |
| ISO audits | Transfer review | 15,000 |
| Ecovadis | The fee for each band of total employees | 1–250: 3,50,000 · 251–1000: 4,50,000 · 1001–1,00,000: 6,00,000 |
| Ecovadis | Per facility | 25,000 |

Every figure is in the service's currency (INR unless the service says
otherwise). A quotation in another currency is converted through the newest
ECB rate on or before the day, at most four publishing days old, or the
line is Price needed (spec D11). GST is the line's own, else the service's,
else 18%. *Preview pricing* shows the total before GST.

Outside the bands, a line is Price needed: an ISO client with more than
1,000 employees in scope, or an Ecovadis client whose four employee numbers
add up to 0 (each may be 0).

The number of sites is the rows of the table, never a separate question
(`docs/questionnaires/README.md`): there is no `site_count` to keep in step.

### Not proposed yet (decide with the figures)

- **Travel only for sites outside Pune**, as issue #208's illustration has
  it. The form cannot tell yet: a site's address is free text, and a rule
  cannot pick out some rows of a table. It needs a column on the *Sites*
  table first (for example *Outside Pune?*, or a travel distance in km), so
  the client says it once per site; then the line reads that column.

- Extra charges per **additional standard**, or a discount for an
  **integrated** system (`standards`, `integration`).
- Different days for an **extension** of scope or an **added standard**
  (`application_type`).
- Ecovadis **group level** or a **repeat** assessment (`past_assessment`,
  `assessment_level`; asked only after a past assessment).
- **Shifts** per site (`sites.shifts`), a **minimum fee**, travel by
  distance.

Each is a line or a band the Pricing tab can already express.

## 5. Questions for Shyam

1. **The figures** in §4, or who enters them in the app.
2. **The lines**: are these the parts a quotation should have, and should
   any of the "not proposed yet" ones be added?
3. **A past quotation per service** with the answers behind it, so the
   proposed lines can be checked against a real price.
4. **Travel**: charged for every site, or only for sites outside Pune (as
   issue #208's illustration)? The second needs a column on the *Sites*
   table first (§4, "Not proposed yet").
