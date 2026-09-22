import type { WorkspaceLike } from '../checks/types.js';
import { unresolvedGatePlaceholders } from '../gate-config.js';
import {
  GATE_DEFAULT_MAX_ATTEMPTS,
  type GateCheck,
  type GateScriptRef,
  normalizeStepGate,
} from '../schemas/gate.js';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import {
  type GateWorkspaceReader,
  evaluateDeclarativeCheck,
  isSharedGateCheck,
} from '../tasks/gate-checks.js';
import { evaluateGateScripts } from '../tasks/gate-scripts.js';
import type { PortableStore } from './store.js';
import type { PortableTaskGateResult } from './tasks.js';

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
    for (const item of checks) {
      // Regex and executable syntax checks belong in bounded QuickJS, not the
      // UI thread. Unsupported declarative checks fail closed here.
      if (!isSharedGateCheck(item))
        throw new Error(`The ${item.kind} gate requires a supported script or desktop execution`);
      const result = await evaluateDeclarativeCheck(item, ws);
      if (!result.ok) return { approved: false, message: result.detail };
    }
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
