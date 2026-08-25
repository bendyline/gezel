import {
  type CraftbookCommandNeed,
  type CraftbookDoc,
  CraftbookDocSchema,
  type NewCraftbookStep,
} from '@bendyline/gezel';
import { z } from 'zod';
import { isAccessoryArtifactPath } from './artifact-surface.js';
import { QualityWorkflowSchema, qualityWorkflowSteps } from './gstack-import.js';

/**
 * The tactical authoring track — the compiled home of the "code project
 * tactical task" fleet (bug-fix-tdd, refactor-module, test-suite-backfill,
 * …). One source file per book under Gilde's `authoring/tactical/`, compiled
 * by scripts/generate-tactical-craftbooks.ts into ordinary craftbook-template
 * versions.
 *
 * Why a compiled track and not hand-authored JSON: twenty-plus books of the
 * same seven-step quality loop hand-written WILL diverge (the shipped
 * root-cause-investigation 2.0.4 had already drifted from its overlay
 * source), and the consistency of the gates IS the product. Why not the
 * gallery ArchetypeSpec: it cannot express requireChange, gated evaluates,
 * repair/needs-user, params, runModes, floors, or commands — the entire
 * fleet discipline. The expansion is `qualityWorkflowSteps` — the SAME
 * compiler the gstack wave uses (extended, never forked), so the reference
 * shape that made root-cause-investigation strong is the only shape this
 * track can emit.
 *
 * Fleet rules enforced here rather than trusted to authors:
 *   - accessory outputs (notes, reviews, evidence docs) live under
 *     `{{workPath}}/…` so concurrent runs never collide (ADR 0008), and the
 *     standard `workPath` param is injected when absent;
 *   - no `{{diffpack.*}}` tokens anywhere — a `diffpackCapable` book must be
 *     mode-agnostic, and those tokens are drafting-mode-only (the runtime
 *     injects mode framing; content never knows the mode).
 */

/** Release mapping for the tactical wave — versions are PER BOOK because the
 * fleet spans rebuilt lines (bug-fix-tdd 1.0.3 → 2.0.0) and brand-new ids. */
export const TacticalWaveBookSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    releasedAt: z.string().datetime(),
    /**
     * Oldest gezel build that can run this version. Books whose gates use
     * the v2 primitives (commandEvidence, checkFixReview, diffpackCapable,
     * template capabilityFloor) carry the floor of the release shipping
     * them; content-only books carry the workPath floor.
     */
    minGezelVersion: z.string().min(1),
  })
  .strict();
export type TacticalWaveBook = z.infer<typeof TacticalWaveBookSchema>;

export const TacticalWaveConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    books: z.array(TacticalWaveBookSchema).min(1),
  })
  .strict()
  .superRefine((wave, ctx) => {
    const seen = new Set<string>();
    wave.books.forEach((book, index) => {
      if (seen.has(book.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['books', index, 'id'],
          message: `duplicate id "${book.id}"`,
        });
      }
      seen.add(book.id);
    });
  });
export type TacticalWaveConfig = z.infer<typeof TacticalWaveConfigSchema>;

/**
 * Doc-level fields the workflow expansion does not produce. A subset of
 * CraftbookDoc, picked explicitly so a typo'd field fails the parse here
 * instead of silently vanishing in the identity merge.
 */
export const TacticalDocBlockSchema = CraftbookDocSchema.pick({
  paramSchema: true,
  toolsets: true,
  connectors: true,
  commands: true,
  requirements: true,
  runModes: true,
  capabilityFloor: true,
  diffpackCapable: true,
  basedOn: true,
  defaultAssignee: true,
}).strict();
export type TacticalDocBlock = z.infer<typeof TacticalDocBlockSchema>;

export const TacticalBookSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    /** Shelf-card copy (identity `description`) — one to two sentences. */
    description: z.string().min(1),
    /** Subject shelf (identity `category`), e.g. `code-quality`. */
    category: z.string().min(1),
    /** Lifecycle role (identity `role`): project-starter | maintenance-review | general. */
    role: z.enum(['project-starter', 'maintenance-review', 'general']),
    tags: z.array(z.string().min(1)).min(1),
    triggers: z.array(z.string().min(1)).optional(),
    command: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    /** Long about prose shipped as the doc `description`. Falls back to `description`. */
    about: z.string().optional(),
    doc: TacticalDocBlockSchema.optional(),
    workflow: QualityWorkflowSchema,
  })
  .strict();
export type TacticalBook = z.infer<typeof TacticalBookSchema>;

const WORK_PATH_PARAM = {
  type: 'string',
  title: 'Working folder',
  description:
    "Per-task working folder in the artifacts drawer. Defaults to this task's own folder so runs never collide; override with a stable name when you deliberately want runs to share files.",
  default: '{{task.dir}}',
} as const;

