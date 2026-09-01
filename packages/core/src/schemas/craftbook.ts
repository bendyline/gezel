import { z } from 'zod';
import { MODEL_TIER_ORDER, type ModelTier } from '../roles/tier.js';
import { type TaskAssignee, TaskAssigneeSchema } from './assignee.js';
import {
  type GateSpec,
  GateSpecSchema,
  type StepGateUnion,
  StepGateUnionSchema,
  StepSniffSchema,
  gateEdgeTargets,
  isLegacyGateSpec,
  normalizeStepGate,
} from './gate.js';
import { HookSpecSchema } from './hook.js';
import { type RetrievalPolicy, RetrievalPolicySchema } from './retrieval.js';
import {
  ScriptNameSchema,
  ScriptOutputPredicateSchema,
  type ScriptRef,
  type ScriptRefList,
  ScriptRefListSchema,
  ScriptRefSchema,
  normalizeScriptRefs,
} from './script.js';

// Gate shapes moved to ./gate.js; re-exported here so existing consumers
// (`import { GateSpecSchema } from './craftbook.js'`) keep working.
export {
  GateCheckSchema,
  type GateCheck,
  GateSpecSchema,
  type GateSpec,
  GateScriptRefSchema,
  type GateScriptRef,
  GateScriptResultSchema,
  type GateScriptResult,
  StepGateSchema,
  type StepGate,
  StepGateUnionSchema,
  type StepGateUnion,
  type NormalizedStepGate,
  normalizeStepGate,
  isLegacyGateSpec,
  gateEdgeTargets,
  GATE_DEFAULT_MAX_ATTEMPTS,
  GATE_MAX_PROGRESS_ATTEMPTS,
  StepSniffSchema,
  type StepSniff,
} from './gate.js';

/**
 * ─ Craftbook ─────────────────────────────────────────────────────────
 *
 * A craftbook is a structured recipe of steps with edges, scripts, and
 * prompts. Catalog-distributed (kind: 'craftbook-template') and embedded
 * into a Task at create time so each running task carries its own copy
 * — edits to the source template do not retroactively reshape running
 * work.
 *
 * Edge resolution at completion of a step (in order):
 *   1. explicit `next` arg from the caller (a "jump")
 *   2. `step.terminal === true` → no further edges; complete the task
 *   3. `step.branches`: evaluate each predicate against the step's
 *      `onExit` script output; first match wins (`goto`)
 *   4. `step.next`
 *   5. fallback: the next step in array order (linear behavior)
 */

export const CraftbookBranchSchema = z.object({
  when: ScriptOutputPredicateSchema,
  goto: z.string(),
});
export type CraftbookBranch = z.infer<typeof CraftbookBranchSchema>;

/**
 * Observable-progress auto-advance contract. When a step declares this, the
 * runtime MAY advance the step WITHOUT the model calling `advance_task_step`
 * — the moment the named deliverable is observed (exists, clears `minBytes`,
 * and passes the optional `sniff`) at the end of the assignee's turn. This
 * exists because models reliably DO work (`write_file`) but reliably DON'T
 * call the meta-navigation tool, so step progression rides on the work
 * itself. Distinct from `onExit` (which only runs AFTER a model-driven
 * advance). Strictly opt-in — absent the field, advancement is unchanged.
 */
export const AdvanceWhenSchema = z.object({
  /** Workspace-relative deliverable whose presence signals "this step is done". */
  file: z.string().min(1),
  /** Liveness floor in bytes (guards against an empty/stub file). Default 1. */
  minBytes: z.number().int().positive().optional(),
  /**
   * Named content check the runtime runs before advancing. `html-complete`
   * = a non-truncated HTML doc (balanced `<script>` tags + a closing
   * `</body>`/`</html>`); `html-game` adds a render surface + substantial
   * JS; `nonempty`/`json-valid` are generic. Absent = existence + minBytes
   * only.
   */
  sniff: StepSniffSchema.optional(),
  /**
   * Edit-gate. When true, presence is NOT enough — the assignee must have
   * *written to* `file` during the turn that triggers the advance. This is
   * what makes `advanceWhen` usable on a step whose deliverable is an EDIT
   * to a pre-existing source file (fix-a-bug, refactor): without it the
   * gate would fire on the very first turn because the file already exists
   * and clears `minBytes`, advancing past the step before any fix lands.
   * With it, the step holds until the model actually edits the file (a
   * successful `write_file`/`replace_in_file`/`append_to_file`/`apply_patch`/
   * `insert_at_marker` targeting `file` this turn). The `sniff`/`minBytes`
   * floor still applies on top. Absent → legacy "exists is enough".
   */
  requireChange: z.boolean().optional(),
  /**
   * Resolve `file` against the project's ARTIFACTS drawer
   * (`read_artifact` / `write_artifact`) instead of the shipped workspace.
   * For deliverables that are review/analysis output — a threat model, an
   * audit report — not product source the user ships. The runtime's
   * observable-progress + gate readers honor this flag so an artifact
   * deliverable is gated for size/shape exactly like a workspace one.
   * Absent → workspace (the default).
   */
  artifact: z.boolean().optional(),
  /** Step to activate on the signal. Defaults to `next`; must resolve like `next`. */
  goto: z.string().optional(),
});
export type AdvanceWhen = z.infer<typeof AdvanceWhenSchema>;

/**
 * A file a step must read before it can do its work. Declaring the drawer
 * here keeps handoffs unambiguous: the runtime can name the exact read tool
 * instead of asking the model to infer provenance from a bare relative path.
 */
export const CraftbookStepInputSchema = z.object({
  /** Path relative to the selected drawer's root. */
  file: z.string().min(1).describe('Path relative to the selected drawer root.'),
  /** Read from the artifacts drawer instead of the project workspace. */
  artifact: z
    .boolean()
    .optional()
    .describe('True for the artifacts drawer; false/omitted for the project workspace.'),
});
export type CraftbookStepInput = z.infer<typeof CraftbookStepInputSchema>;

/**
 * The single persistence surface a step is expected to WRITE as its result.
 * Reads are deliberately independent: an artifact-output step may consume a
 * workspace file, and a task-note reviewer may inspect either drawer. Task
 * notes may remain available as short progress metadata on file-producing
 * steps, but never satisfy or substitute for the declared result medium.
 */
export const CraftbookStepWritableOutputMediumSchema = z.enum([
  'workspace',
  'artifact',
  'task-note',
]);
export type CraftbookStepWritableOutputMedium = z.infer<
  typeof CraftbookStepWritableOutputMediumSchema
>;
export const CraftbookStepOutputMediumSchema = z.enum([
  ...CraftbookStepWritableOutputMediumSchema.options,
  'none',
]);
export type CraftbookStepOutputMedium = z.infer<typeof CraftbookStepOutputMediumSchema>;

/**
 * Subtractive per-step tool policy. A craftbook never has to enumerate the
 * complete positive tool roster: the role, install, security policy, and
 * model tier still establish that roster, then this policy removes what the
 * active step cannot need.
 *
 * `disallowToolsets` targets installed catalog/MCP ids (for example
 * `docblocks`). `disallowBuiltinToolsets` targets Gezel's stable built-in
 * group ids (for example `code-execution` or `workspace-fs-write`). These
 * are intentionally NOT the broad catalog categories, whose classification
 * is heuristic and therefore unsuitable for runtime authority.
 */
