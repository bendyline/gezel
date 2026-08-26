import { expandStepDeliverables } from './deliverable.js';
import { parseCraftbookMarkdown, serializeCraftbookMarkdown } from './markdown/craftbook-md.js';
import type {
  Craftbook,
  CraftbookDoc,
  CraftbookDocError,
  CraftbookDocFormat,
} from './schemas/index.js';
import {
  CraftbookDocSchema,
  nearestMatch,
  slugifyStepId,
  sniffCraftbookDocFormat,
  validateCraftbookGraph,
  validateCraftbookScriptRefs,
  zodIssuesToDocErrors,
} from './schemas/index.js';

/**
 * ─ Craftbook document codecs ─────────────────────────────────────────
 *
 * Format-agnostic parse/serialize for the single-document craftbook
 * authoring format, plus the doc ↔ runtime-Craftbook conversion. Both
 * encodings (JSON / markdown) funnel through ONE schema validation and
 * ONE repair-grade error pipeline, so `craftbook_write` behaves
 * identically in the format A/B eval's two arms.
 */

export type ParseCraftbookDocResult =
  | { ok: true; doc: CraftbookDoc }
  | { ok: false; errors: CraftbookDocError[] };

export function parseCraftbookDoc(
  text: string,
  format?: CraftbookDocFormat,
): ParseCraftbookDocResult {
  const fmt = format ?? sniffCraftbookDocFormat(text);
  let raw: unknown;
  if (fmt === 'json') {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        errors: [
          {
            where: 'document',
            message: `the document is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
            fix: 'check for a truncated document, a trailing comma, or unescaped newlines/quotes inside string values (script sources must escape newlines as \\n)',
          },
        ],
      };
    }
  } else {
    const md = parseCraftbookMarkdown(text);
    if (!md.ok) return { ok: false, errors: md.errors };
    raw = md.doc;
  }
  const parsed = CraftbookDocSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToDocErrors(parsed.error.issues, raw) };
  }
  return { ok: true, doc: parsed.data };
}

export function serializeCraftbookDoc(doc: CraftbookDoc, format: CraftbookDocFormat): string {
  if (format === 'json') return `${JSON.stringify(doc, null, 2)}\n`;
  return serializeCraftbookMarkdown(doc);
}

export interface CraftbookFromDocOptions {
  /** Forced id (update-in-place routes). Wins over `doc.id` / the minted slug. */
  id?: string;
  /** Timestamp for createdAt/updatedAt. Preserved `createdAt` may be supplied separately. */
  now: string;
  createdAt?: string;
}

export type CraftbookFromDocResult =
  | { ok: true; craftbook: Craftbook }
  | { ok: false; errors: CraftbookDocError[] };

/**
 * Turn a schema-valid doc into the runtime `Craftbook`: expand each
 * step's `deliverable` sugar into its enforced gate, default the entry
 * step, and run the shared graph + script-ref validators. Errors come
 * back repair-grade — this result's formatted text is what the model
 * sees when `craftbook_write` refuses a save.
 */
export function craftbookFromDoc(
  doc: CraftbookDoc,
  opts: CraftbookFromDocOptions,
): CraftbookFromDocResult {
  const steps = expandStepDeliverables(doc.steps);
  const stepIds = steps.map((s) => s.id);
  const entryStepId = doc.entryStepId ?? steps[0]!.id;

  const errors: CraftbookDocError[] = [];
  if (!stepIds.includes(entryStepId)) {
    const near = nearestMatch(entryStepId, stepIds);
    errors.push({
      where: 'entryStepId',
      message: `"${entryStepId}" is not a step id.`,
      fix: `valid step ids: ${stepIds.join(', ')}${near ? ` — did you mean "${near}"?` : ''}`,
    });
  }

  const candidate: Craftbook = {
    id: opts.id ?? doc.id ?? slugifyStepId(doc.name),
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.version ? { version: doc.version } : {}),
    ...(doc.basedOn ? { basedOn: doc.basedOn } : {}),
    ...(doc.plan ? { plan: doc.plan } : {}),
    ...(doc.defaultAssignee ? { defaultAssignee: doc.defaultAssignee } : {}),
    steps,
    entryStepId,
    ...(doc.triggers ? { triggers: doc.triggers } : {}),
    ...(doc.command ? { command: doc.command } : {}),
    ...(doc.requirements ? { requirements: doc.requirements } : {}),
    ...(doc.recommends ? { recommends: doc.recommends } : {}),
    ...(doc.runModes ? { runModes: doc.runModes } : {}),
    ...(doc.toolsets ? { toolsets: doc.toolsets } : {}),
    ...(doc.connectors ? { connectors: doc.connectors } : {}),
    ...(doc.paramSchema ? { paramSchema: doc.paramSchema } : {}),
    ...(doc.hooks ? { hooks: doc.hooks } : {}),
    ...(doc.scripts ? { scripts: doc.scripts } : {}),
    createdAt: opts.createdAt ?? doc.releasedAt ?? opts.now,
    updatedAt: opts.now,
  };

  for (const problem of validateCraftbookGraph(candidate)) {
    errors.push(augmentGraphProblem(problem, stepIds));
  }
  for (const problem of validateCraftbookScriptRefs(candidate)) {
    errors.push({ where: 'steps', message: problem });
  }
  for (const error of validateHookScriptRefs(doc)) {
    errors.push(error);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, craftbook: candidate };
}

/**
 * Hook scripts follow the same inline-first contract as step scripts: a
 * `scope: 'craftbook'` ref must name a key in the doc's `scripts` map.
 * (Step refs are covered by `validateCraftbookScriptRefs`; hooks live
 * outside the step graph, so they get their own pass.)
 */
function validateHookScriptRefs(doc: CraftbookDoc): CraftbookDocError[] {
  const errors: CraftbookDocError[] = [];
  const scriptNames = Object.keys(doc.scripts ?? {});
  (doc.hooks ?? []).forEach((hook, index) => {
    const ref = hook.script;
    if (!ref || (ref.scope ?? 'project') !== 'craftbook') return;
    if (scriptNames.includes(ref.name)) return;
    const near = nearestMatch(ref.name, scriptNames);
    errors.push({
      where: `hooks[${index}]${hook.label ? ` ("${hook.label}")` : ''}`,
      message: `script "${ref.name}" (scope craftbook) is not in this document's scripts.`,
      fix:
        scriptNames.length > 0
          ? `inline scripts: ${scriptNames.join(', ')}${near ? ` — did you mean "${near}"?` : ''}`
          : 'add the script to the `scripts` map or change its scope',
    });
  });
  return errors;
}

