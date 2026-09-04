import { randomUUID } from 'node:crypto';
import {
  type Craftbook,
  type CraftbookConnectorNeed,
  type CraftbookStep,
  type CraftbookToolsetNeed,
  type NewCraftbookStep,
  type Task,
  type TaskAssignee,
  type TaskCraftbook,
  type TaskCraftbookStep,
  expandStepDeliverables,
  nowIso,
} from '@bendyline/gezel';

/**
 * Instantiating a craftbook into a task: snapshotting the catalog book into
 * the task's own embedded copy, resolving its launch parameters, and
 * substituting `{{token}}` context through the resulting steps.
 *
 * Split out of `manager.ts` verbatim — the substitution rules here are
 * load-bearing (see each function's notes) and belong together.
 */

/**
 * Produce a TaskCraftbook from a runtime Craftbook by stamping
 * `createdAt` on every step. Used both when resolving from the catalog
 * (the embedded copy gets fresh per-instance lifecycle fields) and when
 * cloning a parent's spawn craftbook into a child.
 */
export function snapshotCraftbookForTask(book: Craftbook, now: string): TaskCraftbook {
  return {
    id: book.id,
    name: book.name,
    ...(book.description ? { description: book.description } : {}),
    ...(book.version ? { version: book.version } : {}),
    ...(book.basedOn ? { basedOn: book.basedOn } : {}),
    ...(book.plan ? { plan: book.plan } : {}),
    ...(book.defaultAssignee ? { defaultAssignee: book.defaultAssignee } : {}),
    steps: book.steps.map(
      (s): TaskCraftbookStep => ({
        ...s,
        createdAt: now,
      }),
    ),
    entryStepId: book.entryStepId,
    // Snapshot triggers + hooks too so ChatManager's bridge-side hook
    // installer (which reads `task.craftbook.hooks`) sees them. Without
    // this the catalog resolver's propagation is silently dropped at
    // snapshot time and any craftbook that ships a `hooks` block (e.g.
    // community books declaring a `PreToolUse` destructive-command
    // guard) silently fails to install its hooks.
    ...(book.triggers ? { triggers: book.triggers } : {}),
    ...(book.hooks ? { hooks: book.hooks } : {}),
    ...(book.paramSchema ? { paramSchema: book.paramSchema } : {}),
    // Snapshot toolsets so ChatManager can derive the auto-allow tool set
    // from `task.craftbook.toolsets` without re-resolving the catalog book.
    ...(book.toolsets ? { toolsets: book.toolsets } : {}),
    // Snapshot recommendation hints so the chat's craftbook start card can
    // read them off the tool result's task without a catalog lookup.
    ...(book.recommends ? { recommends: book.recommends } : {}),
    // Snapshot connector needs so a running task records the corpus it was
    // launched against without re-resolving the catalog book.
    ...(book.connectors ? { connectors: book.connectors } : {}),
    // Snapshot command needs so the kickoff hook can raise their first-use
    // approval questions from the task record alone.
    ...(book.commands ? { commands: book.commands } : {}),
    // Snapshot embedded script sources so the task's gate/lifecycle
    // scripts execute from its own copy (scope 'craftbook' refs resolve
    // here first — see runGateScript/runStepScript).
    ...(book.scripts ? { scripts: book.scripts } : {}),
    // Snapshot the declarative per-item fanout config so the runtime reads
    // `task.craftbook.spawn` when the `spawnFanout` step activates.
    ...(book.spawn ? { spawn: book.spawn } : {}),
    // Snapshot the mode-agnostic declaration so the task records that its
    // book allowed drafting (the run's actual mode is `task.diffpackId`).
    ...(book.diffpackCapable ? { diffpackCapable: true } : {}),
    // Snapshot the whole-book floor so dispatch routing reads it from the
    // task record alone (effectiveCapabilityFloor).
    ...(book.capabilityFloor ? { capabilityFloor: book.capabilityFloor } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Read scalar string defaults from a craftbook's permissive JSON schema. */
export function craftbookParamDefaults(
  paramSchema: Craftbook['paramSchema'],
): Record<string, string> {
  const properties = (
    paramSchema && typeof paramSchema.properties === 'object' && paramSchema.properties !== null
      ? paramSchema.properties
      : {}
  ) as Record<string, unknown>;
  const defaults: Record<string, string> = {};
  for (const [key, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== 'object') continue;
    const value = (raw as { default?: unknown }).default;
    if (typeof value === 'string') defaults[key] = value;
  }
  return defaults;
}

/**
 * Enforce the launch-time input constraints craftbooks use to prevent an
 * active worker from receiving an impossible first step. The catalog schema
 * is intentionally permissive JSON Schema, so this focuses on the two
 * declarative constraints task creation can report cleanly: top-level
 * `required`, and `anyOf` branches made from required non-empty strings.
 */
export function assertCraftbookParamRequirements(
  craftbookId: string,
  paramSchema: Craftbook['paramSchema'],
  params: Record<string, string>,
): void {
  if (!paramSchema || typeof paramSchema !== 'object') return;
  const schema = paramSchema as {
    required?: unknown;
    anyOf?: unknown;
  };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(params, key));
  if (missing.length > 0) {
    throw new Error(
      `Craftbook "${craftbookId}" requires invocation parameter${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
    );
  }

  if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) return;
  const alternatives = schema.anyOf.flatMap((rawBranch) => {
    if (!rawBranch || typeof rawBranch !== 'object' || Array.isArray(rawBranch)) return [];
    const branch = rawBranch as { required?: unknown; properties?: unknown };
    if (!Array.isArray(branch.required) || branch.required.length === 0) return [];
    const keys = branch.required.filter((key): key is string => typeof key === 'string');
    if (keys.length !== branch.required.length) return [];
    const properties =
      branch.properties &&
      typeof branch.properties === 'object' &&
      !Array.isArray(branch.properties)
        ? (branch.properties as Record<string, unknown>)
        : {};
    const requirements = keys.map((key) => {
      const property = properties[key];
      const minLength =
        property && typeof property === 'object' && !Array.isArray(property)
          ? (property as { minLength?: unknown }).minLength
          : undefined;
      return { key, minLength: typeof minLength === 'number' ? minLength : 0 };
    });
    // Only enforce branches that explicitly express non-empty string input;
    // other JSON-Schema anyOf uses remain outside this focused validator.
    return requirements.every(({ minLength }) => minLength >= 1) ? [requirements] : [];
  });
  if (alternatives.length !== schema.anyOf.length) return;
  const satisfied = alternatives.some((branch) =>
    branch.every(({ key, minLength }) => (params[key]?.trim().length ?? 0) >= minLength),
  );
  if (satisfied) return;

  const choices = [...new Set(alternatives.flatMap((branch) => branch.map(({ key }) => key)))];
  throw new Error(
    `Craftbook "${craftbookId}" requires at least one non-empty invocation parameter: ${choices.join(', ')}`,
  );
}

/**
 * Resolve placeholders inside declared string defaults against explicit launch
 * params plus the task's reserved runtime context. Only defaults are expanded:
 * user-supplied values can legitimately contain `{{…}}` (inline templates,
 * examples, source text) and must remain byte-for-byte authoritative.
 *
 * Defaults may reference other defaults, so resolve in a small bounded loop.
 * Unknown or cyclic placeholders remain visible and are rejected later if they
 * land in a gate path; they are never silently blanked.
 */
export function resolveCraftbookParamDefaults(
  defaults: Record<string, string>,
  overrides: Record<string, string>,
  runtime: Record<string, string>,
): Record<string, string> {
  let resolved = { ...defaults };
  for (let pass = 0; pass < 8; pass += 1) {
    const context = { ...resolved, ...overrides, ...runtime };
    const next = Object.fromEntries(
      Object.entries(resolved).map(([key, value]) => [key, interpolateContext(value, context)]),
    );
    if (Object.entries(next).every(([key, value]) => resolved[key] === value)) return next;
    resolved = next;
  }
  return resolved;
}

/**
 * Resolve ONLY the reserved runtime tokens (`{{task.dir}}` and its
 * siblings) inside caller-supplied params. Everything else in an override
 * survives byte-for-byte — inline templates, examples, and quoted source
 * text are the caller's data, which is why overrides otherwise skip
 * {@link resolveCraftbookParamDefaults} entirely.
 *
 * That exemption had a hole. A craftbook that declares
 * `workPath: { default: '{{task.dir}}' }` gets that default seeded into
 * the launcher form, rendered straight back out as a staged command token,
 * and parsed as an EXPLICIT override — so the value that was supposed to
 * be resolved by the defaults fixpoint arrives on the side that skips it.
 * `interpolateStepsContext` is single-pass, so the gate's `{{workPath}}`
 * resolved to a literal `{{task.dir}}` and `step-gate.ts` refused to run
 * eight checks no deliverable could satisfy (security-architecture-review
 * 2.0.4, task gezel/7, step `model-system`).
 *
 * Safe where a general re-substitution pass would not be: these four keys
 * are reserved, a caller cannot declare them, and no caller ever means the
 * literal token. Applied before the defaults resolve so the fixpoint sees
 * concrete override values, and before persistence so
 * {@link taskInterpolationContext}'s "already fully resolved" contract
 * holds for every step added later.
 */
export function resolveRuntimeTokensInParams(
  params: Record<string, string>,
  runtime: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, interpolateContext(value, runtime)]),
  );
}

/**
 * Substitute `{{ key }}` placeholders with per-child context values.
 * Plain string substitution only — no templating engine (mirrors the
 * `TaskVariation.context` contract). Unknown placeholders are left intact
 * so a template typo is visible, not silently blanked. This is what lands
 * the per-item data (`{{client}}`, `{{number}}`, …) in a declarative-fanout
 * child's step prompt, declared inputs, AND its gate/advanceWhen file paths, so a child that
 * writes `invoices/{{number}}.html` is gated against that exact file.
 */
export function interpolateContext(text: string, context: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(context, key) ? context[key]! : whole,
  );
}

/**
 * Recursive {@link interpolateContext} over a nested plain-data value —
 * strings, arrays, and object values alike, returning fresh containers so
 * nothing aliased is mutated in place.
 *
 * A gate buries its launch parameters well below its own top level:
 * `scripts[].inputs.pattern`, `checks[].corpusDir`, `checks[].pattern`,
 * `checks[].outlineFile`, `checks[].files[]`. Interpolating a hand-written
 * list of fields missed every one of them, and the miss is invisible —
 * an uninterpolated `{{number}}` reaches the regex engine as a literal
 * and simply never matches. Pull Request Review's `scope` gate shipped
 * `##\s*Scope\s*[—-]\s*PR\s*#{{number}}` to a reviewer who had written
 * the note correctly; the only way past was to put the raw template token
 * into the task's permanent audit trail. Walk the whole gate instead of
 * naming fields, so a new check kind can never reintroduce this.
 */
export function interpolateContextDeep<T>(value: T, context: Record<string, string>): T {
  if (typeof value === 'string') return interpolateContext(value, context) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateContextDeep(entry, context)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        interpolateContextDeep(entry, context),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Apply {@link interpolateContext} across the text-bearing fields of a
 * child craftbook's steps: name/description/prompt plus the file paths in
 * `advanceWhen`, every string inside the gate, and every string inside the
 * `onEnter`/`onExit` script inputs. The step objects themselves are fresh
 * snapshot copies, but their NESTED `advanceWhen`/`gate`/`onEnter` are still
 * aliased to the source book (`snapshotCraftbookForTask` shallow-spreads each
 * step) — so those are replaced copy-on-write, never mutated in place, or the
 * substitution would write through into the resolver's template and leak one
 * task's params into the next. Non-fatal by construction — only string fields
 * are touched.
 *
 * Step-hook inputs matter as much as gate inputs: an `onEnter` script is how a
 * step does deterministic work with no model turn, and its inputs address the
 * same launch-param paths the prompt and gate do (`{{corpusScope}}`). Left out,
 * the script receives the literal `{{corpusScope}}` and fails on a path that
 * does not exist — which reads as a broken script rather than a missing
 * substitution.
 */
export function interpolateStepsContext(
  steps: TaskCraftbookStep[],
  context: Record<string, string>,
): void {
  if (Object.keys(context).length === 0) return;
  for (const step of steps) {
    if (step.name) step.name = interpolateContext(step.name, context);
    if (step.description) step.description = interpolateContext(step.description, context);
    if (step.prompt) step.prompt = interpolateContext(step.prompt, context);
    if (step.consumes?.length) {
      step.consumes = step.consumes.map((input) => ({
        ...input,
        file: interpolateContext(input.file, context),
      }));
    }
    if (step.advanceWhen?.file) {
      step.advanceWhen = {
        ...step.advanceWhen,
        file: interpolateContext(step.advanceWhen.file, context),
      };
    }
    if (step.gate) step.gate = interpolateContextDeep(step.gate, context);
    if (step.onEnter) step.onEnter = interpolateContextDeep(step.onEnter, context);
    if (step.onExit) step.onExit = interpolateContextDeep(step.onExit, context);
  }
}

/**
 * The interpolation context for steps added or patched AFTER create().
 * `create()` interpolates the whole recipe once; a step that arrives later
 * (add_task_step, set_step_deliverable's patch) skipped that walk, so a
 * `{{task.dir}}` in its gate would reach `step-gate.ts`'s unresolved-
 * placeholder guard and hard-fail as an infrastructure error. Spreading
 * the persisted params first and the runtime values last preserves
 * create()'s reserved-wins semantics.
 *
 * The persisted params run back through {@link resolveRuntimeTokensInParams}
 * rather than being trusted as-is: create() now resolves them before
 * persisting, but tasks launched before that fix carry a literal
 * `{{task.dir}}` on disk, and a single-pass substitution would hand it
 * straight to the gate a second time.
 */
export function taskInterpolationContext(task: Task): Record<string, string> {
  const runtime = {
    'task.num': String(task.num),
    'task.ref': task.ref,
    'task.projectId': task.projectId,
    'task.dir': task.artifactDir ?? `tasks/${task.num}`,
    // Present only on drafting tasks — legacy content compatibility; v2
    // mode-agnostic books never reference these tokens.
    ...(task.diffpackId
      ? { 'diffpack.id': task.diffpackId, 'diffpack.dir': `diffpacks/${task.diffpackId}` }
      : {}),
  };
  return {
    ...resolveRuntimeTokensInParams(task.craftbookParams ?? {}, runtime),
    ...runtime,
  };
}

/**
 * Turn an array of inline-step blueprints into a fresh ad-hoc craftbook.
 * Used when `create_task` is called with `steps` instead of a
 * `craftbookId` — the resulting book is embedded directly in the task
 * with no source provenance.
 */
export function inlineStepsToCraftbook(
  steps: NewCraftbookStep[],
  opts: {
    name: string;
    description?: string;
    plan?: string;
    defaultAssignee?: TaskAssignee;
    entryStepId?: string;
    /** Requirements the children inherit — see the `mainBook.spawn` call site. */
    toolsets?: CraftbookToolsetNeed[];
    connectors?: CraftbookConnectorNeed[];
    /** Embedded script sources the children's `scope: 'craftbook'` refs resolve against. */
    scripts?: Record<string, string>;
  },
): Craftbook {
  const resolved: CraftbookStep[] = expandStepDeliverables(steps);
  const ids = new Set(resolved.map((s) => s.id));
  const entry = opts.entryStepId && ids.has(opts.entryStepId) ? opts.entryStepId : resolved[0]!.id;
  const now = nowIso();
  return {
    id: `task-${randomUUID().slice(0, 8)}`,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(opts.defaultAssignee ? { defaultAssignee: opts.defaultAssignee } : {}),
    ...(opts.toolsets ? { toolsets: opts.toolsets } : {}),
    ...(opts.connectors ? { connectors: opts.connectors } : {}),
    ...(opts.scripts ? { scripts: opts.scripts } : {}),
    steps: resolved,
    entryStepId: entry,
    createdAt: now,
    updatedAt: now,
  };
}
