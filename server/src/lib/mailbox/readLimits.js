/**
 * How much of an email, and of the PDFs it carries, the readers send the AI,
 * and how much they let it answer (docs/security.md §3 lists what leaves).
 *
 * The model's context is far larger than any of these: the caps are there
 * so one oversized attachment cannot make one call slow and dear, not
 * because the model cannot take more. 120,000 characters is about 30,000
 * tokens.
 */

/** Pages of one PDF read as text. A 40-page PO still has its schedule of rates read. */
export const MAX_PAGES = 40;

/** Characters of document text in one prompt: the chosen PDF, then its annexures. */
export const MAX_DOCUMENT_TEXT = 120_000;

/** Characters of the email's own new text, for every reader. */
export const MAX_EMAIL_TEXT = 10_000;

/** Characters of attached PDF text the enquiry reader sees alongside the email. */
export const MAX_ENQUIRY_ATTACHMENT_TEXT = 12_000;

/** Line items kept from one PO or quotation read. */
export const MAX_LINES = 300;

/**
 * The answer budget for reading a document: room for MAX_LINES short lines
 * without truncating, and no more than every provider of a flash-class
 * model accepts.
 */
export const DOCUMENT_MAX_TOKENS = 8192;

/** How long a document read may take: text, and a scan sent for OCR. */
export const DOCUMENT_TIMEOUT_MS = 120_000;
export const OCR_TIMEOUT_MS = 180_000;
