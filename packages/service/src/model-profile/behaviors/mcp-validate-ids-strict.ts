/**
 * `mcp.validate-ids-strict` — defends against the Gemma 26B
 * fabrication mode where the model invents an ID-shaped argument
 * (`projectId: "space_invaders_123"`) that no prior tool result
 * actually returned. Without this gate, the gezel-mcp call lands
 * upstream, Zod validation rejects, the model gets a generic
 * "project not found" error, and the recovery loop spins on more
 * fabricated IDs.
 *
 * Implementation:
 *   - Per-bridge `seenIds` Set, populated by `postProcess` from
 *     successful tool results. The Set is bridge-scoped (closed
 *     over by the wrapper factory below) so each session gets a
 *     fresh tracker.
 *   - `preProcess` scans args recursively for fields whose key
 *     name looks like an ID (e.g. `id`, `gezelId`, `targetGezelId`,
 *     `voormanGezelId`, `assignee.gezelId`, `projectId`, `ref`)
 *     and rejects when the value isn't in `seenIds` and isn't on
 *     the always-allow list (built-in defaults like `default`).
 *
 * The wrapper is a factory because each bridge needs its own
 * tracker — that's the one stateful part of the behavior. Sets the
 * `mcpWrapper` field to a `() => McpToolWrapper` form; the bridge's
 * `behaviorWrappersFor` invokes the factory once per session.
 *
 * Gemma-only opt-in. Cloud models and small-but-stricter local
 * models don't need this — they only invent IDs in the
 * pathological loop case, and the fabrication detector catches that
 * separately.
 */

import { isGezelMcp } from '../../providers/mcp-wrappers/gezel-mcp-small-model.js';
import type {
  McpPreProcessVerdict,
  McpToolResult,
  McpToolWrapper,
  McpToolWrapperContext,
} from '../../providers/mcp-wrappers/types.js';
import type { Behavior } from '../types.js';

/**
 * Field names that are considered ID-bearing. Names match
 * case-sensitively against object keys; nested keys are walked. The
 * shape is deliberately conservative — only fields whose contract
 * is "this MUST be a previously-returned ID" appear here. Generic
 * `name` / `title` fields are NOT included; those legitimately
 * accept user-typed values.
 */
const ID_FIELD_NAMES: ReadonlySet<string> = new Set([
  'id',
  'gezelId',
  'targetGezelId',
  'voormanGezelId',
  'assigneeGezelId',
  'projectId',
  'ref',
]);

/**
 * Always-allow values — not from any tool result, but legitimately
 * accepted as IDs by gezel-mcp's create-* / update-* / list-* tools.
 * `default` is the special project id every install ships with.
 * `voorman` / `meester` / `developer` etc. are role keywords sometimes
 * passed where a gezelId would otherwise go (the upstream tool
 * resolves them by role lookup).
 */
const ALWAYS_ALLOW_VALUES: ReadonlySet<string> = new Set([
  'default',
  'voorman',
  'meester',
  'developer',
  'reviewer',
  'planner',
]);

/**
 * Extract every string value from a parsed JSON-shaped object that
 * lives at one of the {@link ID_FIELD_NAMES} keys, recursively.
 * Used by `postProcess` to find the IDs a tool actually returned —
 * `create_project` returns `{id: "abc-123", name: "...", ...}`,
 * `list_gezels` returns `[{id: "g-1", ...}, ...]`, etc.
 */
function extractIdsFromValue(value: unknown, into: Set<string>): void {
  if (typeof value === 'string' && value.length > 0) {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) extractIdsFromValue(v, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ID_FIELD_NAMES.has(k) && typeof v === 'string') {
        into.add(v);
      } else if (typeof v === 'object') {
        extractIdsFromValue(v, into);
      }
    }
  }
}

/**
 * Walk a tool-result text and harvest ID-shaped values into the
 * tracker. The gezel-mcp tools return IDs in three observed shapes:
 *
 *   1. JSON object/array — `{"id":"abc","name":"…"}` from list-style
 *      tools that return structured data.
 *   2. JSON-key prose — `"id":"abc"` embedded inside a longer
 *      message ("got id":"abc"; etc.).
 *   3. Plain-prose suffix — `Created project "X" — id: abc-123. Next: …`
 *      from create_project / create_gezel / etc. This is
 *      the dominant shape for "I just created something" replies.
 *
 * All three are scanned. The plain-prose form `id: <value>` accepts
 * an unquoted value bounded by whitespace, comma, period, or
 * end-of-string — matching the actual emit shape of every gezel-mcp
 * create-* tool. Without this, the harvester only catches IDs from
 * JSON-shaped list-style tools, and the very next call's args are
 * (incorrectly) flagged as fabrications.
 */
