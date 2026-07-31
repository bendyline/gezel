import {
  type ParsedReportAction,
  type ReportActionParseIssue,
  ReportActionSchema,
} from '../schemas/report-action.js';
import { FENCE, extractAllFences, isFenceClose, parseYamlBlock } from './md-structure.js';

/**
 * ```gezel-action fence parsing — the read half of report actions.
 *
 * Deliberately tolerant, mirroring `parseCraftbookTestSpec`'s posture:
 * these blocks are authored by models overnight, so a malformed block
 * must surface as a visible, debuggable ISSUE — never a thrown error and
 * never a silently vanished action. Unknown keys are stripped, common
 * kind spellings are aliased, scalar params are string-coerced.
 *
 * Isomorphic: the UI parses individual fence bodies (fed squisq code
 * nodes) with `parseReportActionBlock`; the service parses whole
 * documents with `parseReportActions`. Identity resolution is shared, so
 * both sides agree on ids — FNV-1a (not node:crypto) keeps it
 * browser-safe.
 */

export const REPORT_ACTION_FENCE_LANG = 'gezel-action';

export interface ParsedReportActions {
  actions: ParsedReportAction[];
  issues: ReportActionParseIssue[];
}

/** FNV-1a 32-bit hex of a string — stable, tiny, dependency-free. */
export function reportActionContentHash(body: string): string {
  let hash = 0x811c9dc5;
  const text = body.trim();
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const KIND_ALIASES: Record<string, string> = {
  craftbook: 'fire-craftbook',
  'run-craftbook': 'fire-craftbook',
  task: 'create-task',
  'new-task': 'create-task',
  edits: 'apply-edits',
  'apply-diffs': 'apply-edits',
  diff: 'apply-edits',
  'diff-pack': 'apply-edits',
};

const KNOWN_KEYS_BY_KIND: Record<string, readonly string[]> = {
  'fire-craftbook': ['kind', 'id', 'title', 'reason', 'projectId', 'craftbookId', 'params'],
  'create-task': ['kind', 'id', 'title', 'reason', 'projectId', 'prompt', 'role'],
  'apply-edits': ['kind', 'id', 'title', 'reason', 'projectId', 'edits'],
};

const KEY_ALIASES: Record<string, string> = {
  name: 'title',
  project: 'projectId',
  craftbook: 'craftbookId',
  why: 'reason',
};

function normalizeRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[KEY_ALIASES[key] ?? key] = value;
  }
  const kindRaw = typeof out.kind === 'string' ? out.kind.trim().toLowerCase() : '';
  const kind = KIND_ALIASES[kindRaw] ?? kindRaw;
  out.kind = kind;

  // `craftbook` aliases to `craftbookId` only when the kind needs one —
  // handled above via KEY_ALIASES, which is safe because no kind uses a
  // plain `craftbook` key.

  const known = KNOWN_KEYS_BY_KIND[kind];
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out)) {
    if (!known || known.includes(key)) stripped[key] = value;
  }

  if (stripped.params && typeof stripped.params === 'object' && !Array.isArray(stripped.params)) {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(stripped.params as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      params[key] = typeof value === 'string' ? value : String(value);
    }
    stripped.params = params;
  }

  if (Array.isArray(stripped.edits)) {
    stripped.edits = (stripped.edits as unknown[])
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const record = entry as Record<string, unknown>;
        return {
          ...(record.path !== undefined ? { path: String(record.path) } : {}),
          ...(record.diffArtifact !== undefined
            ? { diffArtifact: String(record.diffArtifact) }
            : record.diff !== undefined
              ? { diffArtifact: String(record.diff) }
              : {}),
        };
      })
      .filter((entry) => entry && typeof entry === 'object');
  }

  return stripped;
}

/**
 * Parse one fence body. Never throws; returns a structured issue on any
 * failure so the block stays visible.
 */
