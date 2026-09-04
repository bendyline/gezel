/**
 * Step-scoped tool kits (D4): the active step's deliverable class +
 * gate checks determine the tool surface — a "write the report" step
 * needs ~10 tools, not the full ~140-tool bridge. Authored the same
 * deterministic-literal way as `gateChecksFloor`/`gateScriptsForKind`
 * in core/deliverable.ts; tool-NAME sets live here in the service chat
 * layer (the cap-priority-list precedent) so core stays tool-name-free.
 *
 * The kit narrows the MIDDLE of the surface only — the always-keep
 * floors (step-completion, load-bearing, self-check) are unioned back
 * by the caller (`resolveSessionToolSurface`), so a kit can never
 * strand a step without its completion tools.
 */

import type { CraftbookStep, DeliverableKind } from '@bendyline/gezel';
import {
  deliverableKindForStep,
  firstActionForKind,
  isProseDocPath,
  normalizeScriptRefs,
  normalizeStepGate,
  stepDeliverablePath,
} from '@bendyline/gezel';
import { outputMediaForStep } from '../craftbook/step-toolsets.js';

export { firstActionForKind };

/**
 * Source-acquisition tools that must survive a Markdown deliverable kit for
 * research work. A research step still writes an ordinary notes/report file,
 * but collapsing it to FILE_CORE turns "research" into model-memory prose.
 *
 * `search` + `read_document` are here because research is not only external.
 * `search` is the one tool covering the shared document library, project and
 * gezel memories, artifacts, and installed knowledge catalogs — the user's
 * own material. Without it a research step would go straight to the open web
 * past whatever notes, briefs, or policies the user already wrote, and the
 * craftbooks that drive these steps ask for "resolvable URL **or exact file
 * path**" citations, so they already expect internal sources to be citable.
 * `read_document` rides along because `search` tells the model to open a
 * shared hit with it; wiring the finder without the opener surfaces
 * documents the step cannot actually read.
 *
 * Note these are the tools a research step may USE. What COUNTS as evidence
 * is the separate per-craftbook `researchEvidence.tools` list, which stays
 * scoped to external acquisition on purpose.
 */
export const RESEARCH_STEP_TOOLS: readonly string[] = [
  'search',
  'read_document',
  'web_search',
  'wikipedia_search',
  'wikipedia_read',
  'fetch_url',
  'browser_find_page_element',
  'run_playwright_script',
];

/** Read/inspect — valid regardless of which drawer receives the result. */
const WORKSPACE_READ_CORE: readonly string[] = [
  'read_file',
  'read_files',
  'list_dir',
  'stat',
  'validate',
];

/** Mutate the shipped workspace (or its diffpack overlay). */
const WORKSPACE_WRITE_CORE: readonly string[] = [
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
];

const KIND_ADDITIONS: Partial<Record<DeliverableKind, readonly string[]>> = {
  'html-page': ['insert_at_marker'],
  'html-marketing-site': ['insert_at_marker'],
  'html-game': ['insert_at_marker'],
  'html-multiscreen-game': ['insert_at_marker'],
  'data-file': ['derive_file', 'run_nodejs_script', 'make_dir'],
  json: ['derive_file', 'run_nodejs_script'],
  'code-module': ['run_nodejs_script', 'apply_patch', 'make_dir', 'rename'],
  'code-with-tests': ['run_nodejs_script', 'apply_patch', 'make_dir', 'rename'],
  // `render_image` covers deterministic diagrams/charts; `generate_image`
  // covers configured diffusion/image-model output. A fixed-function image
  // generator declares the latter, so dropping it here makes a task-scoped
  // image turn exit successfully without ever invoking its only tool.
  'image-set': ['render_image', 'generate_image', 'make_dir'],
  'audio-file': ['run_nodejs_script'],
};

/**
 * Gate-check-driven additions: what the VALIDATOR demands shapes what
 * the worker must be able to do. `nodeRuns` executes the deliverable →
 * the worker needs the sandbox; grounding checks resolve
 * citations/values against the corpus → the worker needs search.
 */
