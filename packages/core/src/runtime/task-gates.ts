import type { WorkspaceLike } from '../checks/types.js';
import { unresolvedGatePlaceholders } from '../gate-config.js';
import {
  GATE_DEFAULT_MAX_ATTEMPTS,
  type GateCheck,
  type GateScriptRef,
  normalizeStepGate,
} from '../schemas/gate.js';
import { type Task, type TaskCraftbookStep, taskEffectiveStatus } from '../schemas/task.js';
import { stepOwnerGezelId } from '../task-execution.js';
import {
  type GateWorkspaceReader,
  SHARED_GATE_CHECK_KINDS,
  type SharedGateCheck,
  evaluateDeclarativeCheck,
  formatGateVerdict,
  isSharedGateCheck,
  locateMissingGateFiles,
} from '../tasks/gate-checks.js';
import { evaluateGateScripts } from '../tasks/gate-scripts.js';
import { completionGateWorkspaceFiles } from '../tasks/gate-workspace-files.js';
import type { PortableStore } from './store.js';
import type { PortableTaskGateResult } from './tasks.js';

/**
 * The declarative checks this host runs. The regex kinds run in the bounded
 * standard `checkContains` script, never on the UI thread, where a
 * pathological pattern could freeze the app.
 */
export const PORTABLE_GATE_CHECK_KINDS: readonly string[] = [
  ...SHARED_GATE_CHECK_KINDS,
  'contains',
  'notContains',
];

/** A regex check as the standard script that evaluates it, with the desktop's flags. */
export function patternCheckScript(check: GateCheck): GateScriptRef | undefined {
  if (check.kind !== 'contains' && check.kind !== 'notContains') return undefined;
  return {
    scope: 'standard',
    name: 'checkContains',
    inputs: {
      file: check.file,
      pattern: check.pattern,
      flags: check.flags ?? '',
      ...(check.label ? { label: check.label } : {}),
      ...(check.artifact ? { artifact: true } : {}),
      ...(check.kind === 'notContains' ? { absent: true } : {}),
    },
  };
}

export type PortableGateScript = (
  ref: GateScriptRef,
  task: Task,
  step: TaskCraftbookStep,
) => Promise<{ id?: string; status: string; output?: unknown; error?: string; logs?: string }>;

function tree(
  store: PortableStore,
  projectId: string,
  area: 'workspace' | 'artifacts',
): WorkspaceLike {
  return {
    read: (path) => store.readFile(area, projectId, path),
    readBytes: (path) => store.readFileBytes(area, projectId, path),
    list: async () => {
      const listing = await store.listFiles(area, projectId, '', true, { includeHidden: true });
      if (listing.truncated) throw new Error('This gate needs a complete file listing');
      return listing.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);
    },
  };
}

/** Both trees of a project, in the shape the shared checks read. */
function reader(store: PortableStore, projectId: string): GateWorkspaceReader {
  const workspace = tree(store, projectId, 'workspace');
  const artifacts = tree(store, projectId, 'artifacts');
  return {
    ...workspace,
    readArtifact: artifacts.read,
    listArtifacts: artifacts.list,
    readArtifactBytes: artifacts.readBytes!,
  };
}

/** Same deterministic predicates as desktop and stdlib; scripts never bypass a
 * failed declarative floor. This evaluator does not mutate task progression. */
