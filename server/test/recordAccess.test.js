import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ENTITY_RECORDS, UNRESTRICTED, documentClause, parentClause, recordReachableSql,
} from '../src/auth/ownership.js';
import { resources } from '../src/lib/resources.js';

/**
 * The gate the timeline and the touch log put in front of a record (#18
 * Phase 2C), tested as what it is: a string and a parameter list.
 *
 * Needs no database. The endpoints that use it are covered against a real
 * one in rowScoping.test.js; this is the part that can be checked on every
 * run, including the runs where TEST_DATABASE_URL is not set — which is
 * most of them, and is where a predicate quietly going missing would
 * otherwise not be noticed.
 */

const SALES = { unrestricted: false, ownerId: 7 };

describe('record reachability', () => {
  test('an admin is asked nothing at all', () => {
    for (const entity of Object.keys(ENTITY_RECORDS)) {
      assert.equal(recordReachableSql(UNRESTRICTED, entity, 'X'), null, entity);
    }
  });

  test('master data is open to everybody signed in', () => {
    for (const entity of ['company', 'contact']) {
      assert.equal(recordReachableSql(SALES, entity, '3'), null, entity);
    }
  });

  test('a record that carries its own owner is compared against it', () => {
    const byKey = { enquiry: 'enquiry_no', quotation: 'quotation_no', project: 'project_id' };
    for (const [entity, key] of Object.entries(byKey)) {
      const probe = recordReachableSql(SALES, entity, 'REF-1');
      assert.match(probe.sql, new RegExp(`r\\.${key}::text = \\$1`), entity);
      assert.match(probe.sql, /r\.owner_user_id = \$2/, entity);
      assert.deepEqual(probe.params, ['REF-1', 7], entity);
    }
  });

  test('a record with no owner of its own is reached through the one above it', () => {
    const po = recordReachableSql(SALES, 'purchase_order', 'PO-1');
    assert.match(po.sql, /FROM purchase_orders r WHERE r\.po_number::text = \$1/);
    assert.match(po.sql, /FROM quotations pq[\s\S]*pq\.owner_user_id = \$2/);
    assert.match(po.sql, /FROM projects pp[\s\S]*pp\.owner_user_id = \$2/);
    assert.deepEqual(po.params, ['PO-1', 7]);

    const stage = recordReachableSql(SALES, 'payment_stage', 5);
    assert.match(stage.sql, /FROM payment_stages r WHERE r\.id::text = \$1/);
    assert.match(stage.sql, /FROM purchase_orders ppo[\s\S]*ppo\.po_number = r\.po_number/);
    assert.deepEqual(stage.params, ['5', 7]);
  });

  test('every predicate is parameterised: no id is ever interpolated', () => {
    // A quotation number with a quote in it is a string, not SQL.
    const probe = recordReachableSql(SALES, 'quotation', "x' OR '1'='1");
    assert.ok(!probe.sql.includes("OR '1'='1"), 'the value stays in the parameters');
    assert.equal(probe.params[0], "x' OR '1'='1");
  });

  test('an unknown kind is refused loudly rather than waved through', () => {
    assert.throws(() => recordReachableSql(SALES, 'invoice', '1'), /Unknown record kind/);
  });

  test('the routes that gate on this cover exactly the kinds it knows', async () => {
    // A kind added to a route's list but not to the map would throw on every
    // request; one added to the map but not the route would never be gated.
    const { readFileSync } = await import('node:fs');
    const listed = (file) => {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      const m = src.match(/const ENTITIES = (?:new Set\()?\[([^\]]+)\]/);
      return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort();
    };
    const known = Object.keys(ENTITY_RECORDS).sort();
    assert.deepEqual(listed('../src/routes/timeline.js'), known, 'timeline');
    assert.deepEqual(listed('../src/routes/communications.js'), known, 'communications');
  });
});

/**
 * The other half of the same convention: a predicate over rows whose parent
 * is named in (entity, entity_id) text — tasks, notes, attachments. Built
 * from the same map, so this checks the map is actually what reaches the
 * SQL rather than a second copy of the rule drifting beside it.
 */