export const CraftbookStepToolPolicySchema = z
  .object({
    disallowToolsets: z.array(z.string().trim().min(1)).min(1).optional(),
    disallowBuiltinToolsets: z.array(z.string().trim().min(1)).min(1).optional(),
    outputMedium: CraftbookStepOutputMediumSchema.optional(),
    /**
     * Other intentional write surfaces used while producing the primary
     * result (for example edit workspace source + emit an artifact report).
     * `none` is never a secondary medium.
     */
    additionalOutputMedia: z.array(CraftbookStepWritableOutputMediumSchema).min(1).optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const additional = new Set(policy.additionalOutputMedia ?? []);
    if (policy.outputMedium === 'none' && additional.size > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['additionalOutputMedia'],
        message: '`none` cannot have secondary output media',
      });
    }
    if (
      policy.outputMedium &&
      policy.outputMedium !== 'none' &&
      additional.has(policy.outputMedium)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['additionalOutputMedia'],
        message: 'the primary output medium must not be repeated as a secondary medium',
      });
    }
    const media = new Set([policy.outputMedium, ...additional]);
    const denied = new Set(policy.disallowBuiltinToolsets ?? []);
    if (media.has('workspace') && denied.has('workspace-fs-write')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disallowBuiltinToolsets'],
        message: 'workspace output conflicts with disallowing `workspace-fs-write`',
      });
    }
    if (media.has('artifact') && denied.has('artifacts')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disallowBuiltinToolsets'],
        message: 'artifact output conflicts with disallowing `artifacts`',
      });
    }
    if (media.has('task-note') && denied.has('tasks')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disallowBuiltinToolsets'],
        message: 'task-note output conflicts with disallowing `tasks`',
      });
    }
  });
export type CraftbookStepToolPolicy = z.infer<typeof CraftbookStepToolPolicySchema>;

/**
 * Wire twin of {@link ModelTier} (roles/tier.ts) — derived from the
 * canonical `MODEL_TIER_ORDER` tuple so the two can never drift.
 */
export const ModelTierSchema = z.enum(MODEL_TIER_ORDER);

export const CraftbookStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * Per-step prompt body. In bundled/local catalog form, this is loaded
   * from the per-step `prompt.md` file (when the version manifest carries
   * a separate file) and inlined at resolution time.
   */
  prompt: z.string().optional(),
  suggestedGezelId: z.string().optional(),
  /**
   * Free-form role hint ("reviewer", "developer", "designer"). When set
   * and `suggestedGezelId` / `assignee` are both absent at step
   * activation, the TaskManager runs the role through `ensureGezel`
   * (fuzzy roster match → gilde template → bespoke fallback) and
   * persists the result onto the step's `suggestedGezelId`. Lets a
   * craftbook step say "do this with a Reviewer" without baking in a
   * specific gezel id. Override by setting `assignee` or
   * `suggestedGezelId` at task create time.
   */
  suggestedRole: z.string().optional(),
  /**
   * Minimum model tier to run this step unsupervised. Overrides the
   * `suggestedRole`'s registry floor (roles/registry.ts) when set;
   * absent → role floor → no routing. Consumed by per-step model
   * routing at handoff dispatch: the cheapest installed local model
   * that clears the floor runs the step.
   */
  capabilityFloor: ModelTierSchema.optional(),
  /** Per-phase indexed-context policy; overrides gezel and install defaults. */
  retrieval: RetrievalPolicySchema.optional(),
  /** Per-step subtractive tool and output-surface policy. */
  toolPolicy: CraftbookStepToolPolicySchema.optional(),
  assignee: TaskAssigneeSchema.optional(),
  /** Setup scripts, run in order when the step activates. Single ref = legacy shape. */
  onEnter: ScriptRefListSchema.optional(),
  /**
   * Cleanup scripts — the `finally` of the step. Run in order AFTER the
   * gate (if any) approves; never on a gate reject. Branch predicates
   * read the LAST ref's output (legacy routing; prefer gate routing).
   */
  onExit: ScriptRefListSchema.optional(),
  /** Required file inputs for this step, in the order they should be opened. */
  consumes: z
    .array(CraftbookStepInputSchema)
    .min(1)
    .optional()
    .describe(
      'Files this step must open before working. Artifact inputs also require an explicit `read_artifact` call in the step prompt.',
    ),
  /** See {@link AdvanceWhenSchema}. */
  advanceWhen: AdvanceWhenSchema.optional(),
  /** The end-of-step decision. See {@link StepGateSchema} (current) / {@link GateSpecSchema} (legacy). */
  gate: StepGateUnionSchema.optional(),
  next: z.string().optional(),
  branches: z.array(CraftbookBranchSchema).optional(),
  terminal: z.boolean().optional(),
  /**
   * Marks the parent step that triggers a declarative per-item fanout
   * (see {@link CraftbookSpawnSchema}). When this step activates on a
   * spawn-host task, the runtime reads the craftbook's `spawn.overFile`
   * JSON array on its declared surface and spawns one child task per item — no model
   * tool call. Inert unless the craftbook also declares `spawn`.
   */
  spawnFanout: z.boolean().optional(),
});
export type CraftbookStep = z.infer<typeof CraftbookStepSchema>;

/**
 * Declarative per-item fanout config. A craftbook that declares `spawn`
 * becomes a spawn host: when its `spawnFanout` step activates, the runtime
 * reads `overFile` (a JSON file the parent produces on the declared surface),
 * extracts the item array (the file IS the array, or the array at the
 * dotted `itemsPath`), and spawns one child task per item from `steps`
 * (each item's fields become the child's `variation.context`, string-
 * substituted into the child step prompts, declared inputs, and
 * gate/advanceWhen paths).
 * The runtime fans out; no model tool call is involved.
 */
export const CraftbookSpawnSchema = z.object({
  /** Surface-relative JSON file the parent produces; its array drives the fanout. */
  overFile: z.string().min(1),
  /** Read overFile from the artifacts drawer instead of the project workspace. */
  overArtifact: z.boolean().optional(),
  /** Dotted path to the array inside `overFile`. Absent → the file itself is the array. */
  itemsPath: z.string().optional(),
  /** Entry step id of the child template. Defaults to the first `steps` entry. */
  entryStepId: z.string().optional(),
  /** The per-child step template — same shape as a craftbook's own steps. */
  steps: z.array(CraftbookStepSchema).min(1),
});
export type CraftbookSpawn = z.infer<typeof CraftbookSpawnSchema>;

/**
 * Pure structural validation of a craftbook graph: step ids unique,
 * entryStepId resolves, every `next`/`branches[].goto`/`gate` route/
 * `advanceWhen.goto` resolves, terminal steps don't also carry edges.
 * Returns the list of human-readable problems (empty = valid).
 *
 * Shared by the Zod refinement below AND the editing ops (which run it
 * after a mutation), so a task's embedded craftbook and a standalone
 * template are held to the same contract. Accepts `CraftbookStep[]` —
 * `TaskCraftbookStep[]` is assignable since it only extends the shape.
 */
