import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { sentFields } from '../src/lib/sentFields.js';

test('only the fields a request sent are kept, whatever the schema filled in', () => {
  const schema = z.object({ name: z.string(), active: z.boolean().default(true), notes: z.string().nullable().default(null) });
  const parsed = schema.partial().parse({ name: 'Renamed' });
  assert.deepEqual(sentFields({ ...parsed, active: true, notes: null }, { name: 'Renamed' }), { name: 'Renamed' });
  assert.deepEqual(sentFields({ notes: null }, { notes: null }), { notes: null }, 'an explicit null is still a change');
  assert.deepEqual(sentFields({ name: 'x' }, undefined), {});
});
