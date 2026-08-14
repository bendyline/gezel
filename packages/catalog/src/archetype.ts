import {
  type CraftbookDoc,
  CraftbookDocSchema,
  type CraftbookRole,
  CraftbookSchema,
  type CraftbookStep,
  type CraftbookToolsetNeed,
  type DeliverableKind,
  type GateCheck,
  type StepGate,
  advanceSniffForKind,
  completionGate,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { isAccessoryArtifactPath } from './artifact-surface.js';

// `DeliverableKind`, the gate-class helpers, and `deliverableStep` now live in
// core (`@bendyline/gezel`) so the MCP server and the plan craftbook reuse the
// exact same gate generation without depending on this catalog package.
export type { DeliverableKind };

/**
 * ─ Craftbook archetypes ──────────────────────────────────────────────
 *
 * The generation pipeline behind the gallery (Pillar 3). A small model
 * gets more out of a *specific* craftbook than the generic `build-loop`
 * because the specific one encodes the right **specialist role per phase**
 * and the **domain-correct ordering**, AND — with the gate work landed —
 * a **per-phase static gate**: each phase declares the artifact it produces
 * (`produces`), and the generator emits a runtime gate-checkpoint after it
 * that the runtime evaluates with NO model turn, looping back on a miss.
 *
 * Rather than have an LLM freehand craftbook JSON (non-deterministic, easy
 * to get subtly wrong), we capture the wisdom in a structured `ArchetypeSpec`
 * and generate deterministically. The spec IS the reviewable artifact; the
 * generator guarantees a schema-valid, consistently-gated recipe every time.
 *
 * Shape of a generated book (per build phase with a `produces`):
 *
 *   phase (work; advanceWhen auto-advances when the artifact lands; a
 *   COMPLETION gate — cheap declarative floor + standard-library gate
 *   scripts — judges every completion attempt, rejecting with a
 *   prescriptive message and re-activating the phase on a miss) → … →
 *   build → evaluate (reviewer QA — the Layer-2 judgment) → finish.
 *
 * The gates run with NO model turn — the runtime checks the workspace,
 * judges, and loops. That is what carries a weak model: it only ever
 * does the phase work; advancing, grading, and looping are automatic.
 */

export interface ArchetypePhase {
  /** Step id — unique within the archetype; must not be `evaluate`/`finish`. */
  id: string;
  /** Display name. */
  name: string;
  /** `suggestedRole` — resolved to a gezel via `ensureGezel` at run time. */
  role: string;
  /** Short one-line summary of the phase. */
  summary: string;
  /** The step procedure — concrete, instructive instructions for this phase. */
  prompt: string;
  /**
   * The checkable artifact this phase produces. When set, the generator
   * (a) auto-advances the phase once the artifact lands (`advanceWhen`) and
   * (b) inserts a runtime gate-checkpoint after it that loops back on a miss.
   * Omit for a phase whose only output is task-notes / discussion.
   */
  produces?: {
    /** Workspace-relative path (a file, or a directory for `image-set`). */
    path: string;
    kind: DeliverableKind;
    /** Override the class-default minimum byte floor. */
    minBytes?: number;
    /** Extra gate checks beyond the class defaults. */
    extraChecks?: GateCheck[];
    /**
     * The deliverable lands in the project's artifacts drawer
     * (`read_artifact`/`write_artifact`), not the shipped workspace. The
     * `advanceWhen` and the completion gate then read the drawer: only the
     * drawer-capable checks (minBytes / sniff / contains) survive, each
     * tagged `artifact: true`, and the workspace-only gate scripts are
     * dropped. Used by review/analysis books whose output is not product
     * source (e.g. a threat model).
     */
    artifact?: boolean;
  };
}

export interface ArchetypeSpec {
  /** Craftbook id, e.g. `html-arcade-game`. Lowercase kebab. */
  id: string;
  /** Display name, e.g. `HTML Arcade Game`. */
  name: string;
  /** One-paragraph description — also what `suggest_craftbook` ranks on. */
  description: string;
  /** Project-lifecycle shelf. Older specs safely default to general. */
  role?: CraftbookRole;
  /**
   * Immutable catalog release emitted for this spec. Seeds without an
   * explicit release retain the original 1.0.0 baseline, while a changed
   * seed must opt into a new version instead of overwriting released JSON.
   */
  release?: {
    version: string;
    releasedAt: string;
  };
  tags?: string[];
  triggers?: string[];
  /**
   * Toolsets the generated book declares — surfaced for setup and, with
   * `autoAllow`, pre-authorized while the book is active. Threaded verbatim
   * into the CraftbookDoc.
   */
  toolsets?: CraftbookToolsetNeed[];
  /**
   * Hand-authored "… discipline:" prose appended to the generated about,
   * AFTER the "Phases:" list. Carries the source/data/evidence-discipline
   * guidance that a few gallery books curated by hand — folded into the
   * spec so regeneration reproduces it verbatim. Include the section header
   * (e.g. `Source discipline:\n\n- …`); it is emitted as its own block.
   */
  sourceDiscipline?: string;
  /**
   * Where `sourceDiscipline` sits in the about. Default (unset) = after the
   * "Phases:" list, before the trailing "The gates never advance…"
   * boilerplate (the common layout). `after-boilerplate` places it at the
   * very end (dependency-audit's hand-authored layout). `in-description`
   * splices it right after `spec.description`, before the standing about
   * boilerplate — the about-only spot, so the catalog `description` (and the
   * manifest) stays free of it (crm-update-batch's hand-authored layout).
   */
  disciplinePlacement?: 'after-boilerplate' | 'in-description';
  /**
   * A paragraph inserted between the standing about boilerplate and the
   * "Phases:" list — used by artifact-drawer books to explain up front that
   * every deliverable lands in the drawer rather than the shipped workspace.
   * Book-specific prose, so it is a spec field rather than derived.
   */
  artifactNote?: string;
  /** Ordered build phases BEFORE the evaluate gate (design, dev, …). */
  phases: ArchetypePhase[];
  /** The final evaluate gate. */
  evaluate: {
    role?: string;
    /** Domain-specific "what to check" — the routing footer is appended. */
    prompt: string;
    /** Phase id to loop back to on failure. Defaults to the last build phase. */
    loopBackTo?: string;
    /**
     * The final deliverable the evaluate gate checks. When set, evaluate gets
     * a static gate (Layer 1, runtime) plus the reviewer prompt (Layer 2).
     * Defaults to the last phase's `produces` if that phase declares one.
     */
    deliverable?: {
      path: string;
      kind: DeliverableKind;
      minBytes?: number;
      extraChecks?: GateCheck[];
      /** Gate the artifacts drawer instead of the workspace — see `ArchetypePhase.produces.artifact`. */
      artifact?: boolean;
    };
    /** Reviewer role for the Layer-2 QA pass after the static gate passes. Default `reviewer`. Set `null` to skip. */
    reviewer?: string | null;
  };
  /** Optional override for the terminal step's prompt. */
  finishPrompt?: string;
}

const RESERVED_STEP_IDS = new Set(['evaluate', 'finish']);

/**
 * Deliverable kinds that are review/analysis output rather than product
 * source. Phases producing these default to the artifacts drawer — the
 * night-shift contract is "reports, findings, and sidecar files land in
 * the artifacts drawer, not the shipped workspace" — which also keeps
 * report books runnable on projects where gezel workspace writes are
 * off. A spec opts a phase back into the workspace with
 * `artifact: false`.
 */
const DRAWER_DEFAULT_KINDS: ReadonlySet<DeliverableKind> = new Set([
  'markdown-report',
  'markdown-notes',
  'security-report',
]);

function withArtifactDefault<T extends { path: string; kind: DeliverableKind; artifact?: boolean }>(
  produces: T,
): T {
  if (isAccessoryArtifactPath(produces.path)) return { ...produces, artifact: true };
  if (produces.artifact !== undefined) return produces;
  if (!DRAWER_DEFAULT_KINDS.has(produces.kind)) return produces;
  return { ...produces, artifact: true };
}

/** The spec with the kind-based drawer default materialized on every deliverable. */
function normalizeArchetypeSpec(spec: ArchetypeSpec): ArchetypeSpec {
  return {
    ...spec,
    phases: spec.phases.map((p) =>
      p.produces ? { ...p, produces: withArtifactDefault(p.produces) } : p,
    ),
    evaluate: spec.evaluate.deliverable
      ? { ...spec.evaluate, deliverable: withArtifactDefault(spec.evaluate.deliverable) }
      : spec.evaluate,
  };
}

/**
 * Deterministic per-step steering for a drawer deliverable. Spec prompts
 * are written path-first ("write `notes/scan.md`"); without this line a
 * model with both write channels reliably picks `write_file`, the file
 * lands in the workspace, and the drawer-reading gate rejects every
 * attempt. Skipped when the spec prompt already teaches `write_artifact`.
 */
function drawerPromptNote(path: string): string {
  return `The deliverable \`${path}\` lands in the project's artifacts drawer — write it with \`write_artifact\` and read it back with \`read_artifact\`; the shipped workspace stays untouched.`;
}

function artifactInputPromptNote(paths: string[]): string {
  const list = paths.map((path) => `\`${path}\``).join(', ');
  return `Before working, open the artifact input${paths.length === 1 ? '' : 's'} ${list} with \`read_artifact\`; do not look for ${paths.length === 1 ? 'it' : 'them'} in the workspace.`;
}

function referencedPhaseInputs(
  phases: ArchetypePhase[],
  prompt: string,
): NonNullable<CraftbookStep['consumes']> {
  const seen = new Set<string>();
  const inputs: NonNullable<CraftbookStep['consumes']> = [];
  for (const phase of phases) {
    const output = phase.produces;
    if (!output || !prompt.includes(output.path)) continue;
    const key = `${output.artifact === true ? 'artifact' : 'workspace'}:${output.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push({ file: output.path, ...(output.artifact ? { artifact: true } : {}) });
  }
  return inputs;
}

export interface ArchetypeCraftbook {
  steps: CraftbookStep[];
  entryStepId: string;
}

/**
 * Build the craftbook graph from a spec: each build phase carries a
 * COMPLETION gate when it `produces` an artifact (cheap declarative
 * floor + standard-library gate scripts, judged inside completeStep —
 * a rejection re-activates the phase with the prescriptive message),
 * then a reviewer `evaluate` step (the Layer-2 judgment a static check
 * cannot make), then a terminal `finish`. The safe failure mode is
 * always "loop back and fix", never "ship half-done".
 */
export function archetypeToCraftbook(rawSpec: ArchetypeSpec): ArchetypeCraftbook {
  const spec = normalizeArchetypeSpec(rawSpec);
  if (spec.phases.length === 0) throw new Error(`archetype "${spec.id}": needs at least one phase`);
  const ids = new Set<string>();
  for (const p of spec.phases) {
    if (RESERVED_STEP_IDS.has(p.id)) {
      throw new Error(`archetype "${spec.id}": phase id "${p.id}" is reserved`);
    }
    if (p.id.includes('--')) {
      throw new Error(`archetype "${spec.id}": phase id "${p.id}" must not contain "--"`);
    }
    if (ids.has(p.id)) throw new Error(`archetype "${spec.id}": duplicate phase id "${p.id}"`);
    ids.add(p.id);
  }

  const lastPhase = spec.phases[spec.phases.length - 1]!;
  const loopBackTo = spec.evaluate.loopBackTo ?? lastPhase.id;
  if (!ids.has(loopBackTo)) {
    throw new Error(`archetype "${spec.id}": evaluate.loopBackTo "${loopBackTo}" is not a phase`);
  }

  const steps: CraftbookStep[] = [];

  // The final deliverable bar lands on the LAST build phase's completion
  // gate (Layer 1, runtime); `evaluate` keeps the Layer-2 judgment a
  // static check cannot make.
  const deliverable = spec.evaluate.deliverable ?? lastPhase.produces;

  spec.phases.forEach((p, i) => {
    const isLast = i === spec.phases.length - 1;
    // Where this phase advances to once its gate approves: the next
    // phase, or (for the last build phase) the reviewer evaluate step.
    const onward = isLast ? 'evaluate' : spec.phases[i + 1]!.id;
    // The bar this phase must clear to complete. Intermediate phases
    // gate on their own artifact; the last phase gates on the FINAL
    // deliverable (which defaults to its own `produces`).
    const gated = isLast ? deliverable : p.produces;
    const inputs = referencedPhaseInputs(spec.phases.slice(0, i), p.prompt);
    const artifactInputs = inputs.filter((input) => input.artifact).map((input) => input.file);
    let prompt = p.prompt.trim();
    if (artifactInputs.length > 0 && !prompt.includes('read_artifact')) {
      prompt = `${prompt}\n\n${artifactInputPromptNote(artifactInputs)}`;
    }
    if (p.produces?.artifact && !prompt.includes('write_artifact')) {
      prompt = `${prompt}\n\n${drawerPromptNote(p.produces.path)}`;
    }

    steps.push({
      id: p.id,
      name: p.name,
      description: p.summary,
      suggestedRole: p.role,
      prompt,
      ...(inputs.length > 0 ? { consumes: inputs } : {}),
      // Observable progress: the phase auto-advances the moment its
      // artifact lands (no `advance_task_step` call needed) — and the
      // completion gate judges that advance like any other.
      ...(p.produces
        ? {
            advanceWhen: {
              file: p.produces.path,
              minBytes: 1,
              sniff: advanceSniffForKind(p.produces.kind),
              ...(p.produces.artifact ? { artifact: true } : {}),
            },
          }
        : {}),
      ...(gated
        ? {
            gate: gated.artifact
              ? artifactCompletionGate(gated, p.id, isLast ? 4 : 3)
              : completionGate(gated, p.id, isLast ? 4 : 3),
          }
        : {}),
      next: onward,
    });
  });

  steps.push({
    id: 'evaluate',
    name: 'Evaluate',
    description:
      'Grade the deliverable against every acceptance criterion. All pass → finish; any fail → loop back and fix the gap.',
    suggestedRole: spec.evaluate.role ?? 'reviewer',
    prompt: `${spec.evaluate.prompt.trim()}\n\n${evaluateRoutingFooter(
      loopBackTo,
      deliverable !== undefined,
      deliverable?.artifact && !spec.evaluate.prompt.includes('read_artifact')
        ? deliverable.path
        : null,
    )}`,
    ...(deliverable
      ? {
          consumes: [
            {
              file: deliverable.path,
              ...(deliverable.artifact ? { artifact: true } : {}),
            },
          ],
        }
      : {}),
    // Default forward edge loops back to the build phase — the safe failure
    // mode is "keep improving", never "ship half-done".
    next: loopBackTo,
  });

  steps.push({
    id: 'finish',
    name: 'Finish',
    description: 'All acceptance criteria met. Stamp a short summary and report DONE.',
    suggestedRole: 'developer',
    prompt:
      spec.finishPrompt?.trim() ??
      'Every acceptance criterion passed. Write a one-paragraph DONE summary to task notes via `write_task_note`: what was built, the deliverable path(s), and a one-line confirmation that each criterion is met. Then report DONE.',
    terminal: true,
  });

  return { steps, entryStepId: spec.phases[0]!.id };
}

function evaluateRoutingFooter(
  loopBackTo: string,
  hasGate: boolean,
  artifactPath: string | null = null,
): string {
  const lastLine = hasGate
    ? "Never route to `finish` while any criterion is unmet. The build phase's completion gate already blocked a grossly-incomplete deliverable; your job is the judgment an automated check cannot make (does it actually work, read well, look right). After ~3 unproductive loops, stop and report DONE_WITH_CONCERNS so the user can step in."
    : 'Never route to `finish` while any criterion is unmet. If you advance without a target, the loop sends you back by design. After ~3 unproductive loops, stop and report DONE_WITH_CONCERNS so the user can step in.';
  return [
    ...(artifactPath
      ? [
          `The deliverable lives in the project's artifacts drawer — open \`${artifactPath}\` with \`read_artifact\`, not \`read_file\`.`,
          '',
        ]
      : []),
    'Then route — this is the whole point of the loop:',
    '',
    `- **Every criterion PASSES →** call \`advance_task_step({ ref, stepId: "evaluate", next: "finish" })\`.`,
    `- **Any criterion FAILS →** write the specific gaps to notes, then call \`advance_task_step({ ref, stepId: "evaluate", next: "${loopBackTo}" })\` to loop back. The builder fixes exactly those gaps.`,
    '',
    lastLine,
  ].join('\n');
}

