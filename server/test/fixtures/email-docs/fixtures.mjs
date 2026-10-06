import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partnersOf } from '../../../src/lib/mailbox/ourParties.js';

/** The sample documents (README.md here), shared by the offline test and the live accuracy script. */
const DIR = dirname(fileURLToPath(import.meta.url));

export function loadFixtures() {
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
    .map((file) => ({ file, ...JSON.parse(readFileSync(join(DIR, file), 'utf8')) }));
}

/** Who "us" is for the samples: the plan's two GSTINs and partner (docs/email-po-invoice-prompt-plan.md, Decisions). */
export function readerParties() {
  return {
    ourNames: ['Cetizion Verifica Pvt Ltd'],
    ourGstins: ['07AAKCC0860B1Z2', '09AAKCC0860B1ZY'],
    partners: partnersOf('Innovative CSR Solutions India Pvt. Ltd. | 07AACCI8342L1ZA'),
    internalDomains: ['cetizionverifica.com'],
  };
}
