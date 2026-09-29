import type { z } from 'zod';

/**
 * Forward-compatible reading of content authored for a newer gezel.
 *
 * Catalog content (gilde) ships on its own schedule, so a build routinely
 * reads items written against a core schema it has never seen: a new gate
 * check kind, a new enum value, a new key inside a `.strict()` object. A
 * plain `.parse()` rejects the whole item for one such value, and the item
 * silently vanishes — and because the live-update gate refuses any content
 * that makes a resolvable item vanish, one new check in one existing
 * craftbook used to block every gilde update for every older build.
 *
 * `parseTolerant` parses strictly first. On failure it removes the smallest
 * value it can attribute each issue to — an unrecognized key, the object
 * carrying an unknown discriminator (so a whole unknown gate check, not just
 * its `kind`), an array element, an optional field holding a value this
 * build does not accept — and parses again. It never removes a required
 * value: an issue that points at something absent means the content is
 * structurally incompatible, and the result is a failure carrying the
 * ORIGINAL issues, exactly as a strict parse would report them. Refinement
 * (`custom`) issues are never repaired either; they describe relationships,
 * not unknown vocabulary.
 *
 * Authoring paths (craftbook_write, gilde validation, the schema exporter)
 * stay strict. This is for readers of content they did not write. Content
 * whose new field is load-bearing — where ignoring it would make the item
 * wrong rather than less capable — declares `minGezelVersion` instead, and
 * older builds skip that version.
 */

export type TolerantParseResult<T> =
  | { ok: true; data: T; ignored: string[] }
  | { ok: false; issues: z.ZodIssue[] };

/** Bounds the repair loop: past these, the drift is structural, not additive. */
const MAX_PASSES = 16;
const MAX_IGNORED = 64;

type Path = PropertyKey[];

interface Removal {
  path: Path;
  label: string;
}

export function parseTolerant<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): TolerantParseResult<z.output<S>> {
  const first = schema.safeParse(raw);
  if (first.success) return { ok: true, data: first.data, ignored: [] };
  const failure = { ok: false as const, issues: first.error.issues };

  let candidate: unknown;
  try {
    candidate = structuredClone(raw);
  } catch {
    return failure;
  }
  const ignored: string[] = [];
  let issues = first.error.issues;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const removals: Removal[] = [];
    for (const issue of issues) {
      const found = removalsFor(candidate, issue);
      if (!found) return failure;
      removals.push(...found);
    }
    for (const removal of pruneOrder(removals)) {
      if (!removeAt(candidate, removal.path)) return failure;
      ignored.push(removal.label);
    }
    if (ignored.length > MAX_IGNORED) return failure;
    const next = schema.safeParse(candidate);
    if (next.success) return { ok: true, data: next.data, ignored };
    issues = next.error.issues;
  }
  return failure;
}

/**
 * What to remove for one issue, or null when the issue cannot be repaired
 * by removal. `unrecognized_keys` names keys on the object at `path`; an
 * unknown discriminator names the discriminator key, but the unit to drop is
 * the object it discriminates. A plain union reports each branch's issues
 * relative to the union's own path, so `prefix` carries that path down.
 */
function removalsFor(root: unknown, issue: z.ZodIssue, prefix: Path = []): Removal[] | null {
  const path = [...prefix, ...issue.path];
  if (issue.code === 'custom') return null;
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => {
      const keyPath = [...path, key];
      return { path: keyPath, label: `${renderPath(keyPath)} (unrecognized key)` };
    });
  }
  const value = valueAt(root, path);
  if (value === undefined) return null;
  if (issue.code === 'invalid_union') {
    const discriminator = (issue as { discriminator?: unknown }).discriminator;
    if (typeof discriminator === 'string' && path.at(-1) === discriminator) {
      const owner = path.slice(0, -1);
      if (owner.length === 0) return null;
      return [
        { path: owner, label: `${renderPath(owner)} (${discriminator} ${JSON.stringify(value)})` },
      ];
    }
    const branch = cheapestBranchRepair(root, issue.errors, path);
    if (branch) return branch;
  }
  if (path.length === 0) return null;
  return [{ path, label: renderPath(path) }];
}

/**
 * The branch of a plain union that the fewest removals would satisfy, first
 * branch on a tie. Without this, one unknown check inside a step gate —
 * `z.union([StepGateSchema, GateSpecSchema])` — would drop the whole gate
 * and leave the step ungated, instead of dropping the one check.
 */
function cheapestBranchRepair(
  root: unknown,
  branches: z.ZodIssue[][],
  prefix: Path,
): Removal[] | null {
  let best: Removal[] | null = null;
  for (const issues of branches) {
    if (issues.length === 0) continue;
    const removals: Removal[] = [];
    let repairable = true;
    for (const issue of issues) {
      const found = removalsFor(root, issue, prefix);
      if (!found) {
        repairable = false;
        break;
      }
      removals.push(...found);
    }
    if (repairable && (!best || removals.length < best.length)) best = removals;
  }
  return best;
}

/**
 * Deepest paths first and, within one array, highest index first, so a
 * splice never shifts a sibling still waiting to be removed. A removal
 * nested under another removal in the same pass is dropped as moot.
 */
function pruneOrder(removals: Removal[]): Removal[] {
  const unique = new Map<string, Removal>();
  for (const removal of removals) unique.set(pathKey(removal.path), removal);
  const all = [...unique.values()];
  const kept = all.filter(
    (removal) => !all.some((other) => other !== removal && isAncestor(other.path, removal.path)),
  );
  return kept.sort((a, b) => {
    const len = Math.min(a.path.length, b.path.length);
    for (let i = 0; i < len; i++) {
      const x = a.path[i];
      const y = b.path[i];
      if (x === y) continue;
      if (typeof x === 'number' && typeof y === 'number') return y - x;
      return String(x) < String(y) ? -1 : 1;
    }
    return b.path.length - a.path.length;
  });
}

function removeAt(root: unknown, path: Path): boolean {
  const parent = valueAt(root, path.slice(0, -1));
  const key = path.at(-1);
  if (Array.isArray(parent) && typeof key === 'number') {
    if (key < 0 || key >= parent.length) return false;
    parent.splice(key, 1);
    return true;
  }
  if (parent && typeof parent === 'object' && key !== undefined) {
    return delete (parent as Record<PropertyKey, unknown>)[key];
  }
  return false;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cursor = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[key];
  }
  return cursor;
}

function isAncestor(ancestor: Path, path: Path): boolean {
  return ancestor.length < path.length && ancestor.every((key, i) => key === path[i]);
}

function pathKey(path: Path): string {
  return JSON.stringify(path.map((key) => (typeof key === 'symbol' ? String(key) : key)));
}

/** `steps[3].gate.checks[2]` — the shape an author searches their file for. */
function renderPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    out += typeof key === 'number' ? `[${key}]` : out ? `.${String(key)}` : String(key);
  }
  return out || '<root>';
}