// The heading requirement a markdown-doc/report deliverable carries as a
// standard-library gate SCRIPT in the workspace (`checkContains` over
// MARKDOWN_HEADERS). Scripts cannot read the artifacts drawer, so for an
// artifact deliverable it is re-expressed as a drawer-readable `contains`
// check. Kept in sync with core's `gateScriptsForKind` markdown pattern.
const MARKDOWN_HEADING_PATTERN = '(?:^|\\n)#{1,3}\\s+\\S';

/**
 * The completion gate for a phase whose deliverable lands in the artifacts
 * drawer. Mirrors core's `deliverableStep({ artifact: true })` filtering:
 * only the drawer-capable checks (minBytes / sniff / contains) survive, each
 * tagged `artifact: true`, and the workspace-reading gate scripts are dropped
 * — the markdown heading script is re-expressed as a `contains` check so the
 * structural bar is not lost.
 */
function artifactCompletionGate(
  produces: { path: string; kind: DeliverableKind; minBytes?: number; extraChecks?: GateCheck[] },
  selfId: string,
  maxAttempts: number,
): StepGate {
  const base = completionGate(produces, selfId, maxAttempts);
  const checks: GateCheck[] = (base.checks ?? [])
    .filter((c) => c.kind === 'minBytes' || c.kind === 'sniff' || c.kind === 'contains')
    .map((c) => ({ ...c, artifact: true }) as GateCheck);
  if (produces.kind === 'markdown-doc' || produces.kind === 'markdown-report') {
    checks.push({
      kind: 'contains',
      file: produces.path,
      pattern: MARKDOWN_HEADING_PATTERN,
      flags: 'i',
      label: 'at least one markdown heading',
      artifact: true,
    });
  }
  return { at: 'completion', checks, onReject: selfId, maxAttempts };
}