export function parseReportActionBlock(
  body: string,
  index: number,
): { ok: true; action: ParsedReportAction } | { ok: false; issue: ReportActionParseIssue } {
  const contentHash = reportActionContentHash(body);
  let raw: Record<string, unknown>;
  try {
    raw = parseYamlBlock(body);
  } catch (err) {
    return {
      ok: false,
      issue: {
        index,
        message: `not a YAML mapping: ${err instanceof Error ? err.message : String(err)}`,
        raw: body,
      },
    };
  }
  const normalized = normalizeRaw(raw);
  const parsed = ReportActionSchema.safeParse(normalized);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      issue: {
        index,
        message: first
          ? `${first.path.join('.') || 'block'}: ${first.message}`
          : 'invalid action block',
        raw: body,
      },
    };
  }
  const id = parsed.data.id ?? `a-${contentHash}`;
  return { ok: true, action: { ...parsed.data, id, contentHash } };
}

/**
 * Parse every gezel-action fence in a markdown document. Duplicate
 * resolved ids get `-2`, `-3`… suffixes plus a diagnostic issue, so two
 * sloppy blocks can't silently share lifecycle state.
 */
export function parseReportActions(markdown: string): ParsedReportActions {
  const actions: ParsedReportAction[] = [];
  const issues: ReportActionParseIssue[] = [];
  const seen = new Map<string, number>();
  let index = 0;
  for (const fence of extractAllFences(markdown)) {
    const lang = fence.lang.split(/\s+/, 1)[0] ?? '';
    if (lang !== REPORT_ACTION_FENCE_LANG) continue;
    const fenceIndex = index++;
    const result = parseReportActionBlock(fence.code, fenceIndex);
    if (!result.ok) {
      issues.push(result.issue);
      continue;
    }
    const action = result.action;
    const count = (seen.get(action.id) ?? 0) + 1;
    seen.set(action.id, count);
    if (count > 1) {
      const suffixed = `${action.id}-${count}`;
      issues.push({
        index: fenceIndex,
        message: `duplicate action id "${action.id}" — renamed to "${suffixed}"; give each block a unique id`,
        raw: fence.code,
      });
      actions.push({ ...action, id: suffixed });
    } else {
      actions.push(action);
    }
  }
  return { actions, issues };
}

/** Whether a document contains any gezel-action fence (cheap pre-check). */
export function hasReportActionFence(markdown: string): boolean {
  const lines = markdown.split('\n');
  let openFence: string | null = null;
  for (const line of lines) {
    const fence = FENCE.exec(line.trim());
    if (openFence !== null) {
      if (fence && isFenceClose(line, openFence)) openFence = null;
      continue;
    }
    if (fence) {
      openFence = fence[1]!;
      const lang = fence[2]!.trim().toLowerCase().split(/\s+/, 1)[0];
      if (lang === REPORT_ACTION_FENCE_LANG) return true;
    }
  }
  return false;
}

/**
 * The prompt snippet that teaches a report-writing gezel the format.
 * Embedded in the night-shift oversight prompt and referenced by the
 * gilde authoring guidelines — one source, no drift.
 */
export const REPORT_ACTION_AUTHORING_GUIDE = `When a recommendation is directly actionable, follow it with a \`\`\`gezel-action fenced YAML block so the user can fire it with one click in the morning. Three kinds, flat keys only, one block per action, each with a unique stable \`id\` slug:

Run an existing craftbook:
\`\`\`gezel-action
kind: fire-craftbook
id: nightly-a11y-sweep
title: Run an accessibility audit
reason: Three templates changed without alt text review.
craftbookId: a11y-audit
projectId: webshop
\`\`\`

Delegate a bespoke task:
\`\`\`gezel-action
kind: create-task
id: fix-null-parse
title: Fix the unchecked null in parser.ts
reason: parseHeader returns null on empty input and callers dereference it.
prompt: In src/parser.ts, parseHeader can return null (line ~88) and both callers dereference the result. Add the guard, mirror the fix in parseFooter, and extend parser.test.ts with the empty-input case.
role: software developer
projectId: webshop
\`\`\`

Propose file edits (diffs go in SIDECAR artifact files — never inline):
\`\`\`gezel-action
kind: apply-edits
id: harden-csp-headers
title: Add missing security headers
reason: Responses lack X-Content-Type-Options and a CSP.
projectId: webshop
edits:
  - path: src/server/headers.ts
    diffArtifact: night-shift-report/edits/harden-csp-headers.diff
\`\`\`

For apply-edits: write each proposed change as ONE unified diff per target file with write_artifact (a single-file diff against the file's current content), and reference it via diffArtifact. Keep titles short, reasons to a sentence or two, and never invent craftbook ids — only reference books you confirmed exist.`;
