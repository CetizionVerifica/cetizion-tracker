/**
 * Reading a questionnaire definition from a file, for the builder's
 * "Import from file" (#208 phase 1b). Only the first look happens here, so
 * a file that is not a form is turned away with a sentence before anything
 * is sent; whether it is a form the builder can publish is the server's
 * judgement (questionnaireDefinition.js checkDefinition), shown as it
 * gives it.
 *
 * Returns { definition } or { error }.
 */
export const MAX_IMPORT_BYTES = 400_000;

export function readDefinitionFile(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'The file is empty.' };
  // Read first, then measured as the server measures it (without the file's indentation).
  if (text.length > 20 * MAX_IMPORT_BYTES) return { error: 'The file is too large for a questionnaire.' };
  let value;
  // A file saved by Word or Notepad may start with a byte-order mark.
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { error: 'The file is not valid JSON: check it was saved as a .json file, unchanged.' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.steps)) {
    return { error: 'The file is not a questionnaire: it needs a list of steps.' };
  }
  if (JSON.stringify(value).length > MAX_IMPORT_BYTES) return { error: 'The file is too large for a questionnaire.' };
  return { definition: value };
}

/** How many questions a definition has, for "replace these with those". */
export const questionCount = (def) => (def?.steps || []).reduce((n, s) => n + (Array.isArray(s?.questions) ? s.questions.length : 0), 0);
