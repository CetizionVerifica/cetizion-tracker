/**
 * The dialect the tool schemas go out declaring.
 *
 * MCP says a tool's inputSchema and outputSchema are JSON Schema 2020-12, and
 * the SDK's own spec types say so twice — "A JSON Schema 2020-12 object", and
 * "Defaults to JSON Schema 2020-12 when no explicit $schema is provided". Its
 * tools/list handler then converts our Zod shapes without asking for that:
 *
 *   toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'output' })
 *
 * and the converter reads a missing target as draft-7 —
 * `mapMiniTarget(t) { if (!t) return 'draft-7'; ... }` — so every schema left
 * here stamped "$schema": "http://json-schema.org/draft-07/schema#". Claude
 * Desktop compiles outputSchema to check structuredContent against it, its
 * validator is 2020-12 only, and it refused the tool before calling it:
 *
 *   Tool 'list_tasks' has an invalid outputSchema: JSON Schema declares an
 *   unsupported dialect ("$schema": "http://json-schema.org/draft-07/schema#").
 *
 * Both schemas carry it, not just the output one; a client that only reads
 * inputSchema to build a call has the same thing waiting for it.
 *
 * Only the declaration is wrong. zod's draft-7 and draft-2020-12 output is the
 * same bytes once $schema is removed, for every construct these tools use —
 * objects, arrays, records, unions, enums, literals, nullable and optional,
 * described and integer-bounded numbers. There are no tuples and no recursion
 * in them, which is all the two dialects would have to disagree about: no
 * prefixItems, no $defs, no definitions, no $ref. A 2020-12 validator compiles
 * the body as it stands and rejects it only for the dialect line. So this
 * replaces that line rather than converting anything.
 *
 * Nothing about validation moves. The SDK checks structuredContent against the
 * Zod schema, never against the JSON Schema it sent — so declaring the output
 * shape still catches a query that quietly stops returning a column, which is
 * the reason for declaring it.
 *
 * Upgrading is not the fix: 1.32.1, the newest at the time of writing, carries
 * the identical mapMiniTarget. When a release does emit 2020-12 this becomes a
 * no-op rather than a disagreement, because it writes the value that release
 * would have written.
 */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** The same schema, declaring the dialect its body is already written in. */
const declare2020 = (schema) =>
  (schema && typeof schema === 'object' && !Array.isArray(schema) ? { ...schema, $schema: JSON_SCHEMA_DIALECT } : schema);

/**
 * A tools/list reply with its tool schemas declaring a dialect clients support.
 *
 * Anything else passes through untouched and by identity: this sits in front of
 * every message the transport sends, and tool results — which carry the rows
 * themselves — must not be walked or copied on the way out.
 */
export function withSupportedSchemaDialect(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.map((tool) => {
        if (!tool || typeof tool !== 'object') return tool;
        return {
          ...tool,
          ...(tool.inputSchema ? { inputSchema: declare2020(tool.inputSchema) } : {}),
          ...(tool.outputSchema ? { outputSchema: declare2020(tool.outputSchema) } : {}),
        };
      }),
    },
  };
}
