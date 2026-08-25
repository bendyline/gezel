import { z } from 'zod';
import { ScriptScopeSchema } from './script.js';

/**
 * ─ Step gates ────────────────────────────────────────────────────────
 *
 * A gate is the real end-of-step decision: it judges whether the work a
 * step claims to have finished is actually acceptable, and routes the
 * task accordingly. Two generations coexist:
 *
 *  - `GateSpec` (legacy): declarative filesystem checks evaluated when a
 *    dedicated evaluator step ACTIVATES (the `phase → phase--gate` shape
 *    the generated gallery used). Still parsed, still runs — persisted
 *    tasks embed craftbook snapshots, so this shape never breaks.
 *  - `StepGate` (current): attached to the WORKING step itself, fired as
 *    a guard on step COMPLETION (or, with `at: 'activation'`, in the old
 *    moment). Combines a cheap declarative `checks` floor with ordered,
 *    parameterized gate `scripts` that return a structured
 *    {@link GateScriptResult}.
 *
 * Relationship to the other step machinery: `advanceWhen` stays the cheap
 * per-turn "is the deliverable there yet" trigger; the gate is the
 * authoritative judgment at completion; `onExit` is cleanup only (the
 * `finally` of the step) and runs after the gate approves.
 */

/**
 * Named content sniffs shared by advanceWhen + gate checks.
 *
 * `data-table` is the data-class floor: the file parses as a non-empty JSON
 * array, a comma-delimited table (header + ≥1 row), or a Markdown table —
 * i.e. it's plausibly the produced data OUTPUT, not an empty file or the
 * transform script. Authored to the data/ETL class, not any one schema.
 */
export const StepSniffSchema = z.enum([
  'html-complete',
  'html-game',
  'nonempty',
  'json-valid',
  'data-table',
]);
export type StepSniff = z.infer<typeof StepSniffSchema>;

const GateJsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A single objective, runtime-evaluable acceptance check for a craftbook
 * gate. Deliberately filesystem-facts only (sizes, counts, content sniffs)
 * — no LLM judgment, no Playwright. This is the "ironclad floor": a gate
 * built from these can never PASS junk, only fail-and-loop or escalate.
 * Evaluated in-process — zero sandbox spawns — so a gate should keep a
 * cheap `checks` floor even when it also carries scripts.
 */
