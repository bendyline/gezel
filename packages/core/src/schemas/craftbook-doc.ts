import type { z } from 'zod';
import { z as zod } from 'zod';
import { TaskAssigneeSchema } from './assignee.js';
import {
  CraftbookBasedOnSchema,
  CraftbookCommandNeedSchema,
  CraftbookConnectorNeedSchema,
  CraftbookRequirementSchema,
  CraftbookRunModesSchema,
  CraftbookScriptsSchema,
  CraftbookSpawnSchema,
  CraftbookToolsetNeedSchema,
  ModelTierSchema,
  NewCraftbookStepSchema,
} from './craftbook.js';
import { HookSpecSchema } from './hook.js';

/**
 * ─ Craftbook document ────────────────────────────────────────────────
 *
 * The single self-contained artifact a model reads/writes when authoring
 * or editing a craftbook: metadata + step blueprints + inline scripts in
 * ONE document. Two encodings carry the same logical shape — a JSON text
 * (this schema parsed directly) and a markdown text (frontmatter + prose
 * + fenced blocks; see `markdown/craftbook-md.ts`). The format-agnostic
 * parse/serialize entry points live in `craftbook-doc.ts` at the core
 * root (they need the deliverable-expansion helpers, which sit outside
 * the schemas layer).
 */
export const CraftbookDocSchema = zod.object({
  /** Optional — minted from `name` when absent (create) or supplied by the route (update). */
  id: zod.string().optional(),
  name: zod.string().min(1),
  /** The about/description prose. In markdown form this is the body before the first heading. */
  description: zod.string().optional(),
  /** Credit + link to the upstream work this craftbook adapts. */
  basedOn: CraftbookBasedOnSchema.optional(),
  plan: zod.string().optional(),
  /** Entry step id. Defaults to the first step. */
  entryStepId: zod.string().optional(),
  triggers: zod.array(zod.string()).optional(),
  command: zod
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  defaultAssignee: TaskAssigneeSchema.optional(),
  requirements: zod.array(CraftbookRequirementSchema).optional(),
  /** Unattended launch modes this recipe is suitable for. */
  runModes: CraftbookRunModesSchema.optional(),
  toolsets: zod.array(CraftbookToolsetNeedSchema).optional(),
  /** Commands the book's commandEvidence gates verify — approval asked at kickoff. */
  commands: zod.array(CraftbookCommandNeedSchema).optional(),
  connectors: zod.array(CraftbookConnectorNeedSchema).optional(),
  paramSchema: zod.record(zod.string(), zod.unknown()).optional(),
  /**
   * Pre/PostToolUse hooks installed while a task runs this book. A hook's
   * `script.name` with scope `craftbook` must resolve in `scripts` — the
   * same inline-first contract step scripts follow.
   */
  hooks: zod.array(HookSpecSchema).optional(),
  /** Deliverable-capable step blueprints — `deliverable` expands to a full gate at write time. */
  steps: zod.array(NewCraftbookStepSchema).min(1),
  /**
   * Declarative per-item fanout: marks this craftbook a spawn host. Its
   * `spawnFanout` step fans out one child per item in `spawn.overFile`.
   * See {@link CraftbookSpawnSchema}.
   */
  spawn: CraftbookSpawnSchema.optional(),
  /**
   * Authored mode-agnostic: the same book works whether a run edits in
   * place or drafts a diffpack proposal. See `CraftbookSchema.diffpackCapable`.
   */
  diffpackCapable: zod.boolean().optional(),
  /** Minimum model tier for the whole book — see `CraftbookSchema.capabilityFloor`. */
  capabilityFloor: ModelTierSchema.optional(),
  /** Inline script sources (name → TypeScript). */
  scripts: CraftbookScriptsSchema.optional(),
  /** Catalog provenance — carried by bundled/local books, optional for ad-hoc docs. */
  version: zod.string().optional(),
  releasedAt: zod.string().optional(),
  /**
   * Oldest gezel build that can meaningfully run this craftbook version.
   * See {@link MinGezelVersionShape} in `schemas/catalog.ts` for format and
   * gating semantics.
   */
  minGezelVersion: zod.string().optional(),
});
export type CraftbookDoc = z.infer<typeof CraftbookDocSchema>;

export type CraftbookDocFormat = 'json' | 'markdown';

/**
 * One repair-grade problem with a craftbook document. The formatted list
 * IS the retry prompt for the authoring model, so every error must say
 * WHERE (resolved to a step id, not a bare array index), WHAT is wrong,
 * and — whenever we can compute it — the concrete FIX.
 */
