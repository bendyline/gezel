import { basename } from 'node:path';
import type { CraftbookEvalSpec, CraftbookTemplateSummary } from './types.ts';

/**
 * Can the craftbook under test actually produce what its eval grades?
 *
 * A `craftbook-<id>` scenario declares `success.deliverables[].path` and fails
 * the trial when that file is missing. Nothing checks that the BOOK ever writes
 * that path — and for a large slice of the bundled library it does not:
 *
 *   - `db-index-tuning` writes `migrations/add_indexes.sql` and
 *     `<workPath>/analyze.md`; its eval grades `analysis.md`.
 *   - `dockerize-app` writes `Dockerfile`; its eval grades `src/solution.mjs`.
 *   - `email-template` writes `email.html`; its eval grades `index.html`.
 *
 * The consequence is not a missing test, it is an INVERTED one: a model that
 * follows the craftbook faithfully produces the book's real deliverables and
 * FAILS, while a model that ignores the book and writes the placeholder file
 * PASSES. That is why so many craftbook trials pass without ever creating a
 * craftbook task (see `craftbook-drove.ts`) — the eval rewards not using the
 * recipe.
 *
 * Three verdicts, because the repairs differ:
 *
 *   `reachable` — the book names the path. Nothing to do.
 *   `folder-drift` — the book writes that FILENAME into a different folder,
 *     almost always because the eval grades `<somewhere>/report.md` while the
 *     book writes `{{workPath}}/report.md` and the spec pins no `workPath`.
 *     Repair is one `setup.craftbookParams.workPath` line.
 *   `unreachable` — the book never names the file at all. Repair is a real
 *     eval rewrite: grade what the recipe produces.
 *
 * Deliberately textual: it asks whether the book's own document mentions the
 * path, not whether some runtime would produce it. A path a book never writes
 * down cannot be the path it writes to, and a stricter model of "what this
 * recipe emits" would need to interpret every step prompt.
 */
export type DeliverableReachability = 'reachable' | 'folder-drift' | 'unreachable';

export interface DeliverableReachabilityFinding {
  craftbookId: string;
  scenarioId: string;
  verdict: Exclude<DeliverableReachability, 'reachable'>;
  /** The graded paths the book does not write. */
  paths: string[];
  /** Output paths the book DOES gate on, as the repair's starting point. */
  bookGatedPaths: string[];
}

interface StepLike {
  advanceWhen?: unknown;
  gate?: unknown;
}

function fileFieldsOf(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) fileFieldsOf(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'file' && typeof value === 'string') out.add(value);
    else fileFieldsOf(value, out);
  }
}

/** Paths the book itself gates on — its declared outputs, not prose mentions. */
export function craftbookGatedPaths(template: CraftbookTemplateSummary): string[] {
  const out = new Set<string>();
  for (const step of (template.steps ?? []) as StepLike[]) {
    const advance = step.advanceWhen as { file?: string } | undefined;
    if (typeof advance?.file === 'string') out.add(advance.file);
    fileFieldsOf(step.gate, out);
  }
  return [...out].sort();
}

/**
 * Resolve the craftbook's own parameter tokens the way the run will.
 *
 * Books address their outputs as `{{workPath}}/report.md`, and a spec pins
 * `workPath` in `setup.craftbookParams`. Comparing the eval's literal
 * `tasks/eval/report.md` against the raw document would report drift that the
 * run does not have, so substitute first — repeatedly, because `workPath`
 * itself defaults to another token (`{{task.dir}}`).
 */
function resolveBookDocument(spec: CraftbookEvalSpec, template: CraftbookTemplateSummary): string {
  const schema = (
    template as { paramSchema?: { properties?: Record<string, { default?: unknown }> } }
  ).paramSchema;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(schema?.properties ?? {})) {
    if (typeof value?.default === 'string') params[key] = value.default;
  }
  for (const [key, value] of Object.entries(spec.setup?.craftbookParams ?? {})) {
    if (typeof value === 'string') params[key] = value;
  }
  let text = JSON.stringify(template);
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
      params[key] !== undefined ? params[key] : whole,
    );
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Graded deliverables the eval seeds itself. A fixture the book must leave
 * ALONE (`careful-mode`'s protected file, `freeze-scope`'s sentinel) is not
 * something the book should write, so it is not a reachability defect.
 */
function seededFixturePaths(spec: CraftbookEvalSpec): Set<string> {
  return new Set((spec.setup?.files ?? []).map((file) => file.path));
}

export function classifyDeliverableReachability(
  spec: CraftbookEvalSpec,
  template: CraftbookTemplateSummary,
): DeliverableReachabilityFinding | null {
  const seeded = seededFixturePaths(spec);
  const graded = (spec.success.deliverables ?? [])
    .map((deliverable) => deliverable.path)
    .filter((path) => path && !seeded.has(path));
  if (graded.length === 0) return null;

  const document = resolveBookDocument(spec, template);
  const unreachable: string[] = [];
  const drifted: string[] = [];
  for (const path of graded) {
    if (document.includes(path)) continue;
    if (document.includes(basename(path))) drifted.push(path);
    else unreachable.push(path);
  }
  if (unreachable.length === 0 && drifted.length === 0) return null;

  return {
    craftbookId: spec.craftbookId,
    scenarioId: spec.scenarioId,
    verdict: unreachable.length > 0 ? 'unreachable' : 'folder-drift',
    paths: unreachable.length > 0 ? unreachable : drifted,
    bookGatedPaths: craftbookGatedPaths(template),
  };
}

export interface DeliverableReachabilitySummary {
  checked: number;
  reachable: number;
  folderDrift: number;
  unreachable: number;
  findings: DeliverableReachabilityFinding[];
}

export function auditDeliverableReachability(
  specs: readonly CraftbookEvalSpec[],
  templates: readonly CraftbookTemplateSummary[],
): DeliverableReachabilitySummary {
  const byId = new Map(templates.map((template) => [template.id, template]));
  const findings: DeliverableReachabilityFinding[] = [];
  let checked = 0;
  for (const spec of specs) {
    const template = byId.get(spec.craftbookId);
    if (!template) continue;
    if ((spec.success.deliverables ?? []).length === 0) continue;
    checked++;
    const finding = classifyDeliverableReachability(spec, template);
    if (finding) findings.push(finding);
  }
  findings.sort((a, b) => a.craftbookId.localeCompare(b.craftbookId));
  const unreachable = findings.filter((f) => f.verdict === 'unreachable').length;
  const folderDrift = findings.filter((f) => f.verdict === 'folder-drift').length;
  return {
    checked,
    reachable: checked - findings.length,
    folderDrift,
    unreachable,
    findings,
  };
}
