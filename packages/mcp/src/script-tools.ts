/**
 * Project-type script tools — dynamic per-session MCP registrations.
 *
 * A project type's manifest can declare named tools backed by its
 * sandboxed SDK scripts (`tools: [{name, script, inputs, bind}]`). The
 * chat manager resolves the applied type at session build and passes the
 * declarations to this subprocess via `GEZEL_SCRIPT_TOOLS`; each becomes
 * a real named tool dispatching through the exact `run_script` pipeline
 * (ScriptRunner input validation + capability policy apply unchanged).
 * Named registrations make the tools individually hook-matchable and
 * spare small models the run_script name/input indirection.
 */

import {
  type ProjectTypeTool,
  ProjectTypeToolSchema,
  type RunScriptResponse,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type ZodRawShape, type ZodTypeAny, z } from 'zod';
import { ExecutionToolOutputSchema, errorResult, okResult } from './tool-contracts.js';
import { normalizeToolNameSpelling } from './tool-inventory.js';

function warn(message: string): void {
  process.stderr.write(`gezel-mcp script-tools: ${message}\n`);
}

/**
 * Parse the `GEZEL_SCRIPT_TOOLS` payload. Invalid JSON, non-arrays, and
 * entries that fail schema validation are skipped with a stderr note —
 * a malformed declaration must never take down the whole tool surface.
 */
export function parseScriptToolSpecs(raw: string | undefined): ProjectTypeTool[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn('GEZEL_SCRIPT_TOOLS is not valid JSON; ignoring');
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn('GEZEL_SCRIPT_TOOLS is not an array; ignoring');
    return [];
  }
  const specs: ProjectTypeTool[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const result = ProjectTypeToolSchema.safeParse(entry);
    if (!result.success) {
      warn(`skipping invalid tool spec: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
      continue;
    }
    if (seen.has(result.data.name)) {
      warn(`skipping duplicate tool spec '${result.data.name}'`);
      continue;
    }
    seen.add(result.data.name);
    specs.push(result.data);
  }
  return specs;
}

/**
 * Map a declared JSON-schema `inputs` object onto a zod raw shape for
 * `server.tool`. Advisory only — the ScriptRunner re-validates against
 * the script's own `meta.inputs` — so unknown constructs degrade to
 * permissive validators instead of failing registration.
 */
export function jsonSchemaToZodShape(inputs: Record<string, unknown> | undefined): ZodRawShape {
  const properties = (inputs as { properties?: unknown } | undefined)?.properties;
  if (!properties || typeof properties !== 'object') return {};
  const requiredRaw = (inputs as { required?: unknown }).required;
  const required = new Set(Array.isArray(requiredRaw) ? requiredRaw.map(String) : []);

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, specRaw] of Object.entries(properties as Record<string, unknown>)) {
    const spec = (specRaw ?? {}) as Record<string, unknown>;
    let field: ZodTypeAny;
    const enumValues = Array.isArray(spec.enum) ? spec.enum : null;
    if (enumValues && enumValues.length > 0 && enumValues.every((v) => typeof v === 'string')) {
      field = z.enum(enumValues as [string, ...string[]]);
    } else {
      switch (spec.type) {
        case 'string':
          field = z.string();
          break;
        case 'number':
        case 'integer':
          field = z.number();
          break;
        case 'boolean':
          field = z.boolean();
          break;
        case 'array':
          field = z.array(z.unknown());
          break;
        case 'object':
          field = z.record(z.string(), z.unknown());
          break;
        default:
          field = z.unknown();
      }
    }
    if (typeof spec.description === 'string' && spec.description) {
      field = field.describe(spec.description);
    }
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

/** The `run_script` result rendering, shared with the named tool handlers. */
export function formatScriptRunResult(res: RunScriptResponse): CallToolResult {
  const header = `run ${res.runId} — status: ${res.status}${
    res.error ? ` — error: ${res.error}` : ''
  }`;
  const callsSummary = res.callsSummary.length
    ? `\ncalls:\n${res.callsSummary
        .map((c) => `  - ${c.kind} (${c.durationMs}ms)${c.error ? ` — ${c.error}` : ''}`)
        .join('\n')}`
    : '';
  const outputBlock =
    res.output === undefined ? '' : `\noutput:\n${JSON.stringify(res.output, null, 2)}`;
  const text = `${header}${outputBlock}${callsSummary}`;
  if (res.status === 'error') return errorResult(text);
  return okResult(
    ExecutionToolOutputSchema,
    {
      summary: header,
      state: res.status === 'running' ? 'running' : 'completed',
      ok: res.status === 'ok',
      runId: res.runId,
      calls: res.callsSummary,
      ...(res.output !== undefined ? { output: res.output } : {}),
      ...(res.error ? { error: res.error } : {}),
    },
    { text },
  );
}

/**
 * Register each declared tool on the server. Names colliding with the
 * static inventory are skipped — the builtin wins and registration-time
 * duplicates would throw inside McpServer.
 */
export function registerScriptTools(
  server: McpServer,
  specs: ProjectTypeTool[],
  deps: { api: GezelClient; projectId: string; reservedNames: ReadonlySet<string> },
): string[] {
  const registered: string[] = [];
  const normalizedReservedNames = new Set([...deps.reservedNames].map(normalizeToolNameSpelling));
  for (const spec of specs) {
    if (normalizedReservedNames.has(normalizeToolNameSpelling(spec.name))) {
      warn(`skipping tool '${spec.name}': spelling is reserved by the built-in tool surface`);
      continue;
    }
    server.tool(spec.name, spec.description, jsonSchemaToZodShape(spec.inputs), async (args) => {
      try {
        const res = await deps.api.runProjectScript(deps.projectId, {
          name: spec.script,
          input: { ...(args as Record<string, unknown>), ...(spec.bind ?? {}) },
        });
        return formatScriptRunResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`${spec.name} failed: ${msg}`);
      }
    });
    registered.push(spec.name);
  }
  return registered;
}
