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
    out[key] = compactSchema(child);
  }
  return out;
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