export async function evaluatePortableTaskGate(
  store: PortableStore,
  task: Task,
  step: TaskCraftbookStep,
  runScript?: PortableGateScript,
): Promise<PortableTaskGateResult> {
  try {
    const gate = step.gate ? normalizeStepGate(step.gate) : undefined;
    if (gate && (gate.at !== 'completion' || gate.reviewer))
      throw new Error('This gate needs desktop review or activation behavior');
    const checks: GateCheck[] = [...(gate?.checks ?? [])];
    if (step.advanceWhen) {
      if (step.advanceWhen.requireChange)
        throw new Error('Change-tracking gates require desktop execution');
      const { file, artifact, minBytes = 1, sniff: kind } = step.advanceWhen;
      checks.push({ kind: 'minBytes', file, artifact, bytes: minBytes });
      if (kind) checks.push({ kind: 'sniff', file, artifact, sniff: kind });
    }
    const unresolved = unresolvedGatePlaceholders({
      at: 'completion',
      legacy: false,
      maxAttempts: gate?.maxAttempts ?? GATE_DEFAULT_MAX_ATTEMPTS,
      checks,
      scripts: gate?.scripts ?? [],
    });
    if (unresolved.length)
      throw new Error(
        `Gate configuration error: ${unresolved.join(', ')} still contains an unresolved template placeholder. Correct the craftbook or launch parameters; writing to the literal placeholder cannot satisfy this gate.`,
      );
    const ws = reader(store, task.projectId);
    // Every check runs and every failure is reported, as on the desktop: a
    // missing file reads as "0 bytes" to one check and "not found" to the next.
    const failures: string[] = [];
    for (const item of checks) {
      const script = patternCheckScript(item);
      if (script) {
        if (!runScript) throw new Error(`The ${item.kind} gate requires the script executor`);
        const run = await runScript(script, task, step);
        if (run.status !== 'ok')
          throw new Error(`The ${item.kind} gate could not run: ${run.error ?? 'unknown error'}`);
        const verdict = run.output as { decision?: unknown; message?: unknown } | undefined;
        if (verdict?.decision !== 'approve')
          failures.push(
            typeof verdict?.message === 'string'
              ? verdict.message
              : `${String(script.inputs?.file)} did not pass`,
          );
        continue;
      }
      // Executable syntax checks belong in bounded QuickJS, not the UI
      // thread. Unsupported declarative checks fail closed here.
      if (!isSharedGateCheck(item))
        throw new Error(`The ${item.kind} gate requires a supported script or desktop execution`);
      const result = await evaluateDeclarativeCheck(item, ws);
      if (!result.ok) failures.push(result.detail);
    }
    if (failures.length)
      return {
        approved: false,
        message: formatGateVerdict([...(await locateMissingGateFiles(checks, ws)), ...failures]),
      };
    const scripts = await evaluateGateScripts(
      gate?.scripts ?? [],
      (ref) => {
        if (!runScript) throw new Error('This gate requires the script executor');
        return runScript(ref, task, step);
      },
      { steps: task.craftbook.steps },
    );
    if (scripts.infrastructureError)
      return {
        approved: false,
        infrastructureError: true,
        message: scripts.message ?? 'The completion gate could not run.',
        ...(scripts.runs.length ? { scriptRuns: scripts.runs } : {}),
      };
    if (scripts.decision === 'reject')
      return { approved: false, message: scripts.message, next: scripts.goto };
    return { approved: true, next: scripts.goto, handoff: scripts.handoff };
  } catch (error) {
    return {
      approved: false,
      infrastructureError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Mid-turn twin of the step's end-of-turn advance: true once the active
 * step's workspace `advanceWhen` file passes the same floor the runner
 * applies after the turn, for the step this session's gezel still owns,
 * and every other workspace file the completion gate reads exists. The
 * local loop reads it to stop a finished step before the iteration cap.
 */
export async function portableDeliverableReady(
  store: PortableStore,
  ref: string,
  stepId: string,
  gezelId: string,
): Promise<boolean> {
  const task = await store.getTask(ref);
  if (!task || taskEffectiveStatus(task) !== 'active' || task.activeStepId !== stepId) return false;
  const step = task.craftbook.steps.find((item) => item.id === stepId);
  const advance = step?.advanceWhen;
  if (!step || !advance || advance.artifact || advance.requireChange) return false;
  if (stepOwnerGezelId(task, step) !== gezelId) return false;
  const ws = reader(store, task.projectId);
  const checks: SharedGateCheck[] = [
    { kind: 'minBytes', file: advance.file, bytes: advance.minBytes ?? 1 },
    ...(advance.sniff
      ? [{ kind: 'sniff' as const, file: advance.file, sniff: advance.sniff }]
      : []),
  ];
  for (const check of checks) {
    if (!(await evaluateDeclarativeCheck(check, ws)).ok) return false;
  }
  const gate = step.gate ? normalizeStepGate(step.gate) : undefined;
  if (gate?.at !== 'completion') return true;
  for (const file of completionGateWorkspaceFiles(gate.checks, advance.file)) {
    if ((await store.readFile('workspace', task.projectId, file)) === null) return false;
  }
  return true;
}
