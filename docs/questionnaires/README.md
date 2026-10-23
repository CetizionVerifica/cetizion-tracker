# The first service questionnaires (#208 phase 1b, #239 Step 1)

Two questionnaire definitions, drafted from the business's own forms:

| File | Service | Drafted from | Steps · questions |
|---|---|---|---|
| `iso-audits.json` | ISO audits | The ISO application form (Word, *WF_2500_Application - Updated*) | 5 · 60 |
| `ecovadis.json` | Ecovadis Assessment (consulting) | The questionnaire at cetizionverifica.com/ecovadisQuestionnaire | 4 · 36 |

They are **data, not code**: nothing reads them by itself, and they are
never seeded. An admin loads each into the builder, where it is checked,
previewed and published like any other form.
`server/test/questionnaireFiles.test.js` checks that both pass the builder's
rules, and that their conditional questions behave.

## Loading one

1. Settings › Templates › Questionnaires › **New questionnaire**, for the service.
2. On its draft, **Import from file** and choose the `.json` file. It replaces
   the draft's questions after asking; a file the builder could not publish is
   refused with the reasons, and nothing changes. It stays a draft.
3. **Preview as the client** (on a phone too), then **Publish version 1**.

A published version is never changed by an import: to change a published
form, **Edit as a new version** and import into that draft.

Import from file takes a definition exactly as written, keys and option keys
included, which typing it in cannot (an option's key follows its label). It
is not the AI-assisted *Import from Word* of Step 4C, which drafts a
definition from a Word file for an admin to edit; this one reads a
definition someone has already written.

## The keys are what pricing reads

The pricing rules (Step 2D) refer to these keys, so they are settled here.
The ones pricing is likely to read:

| Form | Keys |
|---|---|
| ISO audits | `application_type` (`new_registration`, `transfer`, `extend_scope`, `add_standard`), `standards` (`iso_9001`, `iso_22000`, `iso_50001`, `iso_27001`, `iso_37001`, `iso_45001`, `iso_39001`, `other`), `employee_count`, `sites` (rows: `address`, `employees`, `shifts`, `function`), `previously_certified`, `integration` |
| Ecovadis | `facilities` (rows), `permanent_male`, `permanent_female`, `contractor_male`, `contractor_female`, `plant_area_sqm`, `past_assessment`, `assessment_level` (`unit`, `group`), `medal_target` (`bronze` … `platinum`), `desired_timeline`, `certifications` |

## Where they differ from the originals

For the product owner to confirm:

1. **ISO standards.** The Word form names only ISO 9001 but has sections for
   food safety, energy, information security, anti-bribery, health and safety
   and road traffic safety; the list offers those standards (ISO 22000, 50001,
   27001, 37001, 45001, 39001) and *another standard*. Each section, and its
   heading, appears only when its standard is chosen.
2. **ISO signature.** "Signed" and "Date" are the name, email and time the
   form records on submit; the form asks for the position and a tick to
   confirm the data.
3. **ISO vehicles.** The vehicle types are a table (type, number) rather than
   a fixed list of eleven boxes.
4. **Ecovadis certificate dates.** The website shows a date beside each ticked
   certificate; here they are a table (certificate, valid until).
5. **Ecovadis employee totals.** The website adds them up as you type; here
   the four numbers are asked, and pricing adds them.
6. **Ecovadis ESG link.** Asked when the client prepares an ESG report (the
   website also asks it when they have a sustainability function), with an
   upload as well as a link.
7. **Ecovadis facilities.** Up to 20 rows, rather than the website's four.