export function validateCraftbookGraph(cb: {
  steps: CraftbookStep[];
  entryStepId: string;
}): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of cb.steps) {
    if (ids.has(s.id)) problems.push(`duplicate step id "${s.id}"`);
    ids.add(s.id);
    if (s.terminal && (s.next || (s.branches && s.branches.length > 0))) {
      problems.push(`step "${s.id}" is terminal but also has next/branches`);
    }
  }
  if (!ids.has(cb.entryStepId)) {
    problems.push(`entryStepId "${cb.entryStepId}" not in steps`);
  }
  for (const s of cb.steps) {
    if (s.next && !ids.has(s.next)) {
      problems.push(`step "${s.id}".next "${s.next}" missing from steps`);
    }
    for (const b of s.branches ?? []) {
      if (!ids.has(b.goto)) {
        problems.push(`step "${s.id}" branch goto "${b.goto}" missing from steps`);
      }
    }
    if (s.advanceWhen) {
      // A terminal step has nowhere to auto-advance to; and an explicit
      // `goto` must resolve (it's an edge, same as `next`).
      if (s.terminal) problems.push(`step "${s.id}" is terminal but also has advanceWhen`);
      if (s.advanceWhen.goto && !ids.has(s.advanceWhen.goto)) {
        problems.push(`step "${s.id}" advanceWhen.goto "${s.advanceWhen.goto}" missing from steps`);
      }
    }
    for (const input of s.consumes ?? []) {
      if (!input.artifact) continue;
      // The structured field drives runtime prompting, while the explicit
      // authored call keeps the procedure self-contained for older runtimes
      // and makes the small-model first-action scanner choose correctly.
      if (!/`read_artifact(?:`|\()/.test(s.prompt ?? '')) {
        problems.push(
          `step "${s.id}" consumes artifact "${input.file}" but its prompt does not explicitly call \`read_artifact\``,
        );
      }
    }
    if (s.gate) {
      const gate = normalizeStepGate(s.gate);
      // An activation gate on a terminal step can never fire usefully
      // (the step is the end); a COMPLETION gate on a terminal step is
      // legitimate — its reject blocks task completion.
      if (s.terminal && gate.at === 'activation') {
        problems.push(`step "${s.id}" is terminal but also has an activation gate`);
      }
      for (const edge of gateEdgeTargets(s.gate)) {
        if (!ids.has(edge)) {
          problems.push(`step "${s.id}" gate route "${edge}" missing from steps`);
        }
      }
    }
  }
  return problems;
}

/**
 * Declarative fanout needs BOTH halves: the `spawn` block naming what to
 * fan out over, and a `spawnFanout` step that triggers it. Either alone is
 * inert — the runtime guard is
 * `newStep.spawnFanout && task.spawnsCraftbook && spawn` — so a book with
 * one and not the other saves cleanly, reports success, and then silently
 * does nothing at all.
 *
 * Separate from {@link validateCraftbookGraph} because this is a WHOLE-BOOK
 * property, not a step-graph one: `collapseCraftbookForTier` validates a
 * merged step list it has no spawn context for, and folding this in there
 * would reject every tier-collapsed fanout book.
 *
 * Deliberately NOT a `CraftbookSchema` refinement. Persisted task
 * snapshots embed their craftbook and are parsed forever; making this a
 * parse-time error would render a book authored before the check
 * unreadable rather than merely inert. It runs at WRITE time, where the
 * message reaches the author who can act on it.
 *
 * Wild-caught on the inaugural frontier run of `craftbook-author-fanout`:
 * the model marked its step `spawnFanout: true`, omitted the `spawn` block,
 * was told "Saved craftbook — 2 of 2 steps are gated", and then spent
 * eighteen minutes unable to see why no children appeared. All 929 bundled
 * book versions already satisfy this, so enforcing it costs nothing and
 * turns a silent no-op into a repair-grade error the author can act on.
 */
export function validateCraftbookFanout(cb: {
  steps: CraftbookStep[];
  spawn?: CraftbookSpawn | undefined;
}): string[] {
  const triggers = cb.steps.filter((s) => s.spawnFanout).map((s) => s.id);
  if (cb.spawn && triggers.length === 0) {
    return [
      'the craftbook declares a spawn block but no step has spawnFanout: true — nothing triggers the fanout, so no child task is ever created',
    ];
  }
  if (!cb.spawn && triggers.length > 0) {
    return [
      `step "${triggers[0]}" has spawnFanout: true but the craftbook declares no spawn block — add spawn.overFile (the JSON array to fan out over) and spawn.steps (the per-item work), or the step fans out over nothing`,
    ];
  }
  return [];
}

/** Throw an Error if a craftbook graph has any structural problem. */
export function assertCraftbookGraph(cb: { steps: CraftbookStep[]; entryStepId: string }): void {
  const problems = validateCraftbookGraph(cb);
  if (problems.length > 0) {
    throw new Error(`invalid craftbook: ${problems.join('; ')}`);
  }
}

function refineCraftbook(
  cb: {
    steps: CraftbookStep[];
    entryStepId: string;
    scripts?: Record<string, string>;
    spawn?: CraftbookSpawn | undefined;
  },
  ctx: z.RefinementCtx,
) {
  for (const message of validateCraftbookGraph(cb)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
      path: message.startsWith('entryStepId') ? ['entryStepId'] : ['steps'],
    });
  }
  for (const message of validateCraftbookScriptRefs(cb)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['steps'] });
  }
}

/**
 * A prerequisite a project must satisfy before a craftbook is applicable
 * — and therefore before it's offered in the launcher / recognized as a
 * command. Lets a craftbook like Pull Request Review declare that it only
 * makes sense on a GitHub-connected project that's on a feature branch,
 * so it isn't shown (and silently fails at "load the PR") elsewhere.
 */
export const CraftbookRequirementSchema = z.discriminatedUnion('kind', [
  /** The project is connected to a GitHub repository. */
  z.object({ kind: z.literal('github') }),
  /** The project's current git branch is not the main line (main/master). */
  z.object({ kind: z.literal('non-main-branch') }),
]);
export type CraftbookRequirement = z.infer<typeof CraftbookRequirementSchema>;

/**
 * A soft author hint that the craftbook works BETTER with an install
 * capability enabled, while remaining fully runnable without it. Never
 * gates: unlike {@link CraftbookRequirementSchema} (hard — hides the book
 * when unmet) and {@link CraftbookToolsetNeedSchema} (surfaces an install
 * affordance), a recommendation only informs UI copy — e.g. the craftbook
 * start card nudging that "PowerPoint from Content" researches better with
 * External services on. Carried into the runtime craftbook and the task
 * snapshot so the chat card can read it off the task at event time.
 */
export const CraftbookRecommendationSchema = z.discriminatedUnion('kind', [
  /**
   * Works better with the install-wide External services capability
   * (`securityPolicy.allowExternalServices`) — web search, URL fetch.
   */
  z.object({
    kind: z.literal('external-services'),
    /** Human-readable rationale shown in the nudge ("verifies sources with live web search"). */
    reason: z.string().optional(),
  }),
]);
export type CraftbookRecommendation = z.infer<typeof CraftbookRecommendationSchema>;

/**
 * Author guidance for the task launchers. Every craftbook remains usable as
 * a one-time task; these optional flags identify recipes that are also safe
 * to run unattended on a cadence or during Night Shift. `recommended` sorts
 * ahead of merely `supported` recipes in the corresponding launcher.
 */
export const CraftbookRunModesSchema = z.object({
  scheduled: z.enum(['supported', 'recommended']).optional(),
  nightShift: z.enum(['supported', 'recommended']).optional(),
});
export type CraftbookRunModes = z.infer<typeof CraftbookRunModesSchema>;