/** Fleet lint: problems that make a tactical source unshippable. */
export function lintTacticalBook(book: TacticalBook): string[] {
  const problems: string[] = [];
  const sourceText = JSON.stringify(book);
  if (/\{\{\s*diffpack\./.test(sourceText)) {
    problems.push(
      'references a {{diffpack.*}} token — those resolve only in drafting mode, and a mode-agnostic book must read identically in both modes (use {{workPath}}/fix-notes.md and friends)',
    );
  }
  if (
    book.doc?.diffpackCapable &&
    /\b(diffpack|change proposal|propose mode)\b/i.test(
      book.workflow.phases.map((p) => p.prompt).join('\n'),
    )
  ) {
    problems.push(
      'a diffpackCapable book must carry no mode prose — the runtime injects the drafting framing when a run proposes',
    );
  }
  for (const phase of book.workflow.phases) {
    if (isAccessoryArtifactPath(phase.output.path)) continue;
    if (/^(src|lib|app|test|tests)\//.test(phase.output.path)) {
      problems.push(
        `phase "${phase.id}" gates on the synthetic source path "${phase.output.path}" — tactical books never prescribe where real code lands; gate on a {{workPath}}/ evidence artifact and prove the code change with citationsResolve/commandEvidence instead`,
      );
    }
  }
  if (book.workflow.review.enforce && !isAccessoryArtifactPath(book.workflow.review.reviewPath)) {
    problems.push(
      `review.reviewPath "${book.workflow.review.reviewPath}" must live under {{workPath}}/ so the review exists identically in edit and propose modes`,
    );
  }
  const commandChecks = book.workflow.phases.flatMap((p) =>
    (p.output.additionalChecks ?? []).filter((c) => c.kind === 'commandEvidence'),
  );
  const declared = new Set(
    (book.doc?.commands ?? []).map((c: CraftbookCommandNeed) => `${c.scope}:${c.name}`),
  );
  for (const check of commandChecks) {
    const key = check.script ? `script:${check.script}` : `npx:${check.bin ?? ''}`;
    if (!declared.has(key)) {
      problems.push(
        `a commandEvidence gate expects ${key} but the doc block declares no matching \`commands\` need — the launcher would never raise its approval up front`,
      );
    }
  }
  return problems;
}

/**
 * Compile one tactical source into the shipped CraftbookDoc. Pure — the
 * writer script and the regen-fidelity test both call this.
 */
export function tacticalCraftbookDoc(book: TacticalBook, release: TacticalWaveBook): CraftbookDoc {
  if (book.id !== release.id) {
    throw new Error(`tactical book id "${book.id}" does not match wave entry "${release.id}"`);
  }
  const problems = lintTacticalBook(book);
  if (problems.length > 0) {
    throw new Error(`${book.id}: ${problems.map((p) => `\n  - ${p}`).join('')}`);
  }
  const steps: NewCraftbookStep[] = qualityWorkflowSteps(book.workflow);
  const paramSchema = withWorkPathParam(book.doc?.paramSchema);
  return CraftbookDocSchema.parse({
    id: book.id,
    name: book.name,
    description: book.about ?? book.description,
    plan: book.workflow.plan,
    entryStepId: book.workflow.phases[0]!.id,
    steps,
    ...(book.triggers ? { triggers: book.triggers } : {}),
    ...(book.command ? { command: book.command } : {}),
    ...(book.doc?.basedOn ? { basedOn: book.doc.basedOn } : {}),
    ...(book.doc?.defaultAssignee ? { defaultAssignee: book.doc.defaultAssignee } : {}),
    paramSchema,
    ...(book.doc?.toolsets ? { toolsets: book.doc.toolsets } : {}),
    ...(book.doc?.connectors ? { connectors: book.doc.connectors } : {}),
    ...(book.doc?.commands ? { commands: book.doc.commands } : {}),
    ...(book.doc?.requirements ? { requirements: book.doc.requirements } : {}),
    ...(book.doc?.runModes ? { runModes: book.doc.runModes } : {}),
    ...(book.doc?.capabilityFloor ? { capabilityFloor: book.doc.capabilityFloor } : {}),
    ...(book.doc?.diffpackCapable ? { diffpackCapable: true } : {}),
    version: release.version,
    releasedAt: release.releasedAt,
    minGezelVersion: release.minGezelVersion,
  });
}

/** Inject the standard `workPath` param unless the author already declares one. */
function withWorkPathParam(
  paramSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties = {
    ...((paramSchema?.properties as Record<string, unknown> | undefined) ?? {}),
  };
  if (!properties.workPath) {
    properties.workPath = { ...WORK_PATH_PARAM };
  }
  return { type: 'object', ...(paramSchema ?? {}), properties };
}

/**
 * Identity merge for tactical books. Unlike the gstack wave (which never
 * owns role/category), the tactical source AUTHORS them — but artwork,
 * license, maintainer, and yanks still survive regeneration.
 */
export function mergeTacticalIdentity(
  existing: Record<string, unknown>,
  book: TacticalBook,
): Record<string, unknown> {
  return {
    ...existing,
    schemaVersion: 1,
    kind: 'craftbook-template',
    id: book.id,
    name: book.name,
    description: book.description,
    role: book.role,
    category: book.category,
    tags: book.tags,
    maintainer: existing.maintainer ?? { name: 'Gezel' },
    license: existing.license ?? 'MIT',
    yankedVersions: existing.yankedVersions ?? [],
  };
}
