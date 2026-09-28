import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Two of the smaller findings from the review of batch 5 (#61), neither of
 * which needs a database.
 *
 * In its own file because importing the notification sweep connects the
 * shared pool, and a suite that builds its own database has to do that
 * before anything else has looked at it.
 */

test('an overdue task is announced on the day and at milestones, not every morning', async () => {
  const { collectNotifications, TASK_OVERDUE_DAYS } = await import('../src/lib/notify.js');
  assert.deepEqual(TASK_OVERDUE_DAYS, [1, 7, 14, 30]);

  // A database of one table, answering from memory: this is about which
  // days emit, and nothing else in the sweep needs to be real.
  const emitted = [];
  const fakeDb = (task) => ({
    query: async (sql, params) => {
      if (/FROM tasks/.test(sql)) return { rows: [task] };
      if (/webhook_emit/.test(sql)) { emitted.push(params[0]); return { rows: [] }; }
      // The sweep reads a few settings with COALESCE(..., 'n') AS value,
      // and destructures the single row it knows it will get.
      if (/AS value/.test(sql)) return { rows: [{ value: '7' }] };
      return { rows: [] };
    },
  });
  const on = async (dueAt, today) => {
    emitted.length = 0;
    const task = { id: 1, entity: 'quotation', entity_id: 'Q1', title: 'Chase', due_at: dueAt, assignee: 'Ramesh', status: 'open' };
    await collectNotifications({ today, db: fakeDb(task) });
    return emitted.filter((e) => e === 'task.overdue').length;
  };

  assert.equal(await on('2026-09-21', '2026-09-22'), 1, 'the day it goes overdue');
  assert.equal(await on('2026-09-15', '2026-09-22'), 1, 'seven days later');
  assert.equal(await on('2026-08-23', '2026-09-22'), 1, 'and thirty');
  assert.equal(await on('2026-09-20', '2026-09-22'), 0, 'but not on day two');
  assert.equal(await on('2026-09-01', '2026-09-22'), 0, 'nor on day twenty-one');
  assert.equal(await on('2026-09-22', '2026-09-22'), 0, 'and a task due today is not overdue at all');
});

test('a contact is not given the client portal until somebody says so', () => {
  // The default is the whole fix, and it lives in two files that have to
  // agree or the migration check fails.
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'latin1');
  const migration = readFileSync(new URL('../db/migrations/036_portal.sql', import.meta.url), 'utf8');
  assert.match(schema, /portal_access\s+boolean NOT NULL DEFAULT false/);
  assert.match(migration, /portal_access boolean NOT NULL DEFAULT false/);
});