/** The project facts a craftbook's requirements are evaluated against. */
export interface CraftbookRequirementContext {
  /** Project has a GitHub repo connected (`project.github.url` set). */
  hasGitHub: boolean;
  /** Current git branch of the project's checkout, or null if unknown. */
  branch: string | null;
}

const MAIN_BRANCHES = new Set(['main', 'master']);

/**
 * Returns the human-readable reasons a project does NOT satisfy a
 * craftbook's requirements (empty = all met). Pure — both the UI filter
 * and the server's command gating call it with the same context.
 */
export function unmetCraftbookRequirements(
  requirements: CraftbookRequirement[] | undefined,
  ctx: CraftbookRequirementContext,
): string[] {
  const unmet: string[] = [];
  for (const r of requirements ?? []) {
    if (r.kind === 'github') {
      if (!ctx.hasGitHub) unmet.push('a GitHub-connected project');
    } else if (r.kind === 'non-main-branch') {
      if (!ctx.branch || MAIN_BRANCHES.has(ctx.branch)) {
        unmet.push('a branch other than main/master');
      }
    }
  }
  return unmet;
}

export function craftbookRequirementsMet(
  requirements: CraftbookRequirement[] | undefined,
  ctx: CraftbookRequirementContext,
): boolean {
  return unmetCraftbookRequirements(requirements, ctx).length === 0;
}

/**
 * A toolset (MCP server / CLI / API integration) a craftbook depends on,
 * declared up front so the launcher can offer to install + configure it
 * before the craftbook runs, and so its tools can be pre-authorized.
 *
 * Distinct from {@link CraftbookRequirementSchema} (a pure boolean gate
 * that *hides* a craftbook when unmet): a missing toolset never hides the
 * craftbook — it surfaces a "needs setup" affordance — and the field
 * carries richer per-toolset metadata (`autoAllow`, `reason`, version
 * floor). Unlike `requirements`, this field is threaded into the runtime
 * {@link CraftbookSchema} and the task snapshot because auto-allow
 * derivation reads it at chat-session build time.
 */
export const CraftbookToolsetNeedSchema = z.object({
  /** Catalog toolset id, e.g. `github`, `usb-camera`. */
  toolsetId: z.string().min(1),
  /** Catalog source provenance (bundled/community), when pinned. */
  sourceId: z.string().optional(),
  /** Optional semver floor; presence is recorded but not yet enforced. */
  minVersion: z.string().optional(),
  /**
   * When true, the need is a suggestion only — surfaced as a hint, never
   * blocks invocation. Default (absent/false) = required: the launcher
   * offers install before the craftbook can run.
   */
  optional: z.boolean().optional(),
  /**
   * When true, pre-authorize every tool this toolset exposes for the
   * duration the craftbook is active — both via a synthesized PreToolUse
   * allow-hook (in-process providers) and the Claude-CLI permission
   * broker. Off by default; opt in for unattended/scheduled craftbooks.
   */
  autoAllow: z.boolean().optional(),
  /** Human-readable rationale shown in the launcher ("pull camera frames"). */
  reason: z.string().optional(),
});
export type CraftbookToolsetNeed = z.infer<typeof CraftbookToolsetNeedSchema>;

/**
 * A project command this craftbook's gates expect to verify runs of —
 * `run_package_script` (`scope: 'script'`) or `run_npx` (`scope: 'npx'`)
 * invocations that `commandEvidence` checks will look for receipts of.
 * Declaring it lets the launcher raise the first-use approval question at
 * KICKOFF instead of mid-task: the user approves `npm run test` while
 * launching "Fix a bug", not three steps in when the model first tries to
 * run the suite. Approval stays the user's act, recorded in the same
 * per-project invocation-hash store every ad-hoc run uses — an unapproved
 * command still pauses exactly as today. `args` must be the exact extra
 * argument vector (default none): the approval store pins ONE invocation
 * hash per command name, so books standardize on the argless canonical
 * invocation. `optional: true` marks a command the book can degrade
 * without (the launcher may not push for it).
 */
export const CraftbookCommandNeedSchema = z.object({
  scope: z.enum(['script', 'npx']),
  name: z.string().min(1),
  args: z.array(z.string()).optional(),
  reason: z.string().optional(),
  optional: z.boolean().optional(),
});
export type CraftbookCommandNeed = z.infer<typeof CraftbookCommandNeedSchema>;

/**
 * Returns the *required* (non-optional) toolset needs whose ids are not
 * present in `installedToolsetIds` — the set the launcher must offer to
 * install before the craftbook can run. Pure; both the listing route and
 * the UI's setup affordance derive from it.
 */
export function unmetToolsets(
  toolsets: CraftbookToolsetNeed[] | undefined,
  installedToolsetIds: ReadonlySet<string>,
): CraftbookToolsetNeed[] {
  return (toolsets ?? []).filter((t) => !t.optional && !installedToolsetIds.has(t.toolsetId));
}

/**
 * A connector (external source mirrored into the project's `artifacts/data/`
 * corpus) a craftbook reads from. Declaring the dependency lets the
 * launcher bind + sync it BEFORE the first gezel step runs, so the step
 * reviews local files instead of calling a live API mid-turn.
 *
 * This is the ingest-bound counterpart to {@link CraftbookToolsetNeedSchema}
 * and follows its philosophy, not `requirements`': a missing connector
 * never hides the craftbook, it surfaces a "needs setup" affordance. The
 * distinction matters because connectors are deliberately NOT model-facing
 * — nothing here grants the gezel a tool. See docs/connector-standards.md.
 */
export const CraftbookConnectorNeedSchema = z.object({
  /** Catalog connector-type id, e.g. `github-pulls`, `mail-gmail`. */
  typeId: z.string().min(1),
  /** Catalog source provenance (bundled/community), when pinned. */
  sourceId: z.string().optional(),
  /**
   * When true, the craftbook still runs without the connector bound —
   * the corpus is a bonus, not the substrate. Default (absent/false) =
   * required: the launcher offers to bind it before the craftbook runs.
   */
  optional: z.boolean().optional(),
  /** Human-readable rationale shown in the launcher ("pull the PR diff"). */
  reason: z.string().optional(),
});
export type CraftbookConnectorNeed = z.infer<typeof CraftbookConnectorNeedSchema>;

/**
 * Returns the *required* (non-optional) connector needs whose type ids are
 * not bound on the project — the set the launcher must offer to bind
 * before the craftbook can run. Pure; the listing route, the UI setup
 * affordance, and `TaskManager.create` all derive from it.
 */
export function unmetConnectors(
  connectors: CraftbookConnectorNeed[] | undefined,
  boundTypeIds: ReadonlySet<string>,
): CraftbookConnectorNeed[] {
  return (connectors ?? []).filter((c) => !c.optional && !boundTypeIds.has(c.typeId));
}

/* ─────────────────────────── Inline scripts ─────────────────────────── */

/** Per-script source ceiling. Inline sources are authored by models — a
 * legitimate gate/lifecycle script is a page or two of TypeScript, so a
 * source larger than this is almost certainly a pasted deliverable. */
export const CRAFTBOOK_SCRIPT_MAX_BYTES = 64 * 1024;
/** Summed ceiling across the whole `scripts` map. */
export const CRAFTBOOK_SCRIPTS_TOTAL_MAX_BYTES = 256 * 1024;
export const CRAFTBOOK_SCRIPTS_MAX_COUNT = 24;

