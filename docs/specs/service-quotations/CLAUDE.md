# Spec: service questionnaires → designed quotations (#208)

The feature-level layer. Read this before changing anything about service
questionnaires, generating a quotation from answers, or quotation designs.
Module rules live beside the code:

- Server: [`server/src/lib/serviceQuotes/CLAUDE.md`](../../../server/src/lib/serviceQuotes/CLAUDE.md)
- Web: [`web/src/components/serviceQuotes/CLAUDE.md`](../../../web/src/components/serviceQuotes/CLAUDE.md)

Background and the long-form reasoning: issue #208 (the plan), and
[`docs/issue-208-guide.md`](../../issue-208-guide.md) for what phase 1
actually shipped. Where this file and the plan differ, this file wins; §8
lists every difference.

---

## 1. The process we are replacing

From *Quotation generation for services* (product owner, Oct 2026):

> Sales repeatedly designs client quotations by hand, editing them after
> collecting the client's data through a questionnaire that is different for
> each service. To automate this, the questionnaire sent for a service becomes
> a digital form; the client fills it in, and the answers are turned into a
> quotation using predefined, designed templates.

Today, per enquiry:

1. Salesperson emails the client the Word questionnaire for that service.
2. Client fills it in and emails it back (days later, often incomplete).
3. Salesperson reads it, works out the price by hand (sites, employees,
   standards, man-days, travel).
4. Salesperson designs the quotation document by hand (cover, scope,
   methodology, commercials, terms) in Word.
5. The quotation is entered in the tracker and sent for acceptance.

Target: steps 1–2 become a link and a form (**phase 1, done**), step 3 becomes
pricing rules (**phase 2**), step 4 becomes a per-service design (**phase 3**),
and step 5 is the existing acceptance flow (#53), unchanged.

## 2. End to end

```text
Enquiry (service = ISO audits)
  └─ Send questionnaire ─▶ client link /q/<token> ─▶ client fills form (save and resume)
        └─ Submitted ─▶ owner notified ─▶ answers on the enquiry's Questionnaire dialog
              └─ Generate quotation ─▶ Draft quotation, linked to the response
                     lines   ← service's pricing rules (phase 2)
                     wording ← service's design, placeholders filled (phase 3)
                     └─ salesperson reviews and edits (discount approval as today)
                           └─ Send for acceptance (#53) ─▶ accepted ─▶ won ─▶ PO
```

**Invariant: a person always sends.** Generation only ever writes a Draft.
Nothing reaches a client without a salesperson pressing Send.

## 3. Status by phase

| Phase | Scope | State |
| --- | --- | --- |
| 1. Digital questionnaires | Builder, versions (frozen once published), client link, save and resume, staff fill-in, reminders, owner notice, answers on the enquiry | **Merged** (PR #212, 8 Oct 2026). Pending: `public_app_url` set in production; first two questionnaires built |
| 1b. First questionnaires | ISO audits and Ecovadis questionnaires built from their Word files, as seed or by an admin | Waiting on the Word files |
| 2. Quotation from answers | Pricing rules per questionnaire version, preview pricing, *Generate quotation*, *Price needed* flag and send block, Answers tab on the quotation | Not started. Waiting on rate cards (§9 Q2) |
| 3. Designed templates | Designs per service (branding, ordered sections, rich text, placeholders), `quotation_sections`, rendering through `quotationPdf.js` with Standard unchanged | Not started. Can run in parallel with 2 |
| 4. Reach and roll-out | Remaining services, portal *Questionnaires* section, Import from Word (AI draft for the admin), funnel on the sales report | Not started |

One PR per phase (or two), each with its own tests and a short guide in
`docs/issue-208-phase-N.md` written like `docs/issue-208-guide.md`.

## 4. Phase 2 acceptance criteria

- [ ] An admin can add pricing lines to a **draft** questionnaire version on a
      Pricing tab; publishing validates them, and they freeze with the version.
- [ ] *Preview pricing* takes sample answers and shows the lines and total it
      would produce, without saving anything.
- [ ] On a submitted response, *Generate quotation* creates a Draft quotation
      (new number from `claimNextId`) linked to the response and the enquiry, or,
      if the enquiry's quotation is Draft or Submitted, revises it (existing
      revise snapshot) and replaces its generated lines.
- [ ] A line whose rule cannot be applied is created at rate 0 with
      *Price needed*; the quotation cannot be sent or get an acceptance link
      until every such line is priced.
- [ ] Won and Lost quotations are never regenerated.
- [ ] Hand edits to generated lines are kept as ordinary edits; the quotation
      shows "Generated from answers on <date>; edited since" once changed.
- [ ] Worked-example tests for each configured service pin answers → lines →
      total.
- [ ] Sales users can generate only from responses on their own enquiries.

## 5. Phase 3 acceptance criteria

- [ ] With no design, the PDF is today's layout exactly (a test pins the
      document definition).
- [ ] An admin can create a design for a service: branding, ordered sections
      of the types in the server layer, rich text with placeholders, and
      *Preview with sample answers* renders the PDF.
- [ ] Saving a design with an unknown placeholder fails with the placeholder
      named, at save time, not at print time.
