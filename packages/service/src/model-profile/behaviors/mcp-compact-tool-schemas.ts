/**
 * `mcp.compact-tool-schemas` - trims MCP tool schema prose for local
 * models that already get role/tool guidance in the system prompt.
 *
 * llama.cpp receives the full function schema on every first turn.
 * For gezel-mcp that means long descriptions on the tool and each
 * property, which cost minutes of prefill on 12B laptop-class models.
 * The JSON schema's structural contract is what the runtime validates,
 * so this wrapper keeps types/properties/required/enums and removes
 * prose-only metadata.
 */

import type { McpServerSpec, OpenAIFunctionTool } from '../../providers/mcp-bridge.js';
import { isGezelMcp } from '../../providers/mcp-wrappers/gezel-mcp-small-model.js';
import type { McpToolWrapper, McpToolWrapperContext } from '../../providers/mcp-wrappers/types.js';
import type { Behavior } from '../types.js';

const MAX_TOOL_DESCRIPTION_CHARS = 96;
const PROSE_SCHEMA_KEYS = new Set([
  '$comment',
  'default',
  'description',
  'examples',
  'markdownDescription',
  'title',
]);

function compactDescription(description: string): string {
  const trimmed = description.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAX_TOOL_DESCRIPTION_CHARS) return trimmed;
  const firstSentence = trimmed.match(/^[^.!?]*[.!?](?=\s|$)/)?.[0] ?? trimmed;
  if (firstSentence.length <= MAX_TOOL_DESCRIPTION_CHARS) return firstSentence;
  const clipped = firstSentence.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1).trimEnd();
  return `${clipped}...`;
}

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PROSE_SCHEMA_KEYS.has(key)) continue;
    out[key] =
      key === 'expectedDeliverable'
        ? compactExpectedDeliverable(compactSchema(child))
        : compactSchema(child);
  }
  return out;
}

/**
 * The deliverable contract rides on all 13 delegation/messaging tools, so
 * every char here is paid ~13× per request. Two targeted cuts, both
 * census-backed (2026-08-03, every recorded delegation call):
 *   - `checks`: slim the gate-kind union (see compactChecksUnion).
 *   - `scripts`: drop from the wire entirely — 0 of 417 delegation calls
 *     ever authored it inline (~278 chars × 13 tools). Still emittable:
 *     wire schemas are advisory and the server validates real calls.
 */
function compactExpectedDeliverable(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const node = schema as Record<string, unknown>;
  const properties = node.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return schema;
  const props = { ...(properties as Record<string, unknown>) };
  delete props.scripts;
  if (props.checks !== undefined) props.checks = compactChecksUnion(props.checks);
  return { ...node, properties: props };
}

/**
 * Gate-check kinds that keep their full per-variant schema on the wire.
 * Chosen from a census of every recorded delegation call (2026-08-03):
 * sniff 57, contains 26, minBytes 19, chat 11 — 84% of all inline usage.
 * The remaining ~10 kinds each appeared ≤5 times; they collapse into one
 * permissive variant that still NAMES every kind (enum), so a model
 * following a craftbook that specifies an exotic gate can still emit it —
 * wire schemas are advisory (server-side zod validates real calls, and
 * llama does not grammar-constrain tool args today).
 */
const CHECK_KINDS_KEPT_VERBOSE = new Set(['sniff', 'contains', 'minBytes', 'chat']);

/**
 * The `expectedDeliverable.checks` oneOf is the single heaviest structure
 * on the tool wire: ~7.1K chars of per-kind variants, stamped into all 13
 * delegation/messaging tools — ~54% of the ENTIRE compacted tool surface
 * (measured 2026-08-03: 74-tool Developer wire was ~100K chars, most of it
 * this union). Keep full schemas for the head kinds models actually author
 * inline; fold the tail into one variant with every kind name preserved.
 */