export const GateCheckSchema = z.discriminatedUnion('kind', [
  /** A single file is at least `bytes` long (workspace, or the artifacts drawer when `artifact`). */
  z.object({
    kind: z.literal('minBytes'),
    file: z.string().min(1),
    bytes: z.number().int().positive(),
    artifact: z.boolean().optional(),
  }),
  /** The summed size of several files clears `bytes` (e.g. index.html + game.js ≥ 5 KB). */
  z.object({
    kind: z.literal('totalMinBytes'),
    files: z.array(z.string().min(1)).min(1),
    bytes: z.number().int().positive(),
    artifact: z.boolean().optional(),
  }),
  /**
   * At least `min` workspace files with one of `ext` exist (e.g. ≥3 images).
   * `verifyImageBytes` additionally requires each raster candidate
   * (png/jpg/jpeg/gif/webp) to carry real image bytes — magic signature
   * plus a 1 KiB floor — so a text placeholder named `panel-1.png` stops
   * counting. Set it on any gate whose deliverable is an actual rendered
   * image; leave it off for listings that legitimately include vector or
   * stub assets. The check fails loudly rather than degrading when the
   * evaluating surface cannot read bytes.
   */
  z.object({
    kind: z.literal('fileCount'),
    ext: z.array(z.string().min(1)).min(1),
    min: z.number().int().positive(),
    dir: z.string().optional(),
    verifyImageBytes: z.boolean().optional(),
    artifact: z.boolean().optional(),
  }),
  /** Inline `<style>` + linked `.css` in `file` (default index.html) clears `bytes`. */
  z.object({
    kind: z.literal('cssMinBytes'),
    bytes: z.number().int().positive(),
    file: z.string().optional(),
    artifact: z.boolean().optional(),
  }),
  /** A named content sniff passes on `file` (workspace, or the artifacts drawer when `artifact`). */
  z.object({
    kind: z.literal('sniff'),
    file: z.string().min(1),
    sniff: StepSniffSchema,
    artifact: z.boolean().optional(),
  }),
  /** A JSON scalar at `path` equals the expected value. Path supports dot keys and numeric array indexes. */
  z.object({
    kind: z.literal('jsonPathEquals'),
    file: z.string().min(1),
    path: z.string().min(1),
    value: GateJsonScalarSchema,
    label: z.string().min(1).optional(),
    artifact: z.boolean().optional(),
  }),
  /** A CSV file has the expected header/row shape and optional picklist values. */
  z.object({
    kind: z.literal('csvShape'),
    file: z.string().min(1),
    requiredColumns: z.array(z.string().min(1)).min(1).optional(),
    exactColumns: z.array(z.string().min(1)).min(1).optional(),
    minRows: z.number().int().nonnegative().optional(),
    consistentColumns: z.boolean().optional(),
    allowedValues: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
    artifact: z.boolean().optional(),
  }),
  /** `file` matches `pattern` (regex), in the workspace or the artifacts drawer when `artifact`. */
  z.object({
    kind: z.literal('contains'),
    file: z.string().min(1),
    pattern: z.string().min(1),
    flags: z.string().optional(),
    label: z.string().min(1).optional(),
    artifact: z.boolean().optional(),
  }),
  /** `file` must NOT match `pattern` (regex), in the workspace or artifacts drawer. */
  z.object({
    kind: z.literal('notContains'),
    file: z.string().min(1),
    pattern: z.string().min(1),
    flags: z.string().optional(),
    label: z.string().min(1).optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * `file` may use high-risk claim wording only when the exact matched
   * phrase appears in `sourceFiles`. This catches overclaim/tone drift in
   * factual prose without requiring an LLM judge.
   */
  z.object({
    kind: z.literal('unsupportedClaims'),
    file: z.string().min(1),
    sourceFiles: z.array(z.string().min(1)).min(1),
    patterns: z
      .array(
        z.object({
          pattern: z.string().min(1),
          label: z.string().min(1).optional(),
        }),
      )
      .min(1),
    flags: z.string().optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * Every inline `<script>` body in `file` (default index.html) parses as
   * JavaScript. The "ships broken JS" floor for the single-file-web class:
   * a page whose inline script has a syntax error never runs in a browser,
   * so the gate loops the builder back with the parse error. Files with no
   * inline JS pass (nothing to judge); `type="module"` scripts are size-only
   * (top-level import can't be function-parsed) and pass here.
   */
  z.object({
    kind: z.literal('jsParses'),
    file: z.string().optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * An in-process, zero-spawn static gate for an HTML deliverable: the document
   * shell closes, static DOM ids are unique, every inline classic/module
   * script parses, and top-level function declarations do not silently
   * replace one another. Unlike a live browser check, this runs in-process
   * in locked-down modes and is safe to attach to every HTML deliverable.
   */
  z.object({
    kind: z.literal('htmlLint'),
    file: z.string().min(1),
    artifact: z.boolean().optional(),
  }),
  /**
   * Named `node:` imports in `file` resolve to real builtin exports, and a
   * `.mjs` file doesn't call `require()`. The "ships broken module imports"
   * floor for the code class: a name imported from the wrong builtin (e.g.
   * `dirname` from `node:url`) or a `require()` in ESM throws at LOAD and
   * nothing runs — and `jsParses` can't catch it (it skips `type="module"`
   * and never sees a standalone `.mjs`/`.ts`). Files with no `node:` named
   * imports pass.
   */
  z.object({
    kind: z.literal('esmImports'),
    file: z.string().min(1),
    artifact: z.boolean().optional(),
  }),
  /**
   * `file` parses as source code. For `.ts/.tsx/.js/.mjs/.cjs/.jsx` the
   * service runs a syntax-only TypeScript transpile (milliseconds, zero
   * spawns) and the failure message carries the first diagnostic with
   * line:column; `.html` delegates to the inline-`jsParses` path. The
   * code-class floor that catches truncated/unbalanced files a
   * `minBytes`-only gate happily waves through.
   */
  z.object({
    kind: z.literal('sourceParses'),
    file: z.string().min(1),
    artifact: z.boolean().optional(),
  }),
  /**
   * The first Markdown table in `file` has the required header set and
   * row floor. (CSV/JSON record data uses `csvShape`/`recordSchema`.)
   */
  z.object({
    kind: z.literal('tableShape'),
    file: z.string().min(1),
    requiredColumns: z.array(z.string().min(1)).min(1).optional(),
    minRows: z.number().int().nonnegative().optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * A JSON array (or CSV) of records in `file` conforms to a declared
   * field schema — the ETL schema-conformance floor. Field `type` is a
   * built-in cell type (`string`/`nonempty`/`number`/`integer`/`boolean`/
   * `date`/`iso-date`/`email`) or a regex source.
   */
  z.object({
    kind: z.literal('recordSchema'),
    file: z.string().min(1),
    fields: z
      .array(
        z.object({
          name: z.string().min(1),
          type: z.string().optional(),
          required: z.boolean().optional(),
        }),
      )
      .min(1),
    minRows: z.number().int().nonnegative().optional(),
    uniqueBy: z.string().optional(),
    format: z.enum(['json', 'csv', 'auto']).optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * Execute `file` in the sandbox and require exit code 0. The ONE
   * spawning check — evaluated service-side through an injected executor
   * (absent executor = fail-closed reject) and gated behind the same
   * `allowScriptExecution` security policy as user scripts. Only
   * dependency-free files can run (node built-ins ok; the sandbox has no
   * npm tree): a `node:test`/`assert` file exits nonzero on failure,
   * which is exactly the contract.
   *
   * Alone among the file-reading checks this takes no `artifact` flag: it
   * does not read through the swappable gate reader at all, it hands the
   * path to the sandbox executor, which resolves against the workspace.
   * Accepting the flag would parse fine and then silently execute the
   * wrong tree — the exact failure mode the flag exists to prevent.
   */
  z.object({
    kind: z.literal('nodeRuns'),
    file: z.string().min(1),
    /** Wall-clock budget. Default 20s, cap 60s. */
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  }),
  /**
   * Every source `file` cites must exist — the anti-fabrication floor for
   * research/review deliverables (a cited path that resolves is the
   * difference between grounded work and an invented bibliography).
   * File-path citations resolve against the workspace listing; URLs pass
   * unless `corpus` is given, in which case cited paths AND URLs must be
   * corpus members. Optional `minCitations` floors the citation count.
   */
  z.object({
    kind: z.literal('citationsResolve'),
    file: z.string().min(1),
    pattern: z.string().min(1).optional(),
    flags: z.string().optional(),
    minCitations: z.number().int().nonnegative().optional(),
    corpus: z.array(z.string().min(1)).min(1).optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * Require observable source acquisition during this activation. When
   * `sourcePath` is non-empty, an exact successful `read_file` of that path
   * qualifies; otherwise one of `tools` must have completed against an
   * external source. The runtime supplies the live tool-call evidence.
   * `externalOptional` softens only the no-sourcePath branch: authored local
   * sources remain mandatory, while a topic-only workflow may recommend web
   * research without becoming impossible under an offline security policy.
   */
  z.object({
    kind: z.literal('researchEvidence'),
    sourcePath: z.string().optional(),
    tools: z.array(z.string().min(1)).min(1),
    minSuccessful: z.number().int().positive().optional(),
    externalOptional: z.boolean().optional(),
  }),
  /**
   * Require a real command run during this activation, verified against the
   * service-written run receipts (`workspace.script.run` / `workspace.npx.run`
   * history events — the model cannot forge them, and the gate never
   * executes anything itself). Exactly one of `script` (a package.json
   * script name) or `bin` (an npx binary) names the command; `args` must
   * match the receipt's extra args exactly (default: argless). `expect`
   * judges the LATEST matching run's exit code — `'fail'` is the
   * red-before-green half of a repro-first fix (the failing test must
   * actually fail), `'pass'` is the suite-green proof after it. A timed-out
   * run satisfies neither. On a drafting task the project's commands run
   * against the unmodified tree, so `onDraft: 'defer'` (the default)
   * approves with an explicit "execution deferred until Apply" note instead
   * of demanding a receipt that would be a lie; `'require'` hard-blocks
   * instead. Books standardize on the argless canonical invocation because
   * command approvals pin one invocation hash per script name.
   */
  z.object({
    kind: z.literal('commandEvidence'),
    script: z.string().min(1).optional(),
    bin: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    expect: z.enum(['pass', 'fail']),
    minRuns: z.number().int().positive().optional(),
    onDraft: z.enum(['defer', 'require']).optional(),
    label: z.string().min(1).optional(),
  }),
  /**
   * A PR-review coverage ledger must name every changed path materialized in
   * a connector corpus. The ledger is JSON (`reviewedFiles` by default) in
   * the workspace, or in the artifacts drawer when `artifact` — a review of
   * a read-only checkout can only write the drawer, so omitting the flag
   * here made the whole Pull Request Review book unsatisfiable on any
   * writes-off project. The source records always live in the drawer and
   * carry their authoritative path in frontmatter. This prevents a polished
   * report from passing after only the first context-sized prefix was read.
   */
  z.object({
    kind: z.literal('corpusCoverage'),
    file: z.string().min(1),
    corpusDir: z.string().min(1),
    reviewedField: z.string().min(1).optional(),
    recordField: z.string().min(1).optional(),
    artifact: z.boolean().optional(),
    /**
     * JSON array of the exact changed paths THIS ledger must cover, as a
     * string — narrows the check from the whole corpus to one slice of it.
     * Written for declarative fanout: a child reviewing batch 2 of 3 gets
     * `"{{paths}}"` from its per-item context and is gated on its own 25
     * files, not on the 68 nobody handed it. Without this a batch child
     * can never pass its own gate, and coverage can only be enforced
     * after a merge — far downstream of the child that under-delivered.
     *
     * Fails closed on anything that is not a JSON array of strings,
     * including an uninterpolated `{{…}}` token: a mis-scoped coverage
     * check that silently widens back to the full corpus would reject
     * every child forever with a verdict none of them can act on.
     */
    expectPaths: z.string().min(1).optional(),
  }),
  /**
   * A fanout-input batch file must reproduce a connector corpus manifest's own
   * batch array exactly — same count, same ordinals, same paths, in order.
   *
   * The upstream sibling of {@link corpusCoverage}: that check proves the work
   * covered the corpus, this one proves the *plan* did. A batch file is the
   * spawn host's `overFile`, so a batch dropped here is never reviewed by
   * anyone and never appears in any coverage ledger. `json-valid` + `minBytes`
   * cannot see it: a batch array truncated at the model's output cap is still
   * syntactically perfect JSON. Wild-caught on a 509-file PR whose scope step
   * published 10 of 21 batches — 259 files silently out of scope, and the run
   * then deadlocked eight attempts deep in the downstream merge gate, which is
   * the wrong place to learn it and the one place that cannot fix it.
   */
  z.object({
    kind: z.literal('corpusBatches'),
    file: z.string().min(1),
    corpusDir: z.string().min(1),
    /** Filename suffix identifying the manifest inside the corpus. */
    manifestSuffix: z.string().min(1).optional(),
    /** Manifest field holding the authoritative batch array. */
    itemsField: z.string().min(1).optional(),
    /** Manifest field holding the total item count the batches must cover. */
    totalField: z.string().min(1).optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * The H1 slide titles in `file` must match the numbered slide headings in
   * `outlineFile`, one-for-one and in order. This makes a locked Markdown
   * outline mechanically binding instead of relying on a reviewer to notice
   * that slides were merged, dropped, or reordered.
   */
  z.object({
    kind: z.literal('markdownHeadingsMatch'),
    file: z.string().min(1),
    outlineFile: z.string().min(1),
    /** Read outlineFile from artifacts while file uses the check's primary surface. */
    outlineArtifact: z.boolean().optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * Named facts in `file` must come from authorized sources: each fact
   * requires one of its `required` patterns to appear, and its `forbidden`
   * (decoy) patterns must not appear at all. The distractor-grounding
   * floor for research/analysis deliverables, productized from the
   * decoy-research grader.
   */
  z.object({
    kind: z.literal('valueGrounding'),
    file: z.string().min(1),
    facts: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1).optional(),
          required: z.array(z.string().min(1)).min(1),
          forbidden: z.array(z.string().min(1)).optional(),
        }),
      )
      .min(1),
    /** Digit-group normalization ("1,234" ≈ "1234"); defaults on. */
    normalizeDigits: z.boolean().optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * Value-conservation floor for transform/ETL deliverables: every value
   * in `file` matching `pattern` (one capture group) must appear verbatim
   * in at least one `sourceFiles` member (entries may use `*`/`**` globs;
   * the output file itself is always excluded from the sources). Catches
   * renumbered/invented identifiers that pass every shape check — the
   * failure mode that took out 7 of 8 local models on precision ETL in
   * the core sweep.
   */
  z.object({
    kind: z.literal('valuesSubsetOf'),
    file: z.string().min(1),
    sourceFiles: z.array(z.string().min(1)).min(1),
    pattern: z.string().min(1),
    flags: z.string().optional(),
    minMatches: z.number().int().nonnegative().optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * LLM-judge check for unverifiable qualities (tone, faithfulness).
   * FAIL-OPEN by design: when no judge is available (keurmeester
   * unconfigured, timeout, unparseable verdict) the check approves
   * with a "(fail-open)" note — the opposite polarity of `nodeRuns`.
   * ADVISORY by default in v1: a would-reject never holds the step;
   * the opinion rides the approve verdict + gate telemetry until
   * false-reject data justifies flipping `advisory: false`.
   */
  z.object({
    kind: z.literal('judge'),
    file: z.string().min(1),
    /** Imperative rubric: the quality to judge, in one or two sentences. */
    rubric: z.string().min(1),
    /** Context files quoted to the judge alongside the artifact (e.g. a voice guide). */
    sourceFiles: z.array(z.string().min(1)).optional(),
    /** A fail verdict must quote ≥1 verbatim excerpt from the artifact; default true. */
    requireEvidence: z.boolean().optional(),
    /** Default true (v1). False = enforcing: a valid fail verdict rejects the step. */
    advisory: z.boolean().optional(),
    /** Judge one-shot budget. Default 60s, capped at 120s. */
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    label: z.string().min(1).optional(),
    artifact: z.boolean().optional(),
  }),
  /**
   * Structural plan validation on the first Markdown table in `file`:
   * owners on-roster, dependencies resolve/acyclic/earlier-only,
   * checkable done-states. The Planner role's mechanical floor.
   */
  z.object({
    kind: z.literal('planStructure'),
    file: z.string().min(1),
    minRows: z.number().int().positive().optional(),
    /** When given, every Owner cell must be one of these names. */
    ownerRoster: z.array(z.string().min(1)).optional(),
    /** Rows may only depend on EARLIER rows (default true). */
    requireEarlierOnly: z.boolean().optional(),
    /** Minimum length of each Done-when cell (default 12 chars). */
    doneWhenMinChars: z.number().int().positive().optional(),
    artifact: z.boolean().optional(),
  }),
]);
export type GateCheck = z.infer<typeof GateCheckSchema>;

/**
 * The lean verdict shape a judge one-shot must return — deliberately
 * NOT KeurmeesterVerdictSchema (that carries the intervention
 * diagnosis + action ladder; a judge is pass/fail with quotes).
 */
export const JudgeVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  reasons: z.array(z.string().min(1)).max(5),
  /** Verbatim quotes from the artifact backing the verdict. */
  evidence: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/**
 * LEGACY static acceptance gate (evaluator-step shape). When the step
 * activates the RUNTIME evaluates `checks` against the workspace and
 * routes the task WITHOUT a model turn: all pass → `onPass`/`next` (or
 * hand to `reviewer`); any fail → write the gaps to notes + loop to
 * `onFail` (the build step), up to `maxAttempts` times, then escalate.
 * Parsed forever (persisted task snapshots), normalized at runtime via
 * {@link normalizeStepGate}. New craftbooks should use {@link StepGateSchema}.
 */
export const GateSpecSchema = z.object({
  checks: z.array(GateCheckSchema).min(1),
  /** Step to activate when a check fails. Defaults to the entry/build step (loop back). */
  onFail: z.string().optional(),
  /** Step to activate when all checks pass. Defaults to `next`. */
  onPass: z.string().optional(),
  /** After this many failed loops, route to a terminal step instead of looping. Default 4. */
  maxAttempts: z.number().int().positive().optional(),
  /** Role to hand to AFTER static checks pass — the dynamic (Playwright) reviewer layer. */
  reviewer: z.string().optional(),
});
export type GateSpec = z.infer<typeof GateSpecSchema>;

/**
 * A gate-attached script reference. Same parameterization as ScriptRef
 * (inputs validated against the script's `meta.inputs`), minus the
 * auto-advance predicates — a gate's routing comes from its structured
 * result, not from output sniffing.
 */
export const GateScriptRefSchema = z.object({
  name: z.string().min(1),
  /** Where the script resolves from. Absent = 'project'. */
  scope: ScriptScopeSchema.optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});
export type GateScriptRef = z.infer<typeof GateScriptRefSchema>;

/**
 * The constrained return contract a gate script stamps via
 * `gezel.output(...)`. Validated at the gate call site regardless of the
 * script's declared `meta.kind` — the result schema IS the contract.
 *
 *  - `approve` → the step may complete (task completes if the step is
 *    terminal/final). `goto` optionally overrides routing (a branch).
 *  - `reject`  → the step does NOT complete. `message` is REQUIRED and
 *    must be prescriptive — it is delivered to the working LLM session
 *    verbatim as the instruction for what to fix. `goto` optionally
 *    re-activates a (usually earlier) step instead of staying put —
 *    this is how craftbooks loop.
 *  - `handoff` → on approve, a payload delivered to the next step: a
 *    note on the step plus injection into the next session's kickoff.
 */
export const GateScriptResultSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    message: z.string().optional(),
    goto: z.string().optional(),
    handoff: z
      .object({
        message: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'reject' && !v.message?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a reject result must carry a message — it is the prescriptive guidance the working session uses to fix the step',
        path: ['message'],
      });
    }
  });
export type GateScriptResult = z.infer<typeof GateScriptResultSchema>;

/**
 * The current gate shape, attached to the working step. `at` is REQUIRED
 * — it doubles as the union discriminator against legacy `GateSpec`
 * (which never carries it): persisted old gates parse through the
 * GateSpec branch, new gates always say when they fire.
 *
 *  - `at: 'completion'` — fires inside `completeStep`, before the step
 *    is marked complete and before `onExit`. Covers every completion
 *    path (model tool call, advanceWhen auto-advance, UI, cascades).
 *  - `at: 'activation'` — the legacy evaluator-step moment: fires when
 *    the step activates, with no model turn.
 */
export const StepGateSchema = z
  .object({
    at: z.enum(['completion', 'activation']),
    /** Cheap in-process floor; evaluated before any script spawns. */
    checks: z.array(GateCheckSchema).optional(),
    /** Ordered gate scripts; first reject short-circuits. */
    scripts: z.array(GateScriptRefSchema).optional(),
    /**
     * Step to activate on reject. Absent = stay on this step (the
     * rejection message re-prompts the working session). Set to the
     * step's own id to force a fresh re-activation/handoff per reject —
     * the loop shape that carries small models.
     */
    onReject: z.string().optional(),
    /** Step to activate on approve. Overrides `step.next`; a gate script's `goto` outranks it. */
    onApprove: z.string().optional(),
    /** Rejections before the task pauses for help. Default 4. */
    maxAttempts: z.number().int().positive().optional(),
    /** Legacy Layer-2 reviewer handoff (activation gates only). */
    reviewer: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.checks?.length && !v.scripts?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a gate needs at least one check or one script',
      });
    }
  });
export type StepGate = z.infer<typeof StepGateSchema>;

/**
 * What a step's `gate` field accepts: the current shape or the legacy
 * one. Plain union (not discriminated) — `at` is required on StepGate
 * and absent on GateSpec, so parsing is deterministic.
 */
export const StepGateUnionSchema = z.union([StepGateSchema, GateSpecSchema]);
export type StepGateUnion = z.infer<typeof StepGateUnionSchema>;

export const GATE_DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Ceiling on CONVERGING gate rejections — passes where the same checks
 * failed on strictly fewer outstanding items than the pass before. Those
 * do not spend `maxAttempts` (a bounded batch loop produces one per batch
 * by design, so charging them there caps corpus size instead of
 * stalling), but they are not free either: at 25 records a batch this
 * allows a 600-record corpus, while a loop creeping forward one item at a
 * time still reaches a human within a day's sessions rather than after
 * hundreds. Deliberately not author-configurable — a craftbook that needs
 * more passes than this has a batch-size problem, not a budget problem.
 */
export const GATE_MAX_PROGRESS_ATTEMPTS = 24;

/** Uniform runtime view over both gate generations. */
export interface NormalizedStepGate {
  at: 'completion' | 'activation';
  checks: GateCheck[];
  scripts: GateScriptRef[];
  onReject?: string;
  onApprove?: string;
  maxAttempts: number;
  reviewer?: string;
  /** True when this came from a legacy GateSpec (activation semantics, onFail/onPass naming). */
  legacy: boolean;
}

export function isLegacyGateSpec(gate: StepGateUnion): gate is GateSpec {
  return !('at' in gate);
}

export function normalizeStepGate(gate: StepGateUnion): NormalizedStepGate {
  if (isLegacyGateSpec(gate)) {
    return {
      at: 'activation',
      checks: gate.checks,
      scripts: [],
      ...(gate.onFail !== undefined ? { onReject: gate.onFail } : {}),
      ...(gate.onPass !== undefined ? { onApprove: gate.onPass } : {}),
      maxAttempts: gate.maxAttempts ?? GATE_DEFAULT_MAX_ATTEMPTS,
      ...(gate.reviewer !== undefined ? { reviewer: gate.reviewer } : {}),
      legacy: true,
    };
  }
  return {
    at: gate.at,
    checks: gate.checks ?? [],
    scripts: gate.scripts ?? [],
    ...(gate.onReject !== undefined ? { onReject: gate.onReject } : {}),
    ...(gate.onApprove !== undefined ? { onApprove: gate.onApprove } : {}),
    maxAttempts: gate.maxAttempts ?? GATE_DEFAULT_MAX_ATTEMPTS,
    ...(gate.reviewer !== undefined ? { reviewer: gate.reviewer } : {}),
    legacy: false,
  };
}

/** Edge targets a gate names — for graph validation + step-removal cleanup. */
export function gateEdgeTargets(gate: StepGateUnion): string[] {
  const n = normalizeStepGate(gate);
  return [n.onReject, n.onApprove].filter((t): t is string => t !== undefined);
}