/**
 * The craftbook's embedded scripts: name → TypeScript source. One artifact
 * carries the whole book — steps, gates, AND the scripts they reference
 * (`scope: 'craftbook'` refs resolve against this map first, falling back
 * to the project-installed copy for older books). Script meta lives INSIDE
 * the source (`export const meta = defineScript({...})`), so there is no
 * parallel meta field to drift. Key shape reuses {@link ScriptNameSchema}
 * — the path-traversal fence — because the map is persisted to
 * `scripts/{name}.ts` files on disk.
 */
export const CraftbookScriptsSchema = z
  .record(ScriptNameSchema, z.string().min(1).max(CRAFTBOOK_SCRIPT_MAX_BYTES))
  .superRefine((scripts, ctx) => {
    const names = Object.keys(scripts);
    if (names.length > CRAFTBOOK_SCRIPTS_MAX_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a craftbook carries at most ${CRAFTBOOK_SCRIPTS_MAX_COUNT} scripts (got ${names.length})`,
      });
    }
    let total = 0;
    for (const name of names) total += scripts[name]!.length;
    if (total > CRAFTBOOK_SCRIPTS_TOTAL_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `craftbook scripts total ${total} bytes — the ceiling is ${CRAFTBOOK_SCRIPTS_TOTAL_MAX_BYTES}`,
      });
    }
  });
export type CraftbookScripts = z.infer<typeof CraftbookScriptsSchema>;

/**
 * Credit for an upstream work that a craftbook adapts. This is deliberately
 * distinct from `maintainer`: the maintainer owns this packaged craftbook,
 * while `basedOn` points readers to the original project or procedure that
 * inspired it.
 */
export const CraftbookBasedOnSchema = z.object({
  name: z.string().min(1),
  url: z
    .string()
    .url()
    .regex(/^https?:\/\//i, 'basedOn.url must use http or https'),
});
export type CraftbookBasedOn = z.infer<typeof CraftbookBasedOnSchema>;

/**
 * Cross-check step script refs against the embedded scripts map: every
 * `scope: 'craftbook'` ref (onEnter / onExit / gate.scripts) must name a
 * key in `scripts` when the map is present. Books WITHOUT a map are
 * skipped entirely — legacy bundled/local books resolve craftbook-scope
 * refs from the project-installed copy instead. Returns human-readable
 * problems (empty = valid), mirroring {@link validateCraftbookGraph}.
 */
export function validateCraftbookScriptRefs(cb: {
  steps: CraftbookStep[];
  scripts?: Record<string, string>;
}): string[] {
  if (!cb.scripts) return [];
  const problems: string[] = [];
  const names = new Set(Object.keys(cb.scripts));
  const check = (stepId: string, where: string, refs: { name: string; scope?: string }[]) => {
    for (const ref of refs) {
      if ((ref.scope ?? 'project') === 'craftbook' && !names.has(ref.name)) {
        problems.push(
          `step "${stepId}" ${where} references craftbook script "${ref.name}" which is not in the scripts map${names.size > 0 ? ` (available: ${[...names].join(', ')})` : ''}`,
        );
      }
    }
  };
  for (const s of cb.steps) {
    check(s.id, 'onEnter', normalizeScriptRefs(s.onEnter));
    check(s.id, 'onExit', normalizeScriptRefs(s.onExit));
    if (s.gate) check(s.id, 'gate', normalizeStepGate(s.gate).scripts);
  }
  return problems;
}

export const CraftbookSchema = z
  .object({
    /** Matches catalog folder name. For ad-hoc embedded craftbooks (inline-steps tasks), a generated id. */
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    /** Semver from the catalog version this craftbook was resolved from. Unset for ad-hoc embedded books. */
    version: z.string().optional(),
    /** Optional credit + link to the upstream work this craftbook adapts. */
    basedOn: CraftbookBasedOnSchema.optional(),
    plan: z.string().optional(),
    defaultAssignee: TaskAssigneeSchema.optional(),
    steps: z.array(CraftbookStepSchema).min(1),
    entryStepId: z.string().min(1),
    /**
     * User-speech phrases that route to this craftbook. Matched
     * case-insensitively as substrings against the user's chat input
     * (or against a slash-command argument). Optional; absent =
     * invocable only via explicit `invoke_craftbook` / Commands panel.
     */
    triggers: z.array(z.string()).optional(),
    /**
     * Pre/PostToolUse hooks installed for the duration the craftbook
     * is active. The MCP bridge consults this list before forwarding
     * a `tools/call`. See `hook.ts` for the decision contract.
     */
    hooks: z.array(HookSpecSchema).optional(),
    /**
     * Optional squisq/JSON-Schema object describing the parameters this
     * craftbook collects before it runs. Its top-level `properties` are
     * the (scalar) params, in declaration order: the command launcher
     * renders them into positional CLI tokens (`code-review <focus>
     * <intensity>`) and squisq's `JsonEditor` renders them as a form.
     * Stored permissively (an arbitrary squisq schema) and read
     * structurally; typed as squisq's `SquisqAnnotatedSchema` at the UI
     * boundary. Absent = parameterless (the command is injected directly).
     */
    paramSchema: z.record(z.string(), z.unknown()).optional(),
    /**
     * CLI token the launcher stages into the terminal and that the
     * terminal recognizes. Defaults to `id` when absent — e.g. the
     * "Code Review" craftbook (id `review`) sets `command: "code-review"`.
     */
    command: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    /**
     * Prerequisites a project must satisfy for this craftbook to be
     * applicable. When unmet, the craftbook is hidden from the launcher
     * and not recognized as a terminal command. Absent = always offered.
     */
    requirements: z.array(CraftbookRequirementSchema).optional(),
    /**
     * Soft "works better with" hints — never gate, only inform UI copy
     * (the craftbook start card's permission nudge). See
     * {@link CraftbookRecommendationSchema}. Carried into the runtime
     * craftbook and the task snapshot, unlike `requirements`.
     */
    recommends: z.array(CraftbookRecommendationSchema).optional(),
    /** Unattended launch modes this recipe is suitable for. */
    runModes: CraftbookRunModesSchema.optional(),
    /**
     * Toolsets (MCP servers / CLIs / APIs) this craftbook depends on. Drives
     * the launcher's install/config affordance and — for entries with
     * `autoAllow` — pre-authorizes those toolsets' tools while the craftbook
     * is active. See {@link CraftbookToolsetNeedSchema}. Unlike
     * `requirements`, this is carried into the runtime craftbook and the task
     * snapshot. Absent = no declared toolset dependencies.
     */
    toolsets: z.array(CraftbookToolsetNeedSchema).optional(),
    /**
     * Project commands this craftbook's `commandEvidence` gates verify runs
     * of. See {@link CraftbookCommandNeedSchema}. Carried into the runtime
     * craftbook and the task snapshot so the kickoff path can raise the
     * first-use approval questions up front.
     */
    commands: z.array(CraftbookCommandNeedSchema).optional(),
    /**
     * Connectors whose mirrored `artifacts/data/` corpus this craftbook reads. The
     * launcher binds and syncs them before the first step runs. See
     * {@link CraftbookConnectorNeedSchema}. Carried into the runtime
     * craftbook and the task snapshot so a running task records what it
     * was launched against. Absent = no connector dependencies.
     */
    connectors: z.array(CraftbookConnectorNeedSchema).optional(),
    /**
     * Embedded script sources (name → TypeScript). See
     * {@link CraftbookScriptsSchema}. Hydrated at resolution time for
     * bundled/local/project books (their sources stay `scripts/*.ts`
     * files on disk) and carried verbatim into the task snapshot, so a
     * running task executes its gates from its own copy.
     */
    scripts: CraftbookScriptsSchema.optional(),
    /**
     * Declarative per-item fanout config. When present, the craftbook is a
     * spawn host: its `spawnFanout` step fans out one child per item in
     * `spawn.overFile`. See {@link CraftbookSpawnSchema}. Carried into the
     * task snapshot so the runtime reads it at fanout time.
     */
    spawn: CraftbookSpawnSchema.optional(),
    /**
     * This craftbook is authored mode-agnostic: it works identically whether
     * a run edits the workspace in place or drafts a diffpack change
     * proposal. Concretely, its workspace deliverables and gates evaluate
     * through the draft overlay, and it carries no mode-specific prose and
     * no `{{diffpack.*}}` tokens — the runtime injects drafting framing and
     * re-roots the write tools. Declaring it lets an invocation opt the run
     * into proposing (`deliveryMode: 'propose'`, or automatically for
     * unattended runs); the mode is a property of the RUN, never of the
     * book. Resolution rule in `TaskManager.create`.
     */
    diffpackCapable: z.boolean().optional(),
    /**
     * Minimum model tier for the WHOLE book: every step floors at least
     * here (per-step `capabilityFloor` still overrides absolutely, and a
     * stricter role floor still wins — see `effectiveCapabilityFloor` in
     * roles/registry.ts). The honest "this recipe needs a medium model"
     * declaration, consumed by per-step routing at dispatch.
     */
    capabilityFloor: ModelTierSchema.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .superRefine(refineCraftbook);
export type Craftbook = z.infer<typeof CraftbookSchema>;

/* ──────────────────────────── Request shapes ────────────────────────── */

/**
 * The CLASS of artifact a step produces — the single enum shared by the
 * `deliverable` blueprint field, the `set_step_deliverable` MCP tool, and
 * the kind→gate mapping in `deliverable.ts` (which lives outside the
 * schemas layer; the enum is here so it can't create an import cycle).
 */
export const DeliverableKindSchema = z.enum([
  'html-game',
  'html-multiscreen-game',
  'html-page',
  'html-marketing-site',
  'markdown-doc',
  'markdown-report',
  'markdown-notes',
  'json',
  'yaml-spec',
  'code-module',
  'code-with-tests',
  'security-report',
  'image-set',
  'audio-file',
  'slide-deck',
  'data-file',
  'generic-file',
]);

/**
 * Authoring sugar on a step blueprint: "this step produces file X of
 * class Y". Expanded at resolution time (`expandStepDeliverables` in
 * `deliverable.ts`) into the class-appropriate `advanceWhen` + completion
 * `gate` pair — the persisted step carries only the expansion, so the
 * runtime never sees this field. An explicitly-authored `gate` /
 * `advanceWhen` on the same blueprint WINS over the corresponding
 * expanded field (author intent beats sugar).
 */
export const StepDeliverableSchema = z.object({
  /** Workspace-relative file the step must produce. The only required field. */
  path: z.string().min(1),
  /** Artifact class; inferred from the file extension when absent. */
  kind: DeliverableKindSchema.optional(),
  /** Override the class-default byte floor. */
  minBytes: z.number().int().positive().optional(),
  /** Gate rejections before the task pauses for help. */
  maxAttempts: z.number().int().positive().optional(),
  /** Gate the artifacts drawer instead of the workspace. */
  artifact: z.boolean().optional(),
  /**
   * The deliverable is an EDIT to a pre-existing file (fix/refactor):
   * presence alone never advances the step — the assignee must have
   * written to the file this turn. See {@link AdvanceWhenSchema}.
   */
  requireChange: z.boolean().optional(),
  /**
   * For code deliverables: additionally execute the file in the sandbox
   * and require exit 0 (a `node:test`/`assert` file exits nonzero on
   * failure — exactly the contract). Opt-in.
   */
  execute: z.boolean().optional(),
  /** For data deliverables: required column names (adds a tableShape check). */
  columns: z.array(z.string().min(1)).min(1).optional(),
  /** For data deliverables: minimum row count (adds a tableShape check). */
  minRows: z.number().int().positive().optional(),
});
export type StepDeliverable = z.infer<typeof StepDeliverableSchema>;

/**
 * Step blueprint for create/update requests. `id` is optional — a slug is
 * derived from `name` when omitted.
 */
export const NewCraftbookStepSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().optional(),
  suggestedGezelId: z.string().optional(),
  /** See {@link CraftbookStepSchema.shape.suggestedRole}. */
  suggestedRole: z.string().optional(),
  /** See {@link CraftbookStepSchema.shape.capabilityFloor}. */
  capabilityFloor: ModelTierSchema.optional(),
  /** See {@link CraftbookStepSchema.shape.retrieval}. */
  retrieval: RetrievalPolicySchema.optional(),
  /** See {@link CraftbookStepSchema.shape.toolPolicy}. */
  toolPolicy: CraftbookStepToolPolicySchema.optional(),
  assignee: TaskAssigneeSchema.optional(),
  onEnter: ScriptRefListSchema.optional(),
  onExit: ScriptRefListSchema.optional(),
  consumes: z
    .array(CraftbookStepInputSchema)
    .min(1)
    .optional()
    .describe(
      'Files this step must open before working. Artifact inputs also require an explicit `read_artifact` call in the step prompt.',
    ),
  advanceWhen: AdvanceWhenSchema.optional(),
  gate: StepGateUnionSchema.optional(),
  /** See {@link StepDeliverableSchema} — one field attaches the enforced gate. */
  deliverable: StepDeliverableSchema.optional(),
  next: z.string().optional(),
  branches: z.array(CraftbookBranchSchema).optional(),
  terminal: z.boolean().optional(),
  /** See {@link CraftbookStepSchema.shape.spawnFanout}. */
  spawnFanout: z.boolean().optional(),
});
export type NewCraftbookStep = z.infer<typeof NewCraftbookStepSchema>;

/**
 * Create a new local-source craftbook template. The service writes it
 * under `~/.gezel/craftbook-templates/{prefix}/{id}/` mirroring the
 * bundled catalog layout.
 */
export const CreateCraftbookRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  basedOn: CraftbookBasedOnSchema.optional(),
  plan: z.string().optional(),
  defaultAssignee: TaskAssigneeSchema.optional(),
  steps: z.array(NewCraftbookStepSchema).min(1),
  entryStepId: z.string().optional(),
  paramSchema: z.record(z.string(), z.unknown()).optional(),
  command: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  requirements: z.array(CraftbookRequirementSchema).optional(),
  recommends: z.array(CraftbookRecommendationSchema).optional(),
  runModes: CraftbookRunModesSchema.optional(),
  toolsets: z.array(CraftbookToolsetNeedSchema).optional(),
  scripts: CraftbookScriptsSchema.optional(),
});
export type CreateCraftbookRequest = z.infer<typeof CreateCraftbookRequestSchema>;