/**
 * Down-map a runtime `Craftbook` to the round-trippable doc. Guaranteed
 * by construction to be accepted back by `craftbookFromDoc` unchanged —
 * that invariant is what makes `craftbook_read` → edit → `craftbook_write`
 * a safe loop for a model.
 */
export function docFromCraftbook(book: Craftbook): CraftbookDoc {
  return {
    id: book.id,
    name: book.name,
    ...(book.description ? { description: book.description } : {}),
    ...(book.basedOn ? { basedOn: book.basedOn } : {}),
    ...(book.plan ? { plan: book.plan } : {}),
    ...(book.defaultAssignee ? { defaultAssignee: book.defaultAssignee } : {}),
    entryStepId: book.entryStepId,
    ...(book.triggers ? { triggers: book.triggers } : {}),
    ...(book.command ? { command: book.command } : {}),
    ...(book.requirements ? { requirements: book.requirements } : {}),
    ...(book.recommends ? { recommends: book.recommends } : {}),
    ...(book.runModes ? { runModes: book.runModes } : {}),
    ...(book.toolsets ? { toolsets: book.toolsets } : {}),
    ...(book.connectors ? { connectors: book.connectors } : {}),
    ...(book.paramSchema ? { paramSchema: book.paramSchema } : {}),
    ...(book.hooks ? { hooks: book.hooks } : {}),
    steps: book.steps,
    ...(book.scripts ? { scripts: book.scripts } : {}),
    ...(book.version ? { version: book.version } : {}),
  };
}

/**
 * The shared graph validator's messages are precise but terse; augment
 * the dangling-edge class with the valid-id list + nearest match so the
 * retry needs no second round trip. (Wrapper, not an edit at the source
 * — the validator's strings are load-bearing for existing consumers.)
 */
function augmentGraphProblem(problem: string, stepIds: string[]): CraftbookDocError {
  const artifactInput =
    /^step "([^"]+)" consumes artifact "([^"]+)" but its prompt does not explicitly call `read_artifact`$/.exec(
      problem,
    );
  if (artifactInput) {
    return {
      where: `steps (id "${artifactInput[1]}") → prompt`,
      message: `${problem}.`,
      fix: `start the procedure with \`read_artifact({ path: ${JSON.stringify(artifactInput[2])} })\`; artifact paths are not workspace paths`,
    };
  }
  const missing = /"([^"]+)" missing from steps/.exec(problem);
  if (missing) {
    const near = nearestMatch(missing[1]!, stepIds);
    return {
      where: 'steps',
      message: `${problem}.`,
      fix: `valid step ids: ${stepIds.join(', ')}${near ? ` — did you mean "${near}"?` : ''}`,
    };
  }
  if (/is terminal but also has advanceWhen/.test(problem)) {
    return {
      where: 'steps',
      message: `${problem}.`,
      fix: 'a terminal step cannot auto-advance — remove its `advanceWhen`. To hold the final step until its file exists, keep a completion `gate` only (a `deliverable` on a terminal step expands gate-only), or drop `terminal: true` and add a separate final step.',
    };
  }
  if (/is terminal but also has next\/branches/.test(problem)) {
    return {
      where: 'steps',
      message: `${problem}.`,
      fix: 'remove `next`/`branches` from the terminal step, or remove `terminal: true` if it should route onward.',
    };
  }
  return { where: 'steps', message: `${problem}.` };
}