export interface GeneratedCraftbookFiles {
  /** Two-char catalog shard (id prefix). */
  shard: string;
  id: string;
  /** Path-relative contents to write under `craftbook-templates/{shard}/{id}/`. */
  files: { relPath: string; content: string }[];
}

/**
 * Serialize a spec into the on-disk bundled-catalog layout (Craftbooks V2):
 * the identity manifest plus one versioned `craftbook.json` — the
 * single CraftbookDoc with the about prose inlined as `description` and
 * step prompts inlined on the steps. The generation script writes these,
 * then `build-index` folds them into `craftbook-templates/index.json`.
 */
export function archetypeToFiles(
  rawSpec: ArchetypeSpec,
  defaultReleasedAt: string,
): GeneratedCraftbookFiles {
  const spec = normalizeArchetypeSpec(rawSpec);
  const { steps, entryStepId } = archetypeToCraftbook(spec);
  const version = spec.release?.version ?? '1.0.0';
  const releasedAt = spec.release?.releasedAt ?? defaultReleasedAt;

  // Guarantee the generated book is runtime-valid (graph integrity, gate +
  // advanceWhen edge resolution, step shape) BEFORE it ever touches disk.
  const check = CraftbookSchema.safeParse({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version,
    steps,
    entryStepId,
    ...(spec.triggers && spec.triggers.length > 0 ? { triggers: spec.triggers } : {}),
    ...(spec.toolsets && spec.toolsets.length > 0 ? { toolsets: spec.toolsets } : {}),
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
  });
  if (!check.success) {
    throw new Error(`archetype "${spec.id}" produced an invalid craftbook: ${check.error.message}`);
  }

  const shard = spec.id.slice(0, 2);

  const topManifest = {
    schemaVersion: 1,
    kind: 'craftbook-template',
    id: spec.id,
    role: spec.role ?? 'general',
    name: spec.name,
    description: spec.description,
    tags: dedupe(['gallery', ...(spec.tags ?? [])]),
    maintainer: { name: 'Gezel' },
    logo: 'logo.webp',
    license: 'MIT',
    yankedVersions: [],
    workflow: 'build-loop',
  };

  // Schema-parse before serializing: Zod re-emits keys in schema
  // declaration order, so generated books are byte-identical with docs
  // that took the migration path (which also serialized the parse output).
  const doc: CraftbookDoc = CraftbookDocSchema.parse({
    id: spec.id,
    name: spec.name,
    description: aboutMarkdown(spec),
    entryStepId,
    ...(spec.triggers && spec.triggers.length > 0 ? { triggers: spec.triggers } : {}),
    ...(spec.toolsets && spec.toolsets.length > 0 ? { toolsets: spec.toolsets } : {}),
    steps,
    version,
    releasedAt,
  } satisfies CraftbookDoc);

  return {
    shard,
    id: spec.id,
    files: [
      { relPath: 'manifest.json', content: `${JSON.stringify(topManifest, null, 2)}\n` },
      {
        relPath: `versions/${version}/craftbook.json`,
        content: serializeCraftbookDoc(doc, 'json'),
      },
    ],
  };
}