function gateDrivenAdditions(step: Pick<CraftbookStep, 'gate'>, path: string | null): string[] {
  if (!step.gate) return [];
  const gate = normalizeStepGate(step.gate);
  const proseTarget = path !== null && isProseDocPath(path);
  const out = new Set<string>();
  for (const check of gate.checks ?? []) {
    switch (check.kind) {
      case 'nodeRuns':
        out.add('run_nodejs_script');
        break;
      case 'citationsResolve':
      case 'valueGrounding':
      case 'unsupportedClaims':
        out.add('grep_files');
        out.add('find_files');
        break;
      case 'researchEvidence':
        for (const tool of RESEARCH_STEP_TOOLS) out.add(tool);
        break;
      case 'corpusCoverage':
        out.add('search');
        out.add('list_artifacts');
        out.add('read_artifact');
        out.add('grep_artifact');
        out.add('grep_files');
        out.add('find_symbol');
        out.add('search_code');
        break;
      case 'corpusBatches':
        out.add('list_artifacts');
        out.add('read_artifact');
        break;
      case 'csvShape':
      case 'recordSchema':
      case 'tableShape':
        // A Markdown table inside a prose report is written, not derived —
        // handing that step the transform kit points it at the wrong verb.
        if (!proseTarget) {
          out.add('derive_file');
          out.add('run_nodejs_script');
        }
        break;
      default:
        break;
    }
  }
  return [...out];
}

export interface StepKit {
  kind: DeliverableKind;
  path: string | null;
  tools: ReadonlySet<string>;
}

/**
 * Artifact reads remain available to workspace-output steps because their
 * declared inputs and research corpus may live there. The WRITE verb is
 * separate: exposing both write channels is exactly what made models put a
 * gated workspace file in the drawer (or an artifact in the workspace).
 */
const ARTIFACT_READ_TOOLS: readonly string[] = ['list_artifacts', 'read_artifact', 'grep_artifact'];
const ARTIFACT_WRITE_TOOLS: readonly string[] = ['write_artifact'];

/**
 * The kit for a persisted step, or null when the step targets no file
 * (pure-routing / user steps) — null means "no kit narrowing". The
 * The kit carries exactly one deliverable write channel. Artifact reads may
 * still ride along as inputs, but a workspace step cannot silently fall back
 * to `write_artifact`, and an artifact step cannot mutate the workspace.
 */
export function stepToolKit(
  step: Pick<CraftbookStep, 'advanceWhen' | 'gate' | 'onExit' | 'toolPolicy' | 'consumes'>,
): StepKit | null {
  const kind = deliverableKindForStep(step);
  if (!kind) return null;
  const path = stepDeliverablePath(step);
  const media = outputMediaForStep(step);
  const tools = new Set<string>(WORKSPACE_READ_CORE);
  for (const t of ARTIFACT_READ_TOOLS) tools.add(t);
  if (media.has('artifact')) {
    for (const t of ARTIFACT_WRITE_TOOLS) tools.add(t);
  }
  if (media.has('workspace')) {
    for (const t of WORKSPACE_WRITE_CORE) tools.add(t);
  }
  for (const t of KIND_ADDITIONS[kind] ?? []) tools.add(t);
  for (const t of gateDrivenAdditions(step, path)) tools.add(t);
  if (normalizeScriptRefs(step.onExit).length > 0) tools.add('run_installed_script');
  if (!media.has('workspace')) {
    // Kind additions describe how workspace files are produced. Keep the
    // computational tools, but not their workspace mutation side effects.
    for (const t of ['apply_patch', 'make_dir', 'rename', 'derive_file']) tools.delete(t);
  }
  return { kind, path: stepDeliverablePath(step), tools };
}

/**
 * The repair surface for a gate-rejected step. Extends the scenario
 * repair set with the execution channel for data kinds — without
 * `derive_file`/`run_nodejs_script`, a data-repair turn is stranded
 * hand-typing rows (the exact failure transform-by-execution exists
 * to prevent).
 */
