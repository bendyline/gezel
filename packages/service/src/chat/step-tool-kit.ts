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
  normalizeScriptRefs,
  normalizeStepGate,
  stepDeliverablePath,
} from '@bendyline/gezel';

export { firstActionForKind };

/** Read/inspect/write/edit — the core of every file-producing step. */
const FILE_CORE: readonly string[] = [
  'read_file',
  'list_dir',
  'stat',
  'validate',
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
function gateDrivenAdditions(step: Pick<CraftbookStep, 'gate'>): string[] {
  if (!step.gate) return [];
  const gate = normalizeStepGate(step.gate);
  const out = new Set<string>();
  for (const check of gate.checks ?? []) {
    switch (check.kind) {
      case 'nodeRuns':
        out.add('run_nodejs_script');
        break;
      case 'citationsResolve':
      case 'valueGrounding':
      case 'unsupportedClaims':
        out.add('search_files');
        out.add('find_files');
        break;
      case 'csvShape':
      case 'recordSchema':
      case 'tableShape':
        out.add('derive_file');
        out.add('run_nodejs_script');
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
 * The artifacts drawer is "deliberately never gated" (role-tool-filter's
 * security-gate contract): it is the write-to-the-sandbox escape hatch that
 * must survive every ceiling, including a writes-off project where the
 * whole `workspace-fs-write` group is stripped. Kit narrowing removing
 * these stranded a step-scoped Developer with zero write channels while
 * its gate demanded a deliverable (molen dependency-audit night shift).
 */
const ARTIFACT_DRAWER_TOOLS: readonly string[] = [
  'list_artifacts',
  'read_artifact',
  'write_artifact',
  'grep_artifact',
];

/**
 * The kit for a persisted step, or null when the step targets no file
 * (pure-routing / user steps) — null means "no kit narrowing". The
 * artifact drawer tools ride along for every kit so drawer-targeted
 * deliverables work and workspace-targeted steps keep the drawer as
 * their fallback output surface.
 */
export function stepToolKit(
  step: Pick<CraftbookStep, 'advanceWhen' | 'gate' | 'onExit'>,
): StepKit | null {
  const kind = deliverableKindForStep(step);
  if (!kind) return null;
  const tools = new Set<string>(FILE_CORE);
  for (const t of KIND_ADDITIONS[kind] ?? []) tools.add(t);
  for (const t of gateDrivenAdditions(step)) tools.add(t);
  if (normalizeScriptRefs(step.onExit).length > 0) tools.add('run_script');
  for (const t of ARTIFACT_DRAWER_TOOLS) tools.add(t);
  return { kind, path: stepDeliverablePath(step), tools };
}

/**
 * The repair surface for a gate-rejected step. Extends the scenario
 * repair set with the execution channel for data kinds — without
 * `derive_file`/`run_nodejs_script`, a data-repair turn is stranded
 * hand-typing rows (the exact failure transform-by-execution exists
 * to prevent).
 */
export function gateRepairToolsForKind(kind: DeliverableKind | null): ReadonlySet<string> {
  const base = new Set<string>(FILE_CORE);
  for (const t of ARTIFACT_DRAWER_TOOLS) base.add(t);
  if (kind === 'data-file' || kind === 'json') {
    base.add('derive_file');
    base.add('run_nodejs_script');
    base.add('make_dir');
  }
  if (kind === 'code-module' || kind === 'code-with-tests') {
    base.add('run_nodejs_script');
    base.add('apply_patch');
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
    return ['derive_file', 'run_nodejs_script', 'read_file', 'write_file', 'validate'];
  }
  if (kind === 'code-module' || kind === 'code-with-tests') {
    return ['read_file', 'write_file', 'replace_in_file', 'run_nodejs_script', 'validate'];
  }
  if (kind === 'image-set') {
    return ['generate_image', 'render_image', 'list_dir', 'write_file'];
  }
  return [
    'write_file',
    'write_artifact',
    'read_file',
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