function aboutMarkdown(spec: ArchetypeSpec): string {
  const hasGates = spec.phases.some((p) => p.produces);
  const phaseList = spec.phases
    .map((p) => {
      const gated = p.produces
        ? ` → gated on ${p.produces.artifact ? 'artifact ' : ''}\`${p.produces.path}\` (${p.produces.kind})`
        : '';
      return `${p.name} (${p.role}) — ${p.summary}${gated}`;
    })
    .map((line, i) => `${i + 1}. ${line}`)
    .join('\n');

  if (!hasGates) {
    // Original gateless about — keeps hand-authored seed books byte-stable.
    return `${spec.description}

A gallery craftbook generated from an archetype spec. Like \`build-loop\`, it
runs \`design → … → evaluate → (loop) → finish\` with a reviewer-gated
evaluate step that loops back to the build phase until the acceptance
criteria pass. What it adds over the generic book: a specialist role per
phase and a domain-correct ordering.

Phases:

${phaseList}

The evaluate step holds the gate — it never advances to \`finish\` with an
unmet criterion, and loops back to the build phase to fix named gaps.
`;
  }

  // Optional hand-authored blocks folded into specs. `artifactNote` sits
  // between the standing boilerplate and the phase list; `sourceDiscipline`
  // sits after the phase list, either before the trailing boilerplate
  // (default) or at the very end (`after-boilerplate`). Books with drawer
  // deliverables and no hand-authored note get the standing one so the
  // about always says where the deliverables land.
  const anyDrawerDeliverable =
    spec.phases.some((p) => p.produces?.artifact) || spec.evaluate.deliverable?.artifact === true;
  const artifactNoteText =
    spec.artifactNote ??
    (anyDrawerDeliverable
      ? 'Deliverables marked "artifact" land in the project\'s artifacts drawer (`write_artifact` / `read_artifact`), not the shipped workspace — review output is not product source.'
      : undefined);
  const artifactNote = artifactNoteText ? `${artifactNoteText}\n\n` : '';
  // `in-description` splices into the prose ABOVE the standing boilerplate
  // (about-only, keeps the catalog description clean); the default places
  // the block after the phase list; `after-boilerplate` at the very end.
  const disciplineInDescription =
    spec.sourceDiscipline && spec.disciplinePlacement === 'in-description'
      ? `\n\n${spec.sourceDiscipline}`
      : '';
  const disciplineBefore =
    spec.sourceDiscipline && spec.disciplinePlacement === undefined
      ? `${spec.sourceDiscipline}\n\n`
      : '';
  const disciplineAfter =
    spec.sourceDiscipline && spec.disciplinePlacement === 'after-boilerplate'
      ? `\n${spec.sourceDiscipline}\n`
      : '';

  return `${spec.description}${disciplineInDescription}

A gallery craftbook generated from an archetype spec. It runs
\`phase → (per-phase gate) → … → evaluate → (loop) → finish\`. Each build
phase that produces a checkable artifact is followed by a **runtime
gate-checkpoint** — the runtime verifies the artifact and routes with no
model turn, looping back to redo the phase on a miss. The final \`evaluate\`
step holds a static deliverable gate plus a reviewer QA pass. What it adds
over the generic \`build-loop\`: a specialist role per phase, a
domain-correct ordering, and a concrete per-phase quality bar.

${artifactNote}Phases:

${phaseList}

${disciplineBefore}The gates never advance with an unmet criterion, and loop back to the
owning phase to fix named gaps.
${disciplineAfter}`;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
