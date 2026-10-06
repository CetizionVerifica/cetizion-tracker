# Email document fixtures

The five sample documents of `docs/email-po-invoice-prompt-plan.md` §7, one
JSON file each:

| Field | What it holds |
|---|---|
| `text` | The document's text, as `pdfText` extracts it. **Reconstructed from what the plan says each sample shows**: the real PDFs were not on the machine this was written on. Replace it with the real extracted text (`node -e "…pdfText…"`) when the PDFs are added; keep personal details out. |
| `email` | The covering email: sender, subject, date. |
| `answer` | The model answer a correct reading gives, in the prompt's JSON shape. The offline test runs the checks on it; the live script scores the model's own answer against it. |
| `expect` | What the checks must make of it: `ok` or the review `reason`, the fields that matter, and the payment stages. |

- `node --test test/emailDocFixtures.test.js` runs the checks on the recorded answers (no AI).
- `npm run readers:accuracy` runs the live model over the fixtures and reports accuracy per field (needs the AI key; each fixture is one AI call).
