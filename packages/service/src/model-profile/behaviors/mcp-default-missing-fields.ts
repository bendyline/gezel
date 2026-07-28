/**
 * `mcp.default-missing-fields` — auto-fills missing required args on
 * gezel-mcp create-* tool calls with sensible self-aware
 * placeholders. Pair with {@link McpRelaxRequiredFields}, which
 * removes the same fields from the schema so small models don't
 * "see" them.
 *
 * The placeholders are deliberately self-aware ("Initial setup —
 * fill this in via update_project once scope is clear.") so the
 * user can spot them in the UI and either edit directly or ask the
 * gezel to update them. A placeholder project is strictly better
 * than no project for flow-completion purposes.
 *
 * Migrated from `providers/mcp-wrappers/gezel-mcp-small-model.ts`'s
 * `preProcess`/`fillDefaults`. The tier:tiny gate that lived inside
 * the wrapper is gone — opt-in via the manifest controls applicability.
 */

import { ExpectedDeliverableSchema } from '@bendyline/gezel';
import type { McpServerSpec } from '../../providers/mcp-bridge.js';
import { isGezelMcp } from '../../providers/mcp-wrappers/gezel-mcp-small-model.js';
import type {
  McpPreProcessVerdict,
  McpToolWrapper,
  McpToolWrapperContext,
} from '../../providers/mcp-wrappers/types.js';
import type { Behavior } from '../types.js';

/**
 * Default values used at preProcess time to fill in any required
 * field the model omitted. Each default must be long enough to pass
 * the upstream Zod min-length checks.
 */
const DEFAULTS = {
  projectAbout:
    'Project created from a chat conversation. The user (or a voorman gezel) should update this with the actual scope, target audience, and out-of-scope items via update_project once the project direction is clear.',
  projectMissionObjectives:
    'Initial setup — define concrete success criteria via update_project once scope is clear.',
  taskDescription:
    'Initial task setup — fill in the job-to-be-done via update_task once scope is clear.',
} as const;

const EXPECTED_DELIVERABLE_ALIAS_KEYS = [
  'expected_deliverable',
  'expectedLeverage',
  'expectedDeliverableHint',
] as const;

type DeliverableRepair =
  | { kind: 'unchanged' }
  | { kind: 'allow'; args: Record<string, unknown> }
  | { kind: 'reject'; error: string };

function supportsExpectedDeliverable(toolName: string): boolean {
  return (
    toolName === 'message_gezel' ||
    toolName === 'ask_gezel' ||
    toolName === 'ask_specialist' ||
    toolName.startsWith('delegate_') ||
    toolName.startsWith('consult_')
  );
}

function parseObjectLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const NESTED_FILE_DELIVERABLE_KINDS = new Set(['file', 'generic-file', 'markdown-doc']);

/**
 * Recover one narrow local-model inversion of the deliverable schema:
 *
 *   { kind: 'file', checks: [{ kind: 'file', filePath: 'plan.md' }] }
 *   { checks: [{ kind: 'generic-file', file: 'plan.md' }] }
 *
 * `checks` normally contains real GateCheck objects, so this must stay
 * deliberately conservative. A single file-shaped pseudo-check with no
 * extra fields is unambiguous; multiple checks, unknown aliases, conflicting
 * paths, and real-but-invalid gate checks remain errors for the model to fix.
 */
function recoverNestedFileDeliverable(
  candidate: Record<string, unknown>,
): { kind: 'file'; filePath: string } | null {
  if (!Object.keys(candidate).every((key) => key === 'kind' || key === 'checks')) return null;
  if (candidate.kind !== undefined && candidate.kind !== 'file') return null;
  if (!Array.isArray(candidate.checks) || candidate.checks.length !== 1) return null;

  const nested = parseObjectLike(candidate.checks[0]);
  if (!nested) return null;
  if (!Object.keys(nested).every((key) => key === 'kind' || key === 'filePath' || key === 'file')) {
    return null;
  }
  if (typeof nested.kind !== 'string' || !NESTED_FILE_DELIVERABLE_KINDS.has(nested.kind)) {
    return null;
  }

  const filePath = typeof nested.filePath === 'string' ? nested.filePath.trim() : null;
  const fileAlias = typeof nested.file === 'string' ? nested.file.trim() : null;
  if (filePath !== null && fileAlias !== null && filePath !== fileAlias) return null;
  const resolvedPath = filePath ?? fileAlias;
  return resolvedPath ? { kind: 'file', filePath: resolvedPath } : null;
}

function inferDeliverable(value: unknown): Record<string, unknown> | null {
  const raw = parseObjectLike(value);
  if (!raw) return null;
  const candidate = { ...raw };
  if (
    candidate.kind === undefined &&
    (typeof candidate.filePath === 'string' ||
      Array.isArray(candidate.checks) ||
      Array.isArray(candidate.scripts))
  ) {
    candidate.kind = 'file';
  }
  const parsed = ExpectedDeliverableSchema.safeParse(candidate);
  return parsed.success ? parsed.data : recoverNestedFileDeliverable(candidate);
}