- [ ] Generation copies **editable** sections into `quotation_sections` with
      placeholders filled; the salesperson can edit them per quotation.
- [ ] Staff PDF, acceptance PDF and portal download render through the same
      function, so all three show one document.
- [ ] A revision and an accepted acceptance reprint exactly as they were,
      including fixed sections and branding (§8, conflict C5).
- [ ] Client answers appear in the PDF only as plain text.

## 6. Decisions already made

| # | Decision | Source |
| --- | --- | --- |
| D1 | Generated quotation is always a Draft a person reviews and sends | Plan §3, default for Q3 |
| D2 | One open questionnaire per enquiry; sending another withdraws the unsubmitted one | Phase 1 (guide §2.5) |
| D3 | A reopened, already-submitted response returns to submitted with answers kept | Shyam's review of #212 |
| D4 | Company details the client changed are shown to staff, never written by themselves | Phase 1 (guide §4.5) |
| D5 | No AI in pricing; no AI ever sees client answers | Plan §5.1, §8 |
| D6 | Pricing is a fixed vocabulary run by our own code; no `eval`, no user JavaScript | Plan §5.1 |
| D7 | Questionnaire and pricing are versioned together and frozen on publish | Plan §4.3; trigger shipped in phase 1 |
| D8 | First two services: ISO audits and Ecovadis | Default, unchallenged |
| D9 | Questionnaire and design editing: admins only | Default for Q5, unchallenged |
| D10 | Invite and reminder emails are client emails and respect client-email holds (`lib/clientEmails.js`) | Fix on merge of #212 |

## 7. Out of scope

- Sending a quotation automatically on submit (D1).
- A public website form that creates the enquiry itself.
- Languages other than English; currencies beyond those quotations already
  support.
- Editing the quotation's layout in code per service (designs are data).

## 8. Differences and conflicts

Between the uploaded process note, the plan in #208, and the code on `main`.
Each has a resolution this spec adopts; change it here if the product owner
decides otherwise.

| # | Between | Conflict | Resolution in this spec |
| --- | --- | --- | --- |
| C1 | Note ↔ plan | The note says answers are "converted into a quotation"; the plan stops at a Draft a person reviews | Draft only (D1). Ask the product owner if any service should skip review (§9 Q3) |
| C2 | Note ↔ plan | The note says nothing about price; the plan calculates it from rules | Calculate where a rate card exists, otherwise *Price needed* (§9 Q2) |
| C3 | Note ↔ plan | "Predefined designed templates" could mean genuinely different layouts per service; the plan has one house style with per-service sections | One house style, per-service cover and sections (§9 Q6) |
| C4 | Plan ↔ code | The plan places screens under "Admin › Templates" and a card on "the enquiry page" | Templates are **Settings › Templates**; enquiries have no page yet, so answers and *Generate quotation* sit in the Questionnaire dialog opened from the enquiry list |
| C5 | Plan ↔ code | The plan reads fixed sections from the design at print time, but an accepted acceptance reprints from its stored `snapshot` (`routes/acceptance.js`) and a revision from `quotation_revisions.snapshot`; a live read would change an accepted document and break its `pdf_sha256` | Snapshots carry the **resolved** design: branding and every section, fixed ones included. Live read only for the current, unsent version |
| C6 | Plan ↔ code | The plan numbers the migration `089_…` and proposes `POST /api/enquiries/:id/questionnaire` | Phase 1 used `089_service_questionnaires.sql` and `POST /api/questionnaire-responses`. New migrations take the next free number at the time of the PR (097 or later); new routes extend `questionnaireResponseRouter` |
| C7 | Plan ↔ code | Generating "the way `quoteWonEnquiry` does" could create a second quotation when the enquiry is later marked *Won - Quotation Sent* | Generation writes the new `quotation_no` onto the enquiry in the same transaction; `quoteWonEnquiry` already does nothing when `quotation_no` is set |
| C8 | Plan ↔ code | Revision snapshots today hold header fields and lines only | Phase 3 adds `design_id`, resolved branding and sections to the snapshot (C5) |
| C9 | Plan ↔ D2 | One open questionnaire per enquiry, but an enquiry can list several services | A quotation is generated from one response, so one service's rules and design. Multi-service quotations: §9 Q8 |
| C10 | Plan ↔ code | The plan stores money answers as number + currency | Phase 1 stores a number in the currency the question names; pricing reads it that way |

## 9. Open questions for the product owner

Defaults apply until answered; a reply by number is enough.

1. **Source material**: the Word questionnaire and one well-designed past
   quotation for ISO audits and Ecovadis. Blocks 1b, the phase 2 tests and the
   phase 3 designs.
2. **Rate cards**: who owns them (man-day bands, travel, per-site charges),
   and can you share the two services' cards? Default: calculate where a card
   exists, *Price needed* elsewhere.
3. **Skip review** for any service? Default: no (D1).
4. **Embeddable website form** creating enquiries? Default: not in this spec.
5. **Who edits** questionnaires and designs? Default: admins only (D9).
6. **Branding**: one house style with per-service cover and wording, or
   different layouts? Default: one house style.
7. **Languages**: English only? Default: yes.
8. **Multi-service enquiries**: one quotation combining several services'
   questionnaires, or one quotation per service? Default: one per response.