export const UpdateCraftbookRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  basedOn: CraftbookBasedOnSchema.nullable().optional(),
  plan: z.string().nullable().optional(),
  defaultAssignee: TaskAssigneeSchema.nullable().optional(),
  steps: z.array(NewCraftbookStepSchema).min(1).optional(),
  entryStepId: z.string().optional(),
  paramSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  command: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .nullable()
    .optional(),
  requirements: z.array(CraftbookRequirementSchema).nullable().optional(),
  recommends: z.array(CraftbookRecommendationSchema).nullable().optional(),
  runModes: CraftbookRunModesSchema.nullable().optional(),
  toolsets: z.array(CraftbookToolsetNeedSchema).nullable().optional(),
  /** Full-replace semantics: the map is the truth. `null` clears all scripts. */
  scripts: CraftbookScriptsSchema.nullable().optional(),
});
export type UpdateCraftbookRequest = z.infer<typeof UpdateCraftbookRequestSchema>;

/* ─────────────────────────── List/get responses ─────────────────────── */

/**
 * Lightweight summary returned by `list_craftbooks`. Steps and prompts are
 * not loaded; the `stepCount` lets the UI/picker show the recipe's shape
 * without paying for the full hydration.
 */
export const CraftbookSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  basedOn: CraftbookBasedOnSchema.optional(),
  /**
   * Where the craftbook came from. `bundled` — shipped catalog;
   * `local` — user-authored under `~/.gezel/craftbook-templates/`;
   * `project` — project-local, defined in a workspace `.gezel/craftbooks/`
   * folder (often auto-imported from a `.claude/skills` / `agents/skills`
   * SKILL.md). Project craftbooks only surface inside their own project.
   */
  source: z.enum(['bundled', 'local', 'project']),
  stepCount: z.number().int().nonnegative(),
});
export type CraftbookSummary = z.infer<typeof CraftbookSummarySchema>;

