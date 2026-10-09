import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { JSON_SCHEMA_DIALECT, withSupportedSchemaDialect } from '../src/lib/mcpSchema.js';

/**
 * The MCP SDK converts our Zod shapes with no target and its converter reads a
 * missing target as draft-7, so every tool went out declaring
 * "http://json-schema.org/draft-07/schema#" while the SDK's own types promised
 * 2020-12. Claude Desktop's validator is 2020-12 only and refused list_tasks
 * before calling it.
 *
 * Needs no database, so it runs wherever the suite does. What it cannot see is
 * whether the correction is wired into the transport at all — mcp.test.js walks
 * the real tools/list for that.
 */

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

const toolsReply = (tools) => ({ jsonrpc: '2.0', id: 1, result: { tools } });

const listTasks = () => ({
  name: 'list_tasks',
  description: 'Open tasks, soonest due first.',
  inputSchema: { $schema: DRAFT_07, type: 'object', properties: { limit: { type: 'integer' } } },
  outputSchema: { $schema: DRAFT_07, type: 'object', properties: { items: { type: 'array' }, has_more: { type: 'boolean' } }, required: ['items'] },
  annotations: { readOnlyHint: true },
});

describe('the dialect the tool schemas declare', () => {
  test('both schemas come out as 2020-12, which is the one clients validate with', () => {
    const [tool] = withSupportedSchemaDialect(toolsReply([listTasks()])).result.tools;

    assert.equal(tool.inputSchema.$schema, JSON_SCHEMA_DIALECT);
    assert.equal(tool.outputSchema.$schema, JSON_SCHEMA_DIALECT);
    assert.equal(JSON_SCHEMA_DIALECT, 'https://json-schema.org/draft/2020-12/schema');
  });

  test('no draft-07 survives anywhere in the reply', () => {
    // The assertion the bug would have failed, written the way the symptom
    // read: not "which field" but "is it in there at all".
    const out = withSupportedSchemaDialect(toolsReply([listTasks(), listTasks()]));

    assert.ok(!JSON.stringify(out).includes('draft-07'), 'a draft-07 dialect reached a client');
  });

  test('nothing but the dialect line changes', () => {
    // The bodies are already 2020-12 — zod emits the same bytes for both
    // targets once $schema is off — so a converted schema is the wrong fix and
    // a dropped keyword would be a silently narrower contract.
    const before = listTasks();
    const [after] = withSupportedSchemaDialect(toolsReply([listTasks()])).result.tools;

    const strip = ({ $schema, ...rest }) => rest;
    assert.deepEqual(strip(after.inputSchema), strip(before.inputSchema));
    assert.deepEqual(strip(after.outputSchema), strip(before.outputSchema));
    assert.equal(after.name, before.name);
    assert.equal(after.description, before.description);
    assert.deepEqual(after.annotations, before.annotations);
  });

  test('a tool with no output schema does not acquire one', () => {
    // Tools registered without `out` must stay that way: an empty outputSchema
    // would tell a client to expect structuredContent that never comes.
    const [tool] = withSupportedSchemaDialect(toolsReply([{ name: 'create_task', inputSchema: { $schema: DRAFT_07, type: 'object' } }])).result.tools;

    assert.ok(!('outputSchema' in tool), 'an output schema appeared out of nowhere');
    assert.equal(tool.inputSchema.$schema, JSON_SCHEMA_DIALECT);
  });

  test('a schema that already declares 2020-12 is left saying so', () => {
    const ready = { name: 'x', inputSchema: { $schema: JSON_SCHEMA_DIALECT, type: 'object' } };

    const [tool] = withSupportedSchemaDialect(toolsReply([ready])).result.tools;
    assert.equal(tool.inputSchema.$schema, JSON_SCHEMA_DIALECT);
  });

  test('a schema with no dialect at all is given the one it is written in', () => {
    const [tool] = withSupportedSchemaDialect(toolsReply([{ name: 'x', inputSchema: { type: 'object' } }])).result.tools;

    assert.equal(tool.inputSchema.$schema, JSON_SCHEMA_DIALECT);
  });

  test('a field a tool happens to call $schema or definitions is left alone', () => {
    // get_kpis returns its glossary in a field called `definitions`, which is
    // a property name and not the draft-7 keyword of that name. Only the
    // schema's own dialect line is ours to write.
    const tool = {
      name: 'get_kpis',
      outputSchema: { $schema: DRAFT_07, type: 'object', properties: { definitions: { type: 'object' }, $schema: { type: 'string' }, period: { type: 'object' } } },
    };

    const [out] = withSupportedSchemaDialect(toolsReply([tool])).result.tools;
    assert.equal(out.outputSchema.$schema, JSON_SCHEMA_DIALECT);
    assert.deepEqual(out.outputSchema.properties, tool.outputSchema.properties, 'a declared field was rewritten');
    assert.deepEqual(Object.keys(out.outputSchema.properties), ['definitions', '$schema', 'period']);
  });

  test('the message it was given is not modified', () => {
    // It sits in front of every send, so mutating would rewrite the SDK's own
    // registry objects underneath it.
    const message = toolsReply([listTasks()]);

    const out = withSupportedSchemaDialect(message);
    assert.equal(message.result.tools[0].outputSchema.$schema, DRAFT_07, 'the original was rewritten in place');
    assert.notEqual(out, message);
  });

  test('every other message passes straight through, by identity', () => {
    // Tool results carry the rows themselves. Walking or copying them on the
    // way out would put the whole response through this for nothing.
    for (const message of [
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"items":[]}' }], structuredContent: { items: [] } } },
      { jsonrpc: '2.0', id: 3, result: {} },
      { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]) {
      assert.equal(withSupportedSchemaDialect(message), message);
    }
  });

  test('a reply it cannot read is handed back rather than thrown on', () => {
    // Anything in front of send() must never be the reason a response fails.
    for (const message of [null, undefined, {}, 'not a message', 42, { result: { tools: 'not an array' } }]) {
      assert.equal(withSupportedSchemaDialect(message), message);
    }
    assert.doesNotThrow(() => withSupportedSchemaDialect({ result: { tools: [null, 'x', 7] } }));
  });
});