describe('rows that name their parent in text', () => {
  const clause = (alias = 't') => {
    const params = [];
    return { sql: parentClause(SALES, params, { kind: 'entity', alias }), params };
  };

  test('an admin is asked nothing at all', () => {
    assert.equal(parentClause(UNRESTRICTED, [], { kind: 'entity', alias: 't' }), '');
  });

  test('one owner parameter, however many kinds there are', () => {
    const { sql, params } = clause();
    assert.deepEqual(params, [7]);
    assert.equal(sql.match(/\$2/), null, 'nothing reaches for a second parameter');
    assert.equal((sql.match(/\$1/g) || []).length > 1, true, 'the one parameter is reused');
  });

  test('every kind the map knows has a branch, and nothing else does', () => {
    const { sql } = clause();
    for (const entity of Object.keys(ENTITY_RECORDS)) {
      assert.ok(sql.includes(`WHEN '${entity}' THEN`), `no branch for ${entity}`);
    }
    const branches = (sql.match(/WHEN '/g) || []).length;
    assert.equal(branches, Object.keys(ENTITY_RECORDS).length, 'a branch per kind, no more');
  });

  test('shared master data stays reachable; an unknown kind does not', () => {
    const { sql } = clause();
    assert.match(sql, /WHEN 'company' THEN true/);
    assert.match(sql, /WHEN 'contact' THEN true/);
    // The safe default for ownership that cannot be worked out is admin-only,
    // the same answer an unassigned record gets.
    assert.match(sql, /ELSE false/);
  });

  test('each kind is matched on the column ENTITY_RECORDS names', () => {
    const { sql } = clause();
    assert.match(sql, /x\.enquiry_no = t\.entity_id/);
    assert.match(sql, /x\.quotation_no = t\.entity_id/);
    assert.match(sql, /x\.project_id = t\.entity_id/);
    assert.match(sql, /x\.po_number = t\.entity_id/);
    // A payment stage has no natural key, so it is compared as text rather
    // than by casting the column the other kinds put their reference in.
    assert.match(sql, /x\.id::text = t\.entity_id/);
  });

  test('a stage reaches its owner through the purchase order above it', () => {
    const { sql } = clause();
    assert.match(sql, /JOIN purchase_orders epo ON epo\.po_number = x\.po_number/);
  });

  test('the alias the caller gives is the one the predicate reads', () => {
    assert.match(clause('"notes"').sql, /CASE "notes"\.entity/);
    assert.match(clause('parent').sql, /CASE parent\.entity/);
  });

  test('the three polymorphic resources declare it, and nothing declares it wrongly', () => {
    // A task also stands on the records in task_targets (#22), so it takes
    // the variant of the same rule that looks there too.
    const expected = { tasks: 'task_entity', notes: 'entity', attachments: 'entity' };
    for (const name of ['tasks', 'notes', 'attachments']) {
      assert.equal(resources[name].ownerScopedBy, expected[name], name);
      assert.equal(resources[name].ownerScoped, undefined, `${name} has no owner column of its own`);
      // The columns the predicate reads have to be columns the resource
      // actually writes, or a create could file a row under nothing.
      assert.ok(resources[name].columns.includes('entity'), `${name}.entity`);
      assert.ok(resources[name].columns.includes('entity_id'), `${name}.entity_id`);
    }
  });

  test('a file attached that way is reachable through the record it is on', () => {
    const params = [9];
    const sql = documentClause(SALES, params, { alias: 'd' });
    assert.deepEqual(params, [9, 7]);
    assert.match(sql, /FROM attachments dat\s+WHERE dat\.document_id = d\.id AND CASE dat\.entity/);
    // and the older parents are still there
    for (const table of ['quotations dq', 'purchase_orders dpo', 'payment_stages dps',
      'quotation_acceptances dqa', 'project_costs dpc', 'deliverables ddl']) {
      assert.ok(sql.includes(`FROM ${table}`), `lost ${table}`);
    }
  });
});
