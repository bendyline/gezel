/**
 * `mcp.relax-required-fields` — relaxes the upstream tool schema's
 * `required` array so a small model only sees the truly-essential
 * fields. Mirror of {@link McpDefaultMissingFields}, which then
 * fills in placeholders at call time so the upstream Zod check
 * still passes.
 *
 * The gezel-mcp server requires `about` and `missionObjectives` on
 * `create_project`, `about` on `create_gezel`, `description` on
 * `create_task` so frontier models can't ship empty placeholder
 * objects. For a 4B local model that schema is a footgun: the model
 * populates the most obvious arg (`name`) and ships the call,
 * upstream Zod rejects with `[{code:invalid_type,...}]`, the model
 * has no idea what to do, the flow stalls. Relaxing here, defaulting
 * in {@link McpDefaultMissingFields}, lets the call land.
 *
 * Migrated from `providers/mcp-wrappers/gezel-mcp-small-model.ts`.
 * The tier:tiny gate that lived inside the wrapper is gone — opt-in
 * via the manifest's `behaviors` array now controls applicability.
 */

import type { McpServerSpec, OpenAIFunctionTool } from '../../providers/mcp-bridge.js';
import { isGezelMcp } from '../../providers/mcp-wrappers/gezel-mcp-small-model.js';
import type {
  McpPreProcessVerdict,
  McpToolWrapper,
  McpToolWrapperContext,
} from '../../providers/mcp-wrappers/types.js';
import type { Behavior } from '../types.js';

/**
 * Per-tool schema relaxation. Each entry lists the args stripped
 * from the upstream `required` array so a small model only sees the
 * truly-essential fields. Mirror the auto-fill defaults in
 * {@link McpDefaultMissingFields} — if we strip a required field,
 * we MUST default it at preProcess time or the upstream call will
 * still reject.
 */
const RELAXATIONS: Record<string, readonly string[]> = {
  // `create_project` was removed from the model's tool surface (only
  // `start_project` / `start_job` are exposed now), so it no longer
  // needs a relaxation entry. The HTTP API still accepts the strict
  // shape for direct callers — nothing to relax there either.
  create_gezel: ['about'],
  create_task: ['description'],
  start_project: ['about', 'missionObjectives', 'taskDescription'],
  // `start_job`'s `specialistRole` stays required even after relaxation —
  // it's the one field the model genuinely has to choose; the rest
  // (long-prose about / mission / taskDescription) auto-fill via
  // `mcp.default-missing-fields`.
  start_job: ['about', 'missionObjectives', 'taskDescription'],
};

function relaxSchema(tool: OpenAIFunctionTool): OpenAIFunctionTool {
  const stripFields = RELAXATIONS[tool.name];
  if (!stripFields) return tool;
  const params = tool.parameters as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') return tool;
  const required = params.required;
  if (!Array.isArray(required)) return tool;
  const filtered = required.filter((r) => typeof r === 'string' && !stripFields.includes(r));
  if (filtered.length === required.length) return tool;
  return {
    ...tool,
    parameters: {
      ...(params as Record<string, unknown>),
      required: filtered,
    },
  };
}

const RelaxRequiredFieldsWrapper: McpToolWrapper = {
  id: 'mcp-relax-required-fields',
  matches: (spec: McpServerSpec) => isGezelMcp(spec),
  decorateTools(tools: OpenAIFunctionTool[], _ctx: McpToolWrapperContext): OpenAIFunctionTool[] {
    return tools.map(relaxSchema);
  },
  async preProcess(): Promise<McpPreProcessVerdict> {
    return { kind: 'allow' };
  },
};

export const McpRelaxRequiredFields: Behavior = {
  id: 'mcp.relax-required-fields',
  description:
    'Strips non-obvious required args from gezel-mcp create-* tool schemas so small models can call them without filling in every required string. Pair with `mcp.default-missing-fields` to avoid upstream Zod rejection.',
  mcpWrapper: RelaxRequiredFieldsWrapper,
};
