/**
 * Zod / JSON-schema error translator — runs against every MCP server,
 * for every model tier.
 *
 * Upstream MCP servers (gezel-mcp, playwright-mcp, anything wrapping
 * Zod) report validation failures as a dense JSON blob:
 *
 *   MCP error -32602: Input validation error: Invalid arguments for
 *   tool create_project: [
 *     {"code":"invalid_type","expected":"string","received":"undefined",
 *      "path":["about"],"message":"Required"},
 *     {"code":"invalid_type",...,"path":["missionObjectives"],...}
 *   ]
 *
 * Frontier models can usually parse this. Smaller models can't, and
 * even frontier models do better with plain English. This wrapper
 * detects the validation-error shape, parses the embedded JSON, and
 * rewrites the text into a one-line teaching message:
 *
 *   ERROR: create_project rejected by validator. Missing required
 *   fields: `about`, `missionObjectives`. Retry with both supplied.
 *
 * Universal — runs at every tier — because the translation strictly
 * dominates the raw blob: capable models are no worse off, smaller
 * models recover much better.
 */
import type { McpToolWrapper } from './types.js';

interface ZodIssue {
  code?: string;
  path?: ReadonlyArray<string | number>;
  message?: string;
  expected?: string;
  received?: string;
}

function isMissingValueIssue(issue: ZodIssue): boolean {
  if (issue.code !== 'invalid_type') return false;
  // Zod 3 included `received: "undefined"` in serialized issues. Zod 4
  // moved that detail into the human message and omits `received`, so
  // checking only the field mislabels required fields as "got unknown".
  return (
    issue.received === 'undefined' ||
    (issue.received === undefined && /\breceived undefined\b/i.test(issue.message ?? ''))
  );
}

const VALIDATION_PREFIX_RE =
  /(?:Input validation error: )?Invalid arguments for tool ([\w-]+):\s*(\[[\s\S]*\])/;

function tryParseIssues(blob: string): ZodIssue[] | null {
  try {
    const parsed = JSON.parse(blob);
    return Array.isArray(parsed) ? (parsed as ZodIssue[]) : null;
  } catch {
    return null;
  }
}

function pathLabel(path: ReadonlyArray<string | number> | undefined): string {
  if (!path || path.length === 0) return '(root)';
  return path.map((p) => String(p)).join('.');
}

function isDraftStatusIssue(toolName: string, issue: ZodIssue): boolean {
  return (
    toolName === 'set_task_status' &&
    pathLabel(issue.path) === 'status' &&
    (issue.received === 'draft' || /\bdraft\b/i.test(issue.message ?? ''))
  );
}

function draftStatusGuidance(): string {
  return [
    'ERROR: `set_task_status` cannot set a task to `draft`.',
    'Do not retry `set_task_status` with `status: "draft"`.',
    'If you are authoring a draft plan, keep it in draft and attach gates to build steps with `set_step_deliverable({ task: "<draft ref>", stepId: "<step id>", path: "<deliverable path>", kind: "<kind>" })`.',
    'Use `activate_task` only after the draft plan is ready or approved.',
    'Valid `set_task_status` statuses are `active`, `paused`, `complete`, and `canceled`.',
  ].join(' ');
}

function translateIssues(toolName: string, issues: ZodIssue[]): string {
  if (issues.some((issue) => isDraftStatusIssue(toolName, issue))) {
    return draftStatusGuidance();
  }

  const missing: string[] = [];
  const wrongType: string[] = [];
  const tooShort: string[] = [];
  const other: string[] = [];

  for (const issue of issues) {
    const label = pathLabel(issue.path);
    if (isMissingValueIssue(issue)) {
      missing.push(label);
    } else if (issue.code === 'invalid_type') {
      wrongType.push(
        `\`${label}\` (got ${issue.received ?? 'unknown'}, expected ${issue.expected ?? '?'})`,
      );
    } else if (issue.code === 'too_small') {
      tooShort.push(`\`${label}\` (${issue.message ?? 'too short'})`);
    } else {
      other.push(`\`${label}\` — ${issue.message ?? issue.code ?? 'invalid'}`);
    }
  }

  const parts: string[] = [`ERROR: \`${toolName}\` rejected by validator.`];
  if (missing.length > 0) {
    parts.push(`Missing required fields: ${missing.map((m) => `\`${m}\``).join(', ')}.`);
  }
  if (wrongType.length > 0) {
    parts.push(`Wrong type: ${wrongType.join(', ')}.`);
  }
  if (tooShort.length > 0) {
    parts.push(`Too short: ${tooShort.join(', ')}.`);
  }
  if (other.length > 0) {
    parts.push(`Other: ${other.join('; ')}.`);
  }
  parts.push(
    `Retry the call with all listed fields supplied. Do not narrate success — call \`${toolName}\` again with corrected args.`,
  );
  return parts.join(' ');
}

export const ZodErrorTranslator: McpToolWrapper = {
  id: 'zod-error-translator',
  matches: () => true,
  async postProcessError(
    _toolName: string,
    _args: Record<string, unknown>,
    errorText: string,
  ): Promise<string> {
    const m = errorText.match(VALIDATION_PREFIX_RE);
    if (!m) return errorText;
    const upstreamToolName = m[1];
    const blob = m[2];
    if (!upstreamToolName || !blob) return errorText;
    const issues = tryParseIssues(blob);
    if (!issues || issues.length === 0) return errorText;
    return translateIssues(upstreamToolName, issues);
  },
};