function harvestIds(text: string, into: Set<string>): void {
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    extractIdsFromValue(parsed, into);
    return;
  } catch {
    // Not JSON — fall through to regex scrapes below.
  }
  const jsonKeyPattern =
    /"(id|gezelId|targetGezelId|voormanGezelId|projectId|ref)"\s*:\s*"([^"]+)"/g;
  for (const m of text.matchAll(jsonKeyPattern)) {
    if (m[2]) into.add(m[2]);
  }
  // Plain-prose `id: <value>` shape. The value is bounded by
  // whitespace/punctuation; trailing periods get trimmed off because
  // gezel-mcp's standard reply ends with `id: abc-123. Next: …`.
  const proseIdPattern = /\bid:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/g;
  for (const m of text.matchAll(proseIdPattern)) {
    const raw = m[1];
    if (!raw) continue;
    const trimmed = raw.replace(/\.+$/, '');
    if (trimmed.length > 0) into.add(trimmed);
  }
  // Task-`ref` shape: `<projectId>/<num>`. `list_tasks` formats each
  // line as `• marketing/7 [active] (→ designer-1) — "Draft hero
  // copy" · …`, so the canonical `id: <value>` pattern misses it.
  // The shape is distinctive enough — slug + slash + integer — to
  // scrape directly. Without this, the voorman-flow wedges on the
  // very first call after `list_tasks` (the model uses the ref
  // verbatim from the returned line, validate-ids says "never seen",
  // every retry rejects).
  const refShapePattern = /\b([a-z0-9][a-z0-9-]{1,63}\/\d+)\b/g;
  for (const m of text.matchAll(refShapePattern)) {
    if (m[1]) into.add(m[1]);
  }
}

/**
 * Walk an args object and collect ID-shaped fields whose value
 * isn't on the seen-or-allowed lists. Returns `{ field, value }`
 * tuples so the rejection message can be specific.
 */
function findFabricatedIds(
  args: Record<string, unknown>,
  seenIds: ReadonlySet<string>,
  prefix = '',
): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  for (const [k, v] of Object.entries(args)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (ID_FIELD_NAMES.has(k) && typeof v === 'string' && v.length > 0) {
      if (!seenIds.has(v) && !ALWAYS_ALLOW_VALUES.has(v.toLowerCase())) {
        out.push({ field: fullKey, value: v });
      }
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...findFabricatedIds(v as Record<string, unknown>, seenIds, fullKey));
    }
  }
  return out;
}

/**
 * Factory: returns a fresh wrapper with its own per-bridge ID
 * tracker. Closure-style state — simpler than a class given the
 * wrapper interface is just a bag of optional methods.
 */
function buildValidateIdsWrapper(): McpToolWrapper {
  const seenIds = new Set<string>();
  return {
    id: 'mcp-validate-ids-strict',
    matches: (spec) => isGezelMcp(spec),
    seedFromText(text: string): void {
      // Seed from the system prompt. ChatManager bakes the project
      // id, the active task ref ("tank-combat-arcade-game/2"), the
      // voorman gezel id, the assigned-tasks list, etc. directly into
      // the prompt — those values ARE legitimate even though no tool
      // result has returned them yet. Reusing `harvestIds` keeps the
      // patterns aligned: any shape we accept from a tool result we
      // also accept from the prompt.
      harvestIds(text, seenIds);
    },
    async preProcess(
      _toolName: string,
      args: Record<string, unknown>,
      _ctx: McpToolWrapperContext,
    ): Promise<McpPreProcessVerdict> {
      const violations = findFabricatedIds(args, seenIds);
      if (violations.length === 0) return { kind: 'allow' };
      const detail = violations.map((v) => `\`${v.field}=${JSON.stringify(v.value)}\``).join(', ');
      return {
        kind: 'reject',
        error: `Rejected: ${detail} reference(s) ID(s) no previous tool result returned. Call \`list_gezels\` / \`list_projects\` / \`get_task\` first to discover real IDs, then retry with the values from those tools' output.`,
      };
    },
    async postProcess(
      _toolName: string,
      _args: Record<string, unknown>,
      result: McpToolResult,
      _ctx: McpToolWrapperContext,
    ): Promise<McpToolResult> {
      harvestIds(result.text, seenIds);
      return result;
    },
  };
}

export const McpValidateIdsStrict: Behavior = {
  id: 'mcp.validate-ids-strict',
  description:
    'Tracks IDs returned by gezel-mcp tool results in a per-bridge Set; rejects any subsequent call whose ID-shaped args reference a value never seen. Defends Gemma 4 26B against fabricating `projectId: "space_invaders_123"`.',
  mcpWrapper: () => buildValidateIdsWrapper(),
};