export const ListCraftbooksResponseSchema = z.object({
  craftbooks: z.array(CraftbookSummarySchema),
});
export type ListCraftbooksResponse = z.infer<typeof ListCraftbooksResponseSchema>;

/**
 * Sidecar record for a project-local craftbook that a project type
 * installed (workspace `.gezel/craftbooks/<id>/provenance.json`). The
 * install is a COPY the user may freely edit; this sidecar is what lets
 * re-apply distinguish "unchanged — skip" from "user-modified — leave
 * alone" (contentHash covers the recipe fields, not timestamps), and
 * lets the launcher mark type-installed books as suggested.
 */
export const ProjectCraftbookProvenanceSchema = z.object({
  installedBy: z.literal('project-type'),
  typeId: z.string(),
  typeVersion: z.string(),
  bookVersion: z.string(),
  /** sha256 over the installed book's canonical recipe JSON. */
  contentHash: z.string(),
  installedAt: z.string(),
});
export type ProjectCraftbookProvenance = z.infer<typeof ProjectCraftbookProvenanceSchema>;

/**
 * A ranked craftbook suggestion — one row of the top-K shortlist
 * `suggest_craftbook` returns for a free-text task description. Extends the
 * summary fields with the relevance breakdown: `score` is the blended
 * 0..1 rank, `semantic` the embedding cosine (absent when the local
 * embedding pipeline is unavailable and ranking fell back to lexical),
 * `lexical` the token/alias-overlap score. `tags`/`triggers` are present
 * for bundled books.
 */
export const CraftbookSuggestionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: z.enum(['bundled', 'local', 'project']),
  version: z.string().optional(),
  basedOn: CraftbookBasedOnSchema.optional(),
  stepCount: z.number().int().nonnegative(),
  tags: z.array(z.string()).optional(),
  triggers: z.array(z.string()).optional(),
  score: z.number(),
  semantic: z.number().optional(),
  lexical: z.number(),
});
export type CraftbookSuggestion = z.infer<typeof CraftbookSuggestionSchema>;

export const SuggestCraftbooksResponseSchema = z.object({
  suggestions: z.array(CraftbookSuggestionSchema),
});
export type SuggestCraftbooksResponse = z.infer<typeof SuggestCraftbooksResponseSchema>;

export const CraftbookResponseSchema = z.object({
  craftbook: CraftbookSchema,
});
export type CraftbookResponse = z.infer<typeof CraftbookResponseSchema>;

/* ──────────────────────────── Helpers ───────────────────────────────── */

/**
 * Slug helper used when minting step ids from a step's name. Lowercase
 * alphanumeric + hyphens, collapsed; mirrors the gezel-side slugifier.
 */
export function slugifyStepId(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'step'
  );
}

/* ───────────────────── Shared step-editing core ──────────────────────── */
/*
 * Pure, side-effect-free operations over a craftbook's step array. The
 * single source of truth for authoring/editing BOTH a task's embedded
 * craftbook (`task.craftbook`) and a standalone template. The TaskManager
 * and the craftbooks route are thin adapters: they map request → step,
 * call these, run `validateCraftbookGraph`, then persist + log.
 */

/**
 * Disambiguate step ids from blueprint input — mint a slug from each
 * step's name when `id` is absent, and de-dupe collisions with a numeric
 * suffix. Previously duplicated in `routes/craftbooks.ts` and
 * `TaskManager.inlineStepsToCraftbook`; now the one canonical impl.
 */
export function resolveSteps(blueprints: NewCraftbookStep[]): CraftbookStep[] {
  const ids = new Set<string>();
  return blueprints.map((s) => {
    let id = s.id && s.id.length > 0 ? s.id : slugifyStepId(s.name);
    let suffix = 2;
    const base = id;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    ids.add(id);
    return {
      id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      ...(s.prompt ? { prompt: s.prompt } : {}),
      ...(s.suggestedGezelId ? { suggestedGezelId: s.suggestedGezelId } : {}),
      ...(s.suggestedRole ? { suggestedRole: s.suggestedRole } : {}),
      ...(s.capabilityFloor ? { capabilityFloor: s.capabilityFloor } : {}),
      ...(s.retrieval ? { retrieval: s.retrieval } : {}),
      ...(s.toolPolicy ? { toolPolicy: s.toolPolicy } : {}),
      ...(s.assignee ? { assignee: s.assignee } : {}),
      ...(s.onEnter ? { onEnter: s.onEnter } : {}),
      ...(s.onExit ? { onExit: s.onExit } : {}),
      ...(s.consumes && s.consumes.length > 0 ? { consumes: s.consumes } : {}),
      ...(s.advanceWhen ? { advanceWhen: s.advanceWhen } : {}),
      ...(s.gate ? { gate: s.gate } : {}),
      ...(s.next ? { next: s.next } : {}),
      ...(s.branches && s.branches.length > 0 ? { branches: s.branches } : {}),
      ...(s.terminal ? { terminal: s.terminal } : {}),
      ...(s.spawnFanout ? { spawnFanout: s.spawnFanout } : {}),
    };
  });
}

/** Position hint for inserting a step relative to existing ones. */
export const StepPositionSchema = z.object({
  /** Insert immediately after the step with this id. */
  after: z.string().optional(),
  /** Insert immediately before the step with this id. */
  before: z.string().optional(),
  /** Absolute insertion index (clamped to [0, length]). */
  index: z.number().int().nonnegative().optional(),
});
export type StepPosition = z.infer<typeof StepPositionSchema>;