export function gateRepairToolsForKind(
  kind: DeliverableKind | null,
  media: ReadonlySet<'workspace' | 'artifact' | 'task-note' | 'none'> | null = null,
): ReadonlySet<string> {
  const base = new Set<string>(WORKSPACE_READ_CORE);
  for (const t of ARTIFACT_READ_TOOLS) base.add(t);
  if (media?.has('artifact')) {
    for (const t of ARTIFACT_WRITE_TOOLS) base.add(t);
  }
  if (media?.has('workspace')) {
    for (const t of WORKSPACE_WRITE_CORE) base.add(t);
  }
  // Null is the ad-hoc/legacy repair case: preserve both write channels.
  if (media === null) {
    for (const t of WORKSPACE_WRITE_CORE) base.add(t);
    for (const t of ARTIFACT_WRITE_TOOLS) base.add(t);
  }
  if (kind === 'data-file' || kind === 'json') {
    if (media === null || media.has('workspace')) base.add('derive_file');
    base.add('run_nodejs_script');
    if (media === null || media.has('workspace')) base.add('make_dir');
  }
  if (kind === 'code-module' || kind === 'code-with-tests') {
    base.add('run_nodejs_script');
    if (media === null || media.has('workspace')) base.add('apply_patch');
  }
  return base;
}

/**
 * Deliverable-aware prefix for the tiny-tier cap priority: the tools
 * this step's class actually produces with, ranked first so the cap
 * never trims them in favor of generic breadth.
 */
export function capPriorityPrefixForKind(kind: DeliverableKind | null): readonly string[] {
  if (!kind) return [];
  if (kind === 'data-file' || kind === 'json') {
    return [
      'derive_file',
      'run_nodejs_script',
      'read_file',
      'read_files',
      'write_file',
      'validate',
    ];
  }
  if (kind === 'code-module' || kind === 'code-with-tests') {
    return [
      'read_file',
      'read_files',
      'write_file',
      'replace_in_file',
      'run_nodejs_script',
      'validate',
    ];
  }
  if (kind === 'image-set') {
    return ['generate_image', 'render_image', 'list_dir', 'write_file'];
  }
  return [
    'write_file',
    'write_artifact',
    'read_file',
    'read_files',
    'append_to_file',
    'replace_in_file',
    'validate',
  ];
}

/** Kill switch for kit narrowing (D4 feature half). */
export function stepToolKitDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GEZEL_DISABLE_STEP_TOOL_KIT === '1';
}

/** Kill switch for the repair-clamp lifetime fix (D4 bugfix half). */
export function repairClampDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GEZEL_DISABLE_REPAIR_CLAMP === '1';
}

/**
 * Is this session mid-REPAIR — a gate rejected its deliverable and the
 * validator has not approved since? Derived from persisted gate state
 * (no new session field), so the clamp survives across turns whose
 * messages carry no repair marker — the exact widen-back gap:
 *
 * - Craftbook step: active, not completed, and carrying any gate
 *   bookkeeping. `gateAttemptHistory` is load-bearing — the
 *   `onReject: <self>` re-activation deliberately clears
 *   `gateAttempts`/`lastGateReject`, and the history is the only
 *   cross-activation plateau memory.
 * - Ad-hoc deliverable: `session.deliverableGatePlateau` present
 *   (set on reject, cleared on approve by the chat-side gate).
 *
 * Expiry is structural: gate approve clears the fields / completes the
 * step; a step change re-derives against the new step.
 */
export function stepGateRepairActive(
  step:
    | {
        completedAt?: string;
        gateAttempts?: number;
        lastGateReject?: unknown;
        gateAttemptHistory?: readonly unknown[];
      }
    | undefined,
  session: { deliverableGatePlateau?: unknown },
): boolean {
  if (session.deliverableGatePlateau) return true;
  if (!step || step.completedAt) return false;
  return (
    (step.gateAttempts ?? 0) > 0 ||
    step.lastGateReject !== undefined ||
    (step.gateAttemptHistory?.length ?? 0) > 0
  );
}
