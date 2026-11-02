/**
 * Rewrites quotationDocument.pinned.json from the code as it stands. Only for
 * a change to the document that is meant: a refactor must leave the file alone.
 */
import { writeFileSync } from 'node:fs';
import { quotationDocument } from '../../src/lib/quotationPdf.js';
import { pin, samples } from './quotationDocumentSamples.js';

const pinned = Object.fromEntries(Object.entries(samples).map(([name, q]) => [name, pin(quotationDocument(q))]));
writeFileSync(new URL('./quotationDocument.pinned.json', import.meta.url), `${JSON.stringify(pinned, null, 2)}\n`);
process.exit(0);