function repairExpectedDeliverableArgs(
  toolName: string,
  args: Record<string, unknown>,
): DeliverableRepair {
  if (!supportsExpectedDeliverable(toolName)) return { kind: 'unchanged' };

  const aliasKey = EXPECTED_DELIVERABLE_ALIAS_KEYS.find((key) => key in args);
  const sourceKey = 'expectedDeliverable' in args ? 'expectedDeliverable' : aliasKey;
  if (!sourceKey) return { kind: 'unchanged' };

  const deliverable = inferDeliverable(args[sourceKey]);
  if (!deliverable) {
    return {
      kind: 'reject',
      error: `ERROR: \`${toolName}\` received a malformed expected deliverable hint. Use the exact field \`expectedDeliverable: { kind: "file", filePath: "<path>" }\`, or omit it for a normal chat handoff. Do not put the file declaration inside \`checks\`; that array is only for real completion-gate checks such as \`{ kind: "minBytes", file: "<path>", bytes: 100 }\`.`,
    };
  }

  const filled: Record<string, unknown> = { ...args, expectedDeliverable: deliverable };
  for (const key of EXPECTED_DELIVERABLE_ALIAS_KEYS) delete filled[key];
  return { kind: 'allow', args: filled };
}

function fillDefaults(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (toolName === 'writeFile') {
    const filled = { ...args };
    if (
      typeof filled.content === 'string' &&
      looksLikeSingleFileHtml(filled.content) &&
      !isTrustworthySingleFileHtmlPath(filled.path)
    ) {
      filled.path = 'index.html';
      return filled;
    }
    return null;
  }
  if (toolName === 'message_gezel') {
    const filled = { ...args };
    let mutated = false;
    const targetValue =
      filled.Gezer ??
      filled.gezer ??
      filled.Gezel ??
      filled.targetGezelId ??
      filled.toGezelId ??
      filled.toGezelIdOrName ??
      filled.target;
    const messageValue = filled.Message ?? filled.text ?? filled.Text;
    const projectValue = filled.projectId ?? filled.Project;
    if (filled.gezel === undefined && typeof targetValue === 'string' && targetValue.trim()) {
      filled.gezel = targetValue;
      mutated = true;
    }
    if (filled.message === undefined && typeof messageValue === 'string' && messageValue.trim()) {
      filled.message = messageValue;
      mutated = true;
    }
    if (filled.project === undefined && typeof projectValue === 'string' && projectValue.trim()) {
      filled.project = projectValue;
      mutated = true;
    }
    for (const key of [
      'Gezer',
      'gezer',
      'Gezel',
      'targetGezelId',
      'toGezelId',
      'toGezelIdOrName',
      'target',
      'Message',
      'text',
      'Text',
      'projectId',
      'Project',
    ]) {
      if (key in filled) delete filled[key];
    }
    return mutated ? filled : null;
  }
  // `create_project` is no longer exposed as an MCP tool — only the
  // `start_project` macro is. `create_gezel` also needs no default:
  // omitting `about` deliberately selects the role/template's curated
  // prompt instead of a generic placeholder.
  if (toolName === 'create_task') {
    const filled = { ...args };
    if (typeof filled.description !== 'string' || filled.description.length < 40) {
      filled.description = DEFAULTS.taskDescription;
      return filled;
    }
    return null;
  }
  if (toolName === 'start_project' || toolName === 'start_job') {
    // Both macros take the same project-shaped fields plus
    // taskDescription. Mirror the relaxer's strip list so the call
    // shape matches: model omits any of the three, we backfill with
    // the same self-aware placeholders the per-tool defaults use.
    // `start_job` also requires `specialistRole`, but that's the one
    // field the model genuinely has to choose — we don't auto-fill
    // it (no sensible default; would mask a real bug).
    const filled = { ...args };
    let mutated = false;
    if (typeof filled.about !== 'string' || filled.about.length < 60) {
      filled.about = DEFAULTS.projectAbout;
      mutated = true;
    }
    if (typeof filled.missionObjectives !== 'string' || filled.missionObjectives.length < 40) {
      filled.missionObjectives = DEFAULTS.projectMissionObjectives;
      mutated = true;
    }
    if (typeof filled.taskDescription !== 'string' || filled.taskDescription.length < 40) {
      filled.taskDescription = DEFAULTS.taskDescription;
      mutated = true;
    }
    return mutated ? filled : null;
  }
  return null;
}

function looksLikeSingleFileHtml(content: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(content) && /<script[\s>]/i.test(content);
}

function isMissingOrUnusableWritePath(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return /^[,.:;'"`]+$/.test(trimmed);
}

function isTrustworthySingleFileHtmlPath(value: unknown): boolean {
  if (isMissingOrUnusableWritePath(value)) return false;
  return /\.html?$/i.test((value as string).trim());
}

const DefaultMissingFieldsWrapper: McpToolWrapper = {
  id: 'mcp-default-missing-fields',
  matches: (spec: McpServerSpec) => isGezelMcp(spec),
  async preProcess(
    toolName: string,
    args: Record<string, unknown>,
    _ctx: McpToolWrapperContext,
  ): Promise<McpPreProcessVerdict> {
    const deliverableRepair = repairExpectedDeliverableArgs(toolName, args);
    if (deliverableRepair.kind === 'reject') {
      return { kind: 'reject', error: deliverableRepair.error };
    }
    const effectiveArgs = deliverableRepair.kind === 'allow' ? deliverableRepair.args : args;
    const filled = fillDefaults(toolName, effectiveArgs);
    if (!filled) {
      return deliverableRepair.kind === 'allow'
        ? { kind: 'allow', args: effectiveArgs }
        : { kind: 'allow' };
    }
    return { kind: 'allow', args: filled };
  },
};

export const McpDefaultMissingFields: Behavior = {
  id: 'mcp.default-missing-fields',
  description:
    'Auto-fills missing required args on gezel-mcp create-* tools with self-aware placeholder text. Pair with `mcp.relax-required-fields` so the schema and the call shape match.',
  mcpWrapper: DefaultMissingFieldsWrapper,
};