function compactChecksUnion(checksSchema: unknown): unknown {
  if (!checksSchema || typeof checksSchema !== 'object' || Array.isArray(checksSchema)) {
    return checksSchema;
  }
  const schema = checksSchema as Record<string, unknown>;
  const items = schema.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) return checksSchema;
  const union = (items as Record<string, unknown>).oneOf;
  if (!Array.isArray(union) || union.length <= CHECK_KINDS_KEPT_VERBOSE.size + 1) {
    return checksSchema;
  }
  const kindOf = (variant: unknown): string | null => {
    if (!variant || typeof variant !== 'object') return null;
    const kind = ((variant as Record<string, unknown>).properties as Record<string, unknown>)?.kind;
    const konst =
      (kind as Record<string, unknown>)?.const ?? (kind as Record<string, unknown>)?.enum;
    if (typeof konst === 'string') return konst;
    if (Array.isArray(konst) && typeof konst[0] === 'string') return konst[0];
    return null;
  };
  const kept: unknown[] = [];
  const folded: string[] = [];
  for (const variant of union) {
    const kind = kindOf(variant);
    if (kind && CHECK_KINDS_KEPT_VERBOSE.has(kind)) kept.push(variant);
    else if (kind) folded.push(kind);
    else kept.push(variant);
  }
  if (folded.length === 0) return checksSchema;
  kept.push({
    type: 'object',
    properties: {
      kind: { type: 'string', enum: folded },
      file: { type: 'string' },
    },
    required: ['kind'],
    additionalProperties: true,
  });
  return { ...schema, items: { ...(items as Record<string, unknown>), oneOf: kept } };
}

function compactTool(
  tool: OpenAIFunctionTool,
  schemaByTool: Map<string, Record<string, unknown>>,
): OpenAIFunctionTool {
  schemaByTool.set(tool.name, tool.parameters);
  return {
    ...tool,
    description: compactDescription(tool.description),
    parameters: compactSchema(tool.parameters) as Record<string, unknown>,
  };
}

function propertiesFor(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null;
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  return properties as Record<string, unknown>;
}

function normalizeArgKeyCasing(
  value: unknown,
  schema: unknown,
): { value: unknown; changed: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value, changed: false };
  }
  const properties = propertiesFor(schema);
  if (!properties) return { value, changed: false };
  const canonicalByLower = new Map<string, string>();
  for (const key of Object.keys(properties)) canonicalByLower.set(key.toLowerCase(), key);

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const canonical = canonicalByLower.get(key.toLowerCase()) ?? key;
    const childSchema = properties[canonical];
    const normalizedChild = normalizeArgKeyCasing(child, childSchema);
    if (canonical !== key || normalizedChild.changed) changed = true;
    if (out[canonical] === undefined) {
      out[canonical] = normalizedChild.value;
    } else if (canonical === key) {
      out[key] = normalizedChild.value;
    } else {
      changed = true;
    }
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

function buildCompactToolSchemasWrapper(): McpToolWrapper {
  const schemaByTool = new Map<string, Record<string, unknown>>();
  return {
    id: 'mcp-compact-tool-schemas',
    matches: (spec: McpServerSpec) => isGezelMcp(spec),
    decorateTools(tools: OpenAIFunctionTool[], ctx: McpToolWrapperContext): OpenAIFunctionTool[] {
      schemaByTool.clear();
      // Cloud providers do not pay a local prefill cost. Large on-device
      // models still do: DS4 took five minutes to prefill a 25.6K-token
      // tictactoe prompt after tool-schema growth. When this behavior is
      // explicitly selected, compact every local tier and preserve the full
      // callable JSON shape; only prose metadata is removed.
      if (ctx.modelTier === 'cloud') return tools;
      return tools.map((tool) => compactTool(tool, schemaByTool));
    },
    async preProcess(toolName: string, args: Record<string, unknown>) {
      const schema = schemaByTool.get(toolName);
      const normalized = normalizeArgKeyCasing(args, schema);
      if (!normalized.changed || !normalized.value || typeof normalized.value !== 'object') {
        return { kind: 'allow' as const };
      }
      return { kind: 'allow' as const, args: normalized.value as Record<string, unknown> };
    },
  };
}

export const McpCompactToolSchemas: Behavior = {
  id: 'mcp.compact-tool-schemas',
  description:
    'Removes prose-only metadata from gezel-mcp function schemas for local models while keeping the callable JSON shape intact.',
  mcpWrapper: () => buildCompactToolSchemasWrapper(),
};