export interface CraftbookDocError {
  /** e.g. `document`, `frontmatter`, `steps[2] (id "review") → gate.at`, `scripts.checkFoo` */
  where: string;
  message: string;
  /** Imperative, concrete: what to change. */
  fix?: string;
}

const MAX_FORMATTED_ERRORS = 12;

/**
 * Render errors as the numbered list handed back to the authoring model.
 * One error per line, `Fix:` inline, capped so a catastrophically broken
 * document doesn't drown the retry in noise.
 */
export function formatCraftbookDocErrors(errors: CraftbookDocError[]): string {
  const shown = errors.slice(0, MAX_FORMATTED_ERRORS);
  const lines = shown.map(
    (e, i) => `${i + 1}. ${e.where}: ${e.message}${e.fix ? ` Fix: ${e.fix}` : ''}`,
  );
  if (errors.length > shown.length) {
    lines.push(`…and ${errors.length - shown.length} more problem(s).`);
  }
  return lines.join('\n');
}

/** Levenshtein distance — for nearest-match suggestions on bad enum values / step ids. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...new Array<number>(n)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/** The closest candidate within an edit-distance budget, or undefined. */
export function nearestMatch(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = editDistance(input.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== undefined && bestDist <= Math.max(2, Math.floor(input.length / 3))
    ? best
    : undefined;
}

/**
 * Map Zod issues from a failed `CraftbookDocSchema` parse into
 * repair-grade errors: `steps[i]` paths are resolved to the step's
 * id/name so the model can find the step in its own document, and enum
 * failures spell out every legal value plus the nearest match.
 */
export function zodIssuesToDocErrors(issues: z.ZodIssue[], raw: unknown): CraftbookDocError[] {
  const steps = Array.isArray((raw as { steps?: unknown[] } | null)?.steps)
    ? ((raw as { steps: unknown[] }).steps as { id?: string; name?: string }[])
    : [];
  return issues.map((issue) => {
    const where = renderIssuePath(issue.path, steps);
    const input = valueAtIssuePath(raw, issue.path);
    if (issue.code === 'invalid_value') {
      const opts = issue.values.map(String);
      const got = String(input);
      const near = nearestMatch(got, opts);
      return {
        where,
        message: `"${got}" is not a legal value.`,
        fix: `use one of: ${opts.join(', ')}${near ? ` — closest match: "${near}"` : ''}`,
      };
    }
    if (issue.code === 'invalid_type') {
      const received = input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input;
      return {
        where,
        message: `expected ${issue.expected}, got ${received}.`,
        ...(received === 'undefined' ? { fix: 'add this required field' } : {}),
      };
    }
    if (issue.code === 'unrecognized_keys') {
      return {
        where,
        message: `unknown field(s): ${issue.keys.join(', ')}.`,
        fix: 'remove them (or check the spelling against the schema)',
      };
    }
    return { where, message: issue.message };
  });
}

function valueAtIssuePath(raw: unknown, path: PropertyKey[]): unknown {
  let value = raw;
  for (const key of path) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return undefined;
    }
    value = Reflect.get(value, key);
  }
  return value;
}

function renderIssuePath(path: PropertyKey[], steps: { id?: string; name?: string }[]): string {
  if (path.length === 0) return 'document';
  if (path[0] === 'steps' && typeof path[1] === 'number') {
    const idx = path[1];
    const step = steps[idx];
    const label = step?.id ?? step?.name;
    const rest = path.slice(2).map(String).join('.');
    return `steps[${idx}]${label ? ` (id "${label}")` : ''}${rest ? ` → ${rest}` : ''}`;
  }
  if (path[0] === 'scripts' && typeof path[1] === 'string') {
    return `scripts.${path[1]}`;
  }
  return path.map(String).join('.');
}

/** Cheap format detection: a document whose first non-blank char is `{` is JSON. */
export function sniffCraftbookDocFormat(text: string): CraftbookDocFormat {
  return text.trimStart().startsWith('{') ? 'json' : 'markdown';
}

/**
 * The install's advertised craftbook-document format, from the
 * `GEZEL_CRAFTBOOK_DOC_FORMAT` env value (`json` | `md`/`markdown`).
 * This is the whole A/B lever for the format eval: it picks the default
 * codec `craftbook_write`/`craftbook_read` speak and the format the tool
 * descriptions advertise. Default: json.
 */
export function craftbookDocFormatFromEnv(value: string | undefined): CraftbookDocFormat {
  return value === 'md' || value === 'markdown' ? 'markdown' : 'json';
}