/** Compute the array index at which to insert, given a position hint (default: append). */
export function stepInsertionIndex(steps: { id: string }[], pos?: StepPosition): number {
  if (!pos) return steps.length;
  if (typeof pos.index === 'number') return Math.max(0, Math.min(steps.length, pos.index));
  if (pos.after) {
    const i = steps.findIndex((s) => s.id === pos.after);
    if (i >= 0) return i + 1;
  }
  if (pos.before) {
    const i = steps.findIndex((s) => s.id === pos.before);
    if (i >= 0) return i;
  }
  return steps.length;
}

/**
 * Mint a unique step id for a new step within an existing array (slug from
 * `name`, or a supplied `id`, de-duped with a numeric suffix).
 */
export function uniqueStepId(existing: { id: string }[], name: string, preferred?: string): string {
  const taken = new Set(existing.map((s) => s.id));
  let id = preferred && preferred.length > 0 ? preferred : slugifyStepId(name);
  const base = id;
  let suffix = 2;
  while (taken.has(id)) id = `${base}-${suffix++}`;
  return id;
}

/** Reorder steps to match `order` (a permutation of the existing ids). Throws on mismatch. */
export function reorderStepsArray<T extends { id: string }>(steps: T[], order: string[]): T[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  if (order.length !== steps.length) {
    throw new Error(`reorder must list all ${steps.length} step ids (got ${order.length})`);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const s = byId.get(id);
    if (!s) throw new Error(`reorder references unknown step id "${id}"`);
    if (seen.has(id)) throw new Error(`reorder lists step id "${id}" twice`);
    seen.add(id);
    out.push(s);
  }
  return out;
}

/**
 * Strip any edge on `step` that points at `removedId` so removing a step
 * never leaves a dangling `next`/`branches[].goto`/`gate` route/
 * `advanceWhen.goto`. Returns a new step.
 */
function cleanStepEdges<T extends CraftbookStep>(step: T, removedId: string): T {
  const next = { ...step };
  if (next.next === removedId) delete next.next;
  if (next.branches) {
    const kept = next.branches.filter((b) => b.goto !== removedId);
    if (kept.length > 0) next.branches = kept;
    else delete next.branches;
  }
  if (next.advanceWhen?.goto === removedId) {
    next.advanceWhen = { ...next.advanceWhen };
    delete next.advanceWhen.goto;
  }
  if (next.gate && gateEdgeTargets(next.gate).includes(removedId)) {
    const gate = { ...next.gate };
    if (isLegacyGateSpec(gate)) {
      if (gate.onFail === removedId) delete gate.onFail;
      if (gate.onPass === removedId) delete gate.onPass;
    } else {
      if (gate.onReject === removedId) delete gate.onReject;
      if (gate.onApprove === removedId) delete gate.onApprove;
    }
    next.gate = gate;
  }
  return next;
}

/**
 * Remove the step with `stepId` and clean any edges that pointed to it.
 * Throws if the id is absent or it's the last remaining step. Returns the
 * new step array; the caller repoints `entryStepId`/`activeStepId` + persists.
 */
export function removeStepAndCleanEdges<T extends CraftbookStep>(steps: T[], stepId: string): T[] {
  if (!steps.some((s) => s.id === stepId)) throw new Error(`step "${stepId}" not found`);
  const remaining = steps.filter((s) => s.id !== stepId);
  if (remaining.length === 0) throw new Error('cannot remove the last step of a craftbook');
  return remaining.map((s) => cleanStepEdges(s, stepId));
}

/**
 * The mutable-field patch applied to one step. Field set mirrors
 * `UpdateTaskStepRequest` exactly: `undefined` leaves a field untouched;
 * `null` (on the nullable fields) clears it; `''` clears the string fields.
 */
export interface StepPatch {
  name?: string;
  description?: string;
  prompt?: string;
  suggestedRole?: string | null;
  capabilityFloor?: ModelTier | null;
  retrieval?: RetrievalPolicy | null;
  assignee?: TaskAssignee | null;
  suggestedGezelId?: string | null;
  onEnter?: ScriptRefList | null;
  onExit?: ScriptRefList | null;
  consumes?: CraftbookStepInput[] | null;
  advanceWhen?: AdvanceWhen | null;
  gate?: StepGateUnion | null;
  next?: string | null;
  branches?: CraftbookBranch[] | null;
  terminal?: boolean;
}

/**
 * Apply a {@link StepPatch} to a step, returning a new step. The single
 * source of truth for step-field merge semantics — used by both the task
 * adapter (`TaskManager.updateStep`, preserving lifecycle fields via the
 * generic) and the standalone-template path. Does NOT validate the graph;
 * the caller runs {@link validateCraftbookGraph} after splicing the result
 * back in (edits to `next`/`branches`/`gate`/`terminal` can break edges).
 */
export function applyStepPatch<T extends CraftbookStep>(step: T, patch: StepPatch): T {
  const updated: T = { ...step };
  if (patch.name !== undefined) updated.name = patch.name;
  if (patch.description !== undefined) {
    if (patch.description === '') delete updated.description;
    else updated.description = patch.description;
  }
  if (patch.prompt !== undefined) {
    if (patch.prompt === '') delete updated.prompt;
    else updated.prompt = patch.prompt;
  }
  if (patch.suggestedRole !== undefined) {
    if (patch.suggestedRole === null || patch.suggestedRole === '') delete updated.suggestedRole;
    else updated.suggestedRole = patch.suggestedRole;
  }
  if (patch.capabilityFloor !== undefined) {
    if (patch.capabilityFloor === null) delete updated.capabilityFloor;
    else updated.capabilityFloor = patch.capabilityFloor;
  }
  if (patch.retrieval !== undefined) {
    if (patch.retrieval === null) delete updated.retrieval;
    else updated.retrieval = patch.retrieval;
  }
  if (patch.assignee !== undefined) {
    if (patch.assignee === null) delete updated.assignee;
    else updated.assignee = patch.assignee;
  }
  if (patch.suggestedGezelId !== undefined) {
    if (patch.suggestedGezelId === null) delete updated.suggestedGezelId;
    else updated.suggestedGezelId = patch.suggestedGezelId;
  }
  if (patch.onEnter !== undefined) {
    if (patch.onEnter === null || (Array.isArray(patch.onEnter) && patch.onEnter.length === 0)) {
      delete updated.onEnter;
    } else updated.onEnter = patch.onEnter;
  }
  if (patch.onExit !== undefined) {
    if (patch.onExit === null || (Array.isArray(patch.onExit) && patch.onExit.length === 0)) {
      delete updated.onExit;
    } else updated.onExit = patch.onExit;
  }
  if (patch.consumes !== undefined) {
    if (patch.consumes === null || patch.consumes.length === 0) delete updated.consumes;
    else updated.consumes = patch.consumes;
  }
  if (patch.advanceWhen !== undefined) {
    if (patch.advanceWhen === null) delete updated.advanceWhen;
    else updated.advanceWhen = patch.advanceWhen;
  }
  if (patch.gate !== undefined) {
    if (patch.gate === null) delete updated.gate;
    else updated.gate = patch.gate;
  }
  if (patch.next !== undefined) {
    if (patch.next === null || patch.next === '') delete updated.next;
    else updated.next = patch.next;
  }
  if (patch.branches !== undefined) {
    if (patch.branches === null || patch.branches.length === 0) delete updated.branches;
    else updated.branches = patch.branches;
  }
  if (patch.terminal !== undefined) {
    if (patch.terminal) updated.terminal = true;
    else delete updated.terminal;
  }
  return updated;
}
