import {
  MANAGED_WORKSPACE_WRITE_SETTING_LABEL,
  type NormalizedStepGate,
  PROJECT_EDITS_CLI_COMMAND,
  type Task,
  type TaskCraftbookStep,
  createLogger,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { GateHoldInfo, TaskManager } from './manager.js';
import {
  packageCommandsOffDetail,
  packageCommandsOffNote,
  unrunnableGateCommands,
  unrunnableStepCommands,
} from './package-commands-off.js';
import { type StepGateOutcome, gateMessageFingerprint } from './step-gate.js';
import {
  unsatisfiableStepWorkspaceFiles,
  unsatisfiableWorkspaceGateFiles,
} from './writes-off-deliverables.js';

/**
 * A step no assignee can satisfy under the current policy pauses its task for
 * a person instead of spending turns or gate attempts on it. Two moments ask:
 * activation, before anyone is dispatched, and a completion-gate rejection,
 * before it is charged. Which workspace files and commands are out of reach
 * is decided in writes-off-deliverables.ts and package-commands-off.ts; this
 * module owns the pause, its note, and the needs-help notice.
 */

const log = createLogger('tasks');

type PausingTasks = Pick<TaskManager, 'setStatus' | 'appendNote' | 'emitNeedsHelp'>;
type PolicyReader = Pick<Store, 'readConfig' | 'getProject' | 'readProjectWorkspaceFile'>;

interface Blocker {
  /** The task note: what is out of reach and how a person unblocks it. */
  note: string;
  /** One line for the needs-help notice. */
  detail: string;
  logLine: string;
}

// The command comes first: a task started from a terminal has no Project →
// Settings to open, and `gezel do` prints this line when it finds it here.
const WRITES_OFF_FIXES = `- Allow it: run \`${PROJECT_EDITS_CLI_COMMAND}\` in the project's folder, or enable "${MANAGED_WORKSPACE_WRITE_SETTING_LABEL}" in Project → Settings.\n- Change the step's deliverable to the artifacts drawer (\`artifact: true\`, written with \`write_artifact\`) — the drawer stays writable when workspace writes are off.`;

/**
 * Pause a task whose newly-activated step owes a workspace file nobody may
 * write, or a command nobody may run, and report why. Returns true when the
 * caller must skip the handoff — dispatching a gezel here cannot succeed.
 */
export async function pauseIfStepUnsatisfiable(
  tasks: PausingTasks,
  store: PolicyReader,
  projectId: string,
  task: Task,
  step: Pick<TaskCraftbookStep, 'id' | 'name' | 'advanceWhen' | 'gate'>,
): Promise<boolean> {
  const commands = await unrunnableStepCommands(store, task, step);
  if (commands) {
    await pauseBlockedStep(tasks, projectId, task, step.id, {
      note: packageCommandsOffNote(step, commands, false),
      detail: packageCommandsOffDetail(step, commands),
      logLine: `[tasks] ${task.ref} step "${step.id}" needs ${commands.join(', ')} but package scripts are off — pausing instead of dispatching`,
    });
    return true;
  }
  const files = await unsatisfiableStepWorkspaceFiles(store, projectId, task, step);
  if (!files) return false;
  const fileList = files.map((f) => `\`${f}\``).join(', ');
  await pauseBlockedStep(tasks, projectId, task, step.id, {
    // The first sentence is what `gezel do --wait` prints, so it has to say
    // the whole problem in plain words and fit on a line or two.
    note: `# Step unsatisfiable — task paused\n\nStep "${step.name}" (\`${step.id}\`) must write ${fileList} into the project folder, and Gezel may not change files in this project. Managed workspace writes are OFF, so no task assignee has \`write_file\`, and nobody was started on the step.\n\nFix one of these, then set the task active again:\n\n${WRITES_OFF_FIXES}\n- Create the file(s) by hand and re-run the step.`,
    detail: `Step "${step.name}" must write workspace ${fileList}, but managed workspace writes are off for this project.`,
    logLine: `[tasks] ${task.ref} step "${step.id}" targets workspace ${fileList} but workspace writes are off — pausing instead of dispatching`,
  });
  return true;
}

/**
 * The pre-flight before a completion-gate rejection is charged. A rejection
 * no assignee can repair under current policy must not burn the attempt
 * budget or climb the nudge ladder toward tools nobody has: a workspace-tree
 * check failing while gezel workspace writes are OFF for the project, or a
 * command the step must see run while package scripts are off (the rejection
 * names `run_package_script`, which no session has, so a retry can only
 * repeat it). Pause like a gate-infrastructure failure — no attempt consumed,
 * a note naming the real cause and the real fixes — instead of charging the
 * budget and then demanding `write_file` from a roster it was stripped from.
 *
 * `recordVerdict` writes the gate's history event, after the pause and
 * before the needs-help notice. Returns null when the rejection is repairable.
 */
export async function holdUnsatisfiableGate(
  tasks: PausingTasks,
  store: PolicyReader,
  args: {
    projectId: string;
    task: Task;
    step: TaskCraftbookStep;
    gate: NormalizedStepGate;
    outcome: StepGateOutcome;
    attempt: number;
    recordVerdict: () => Promise<void>;
  },
): Promise<{ task: Task; info: GateHoldInfo } | null> {
  const { projectId, task, step, gate, outcome } = args;
  let message: string;
  let blocker: Blocker;
  const files = await unsatisfiableWorkspaceGateFiles(store, projectId, task, step, gate, outcome);
  if (files) {
    const fileList = files.length > 0 ? files.map((f) => `\`${f}\``).join(', ') : 'files';
    message = `This gate cannot be met right now: it requires workspace ${fileList} to change, but managed workspace writes are OFF for this project. The task is paused for a human decision; do not retry. See the task notes for the fixes.`;
    blocker = {
      note: `# Gate unsatisfiable — task paused\n\nStep "${step.name}" (\`${step.id}\`) is checked against ${fileList} in the project folder, and Gezel may not change files in this project. Managed workspace writes are OFF, so no task assignee can create or edit workspace files and retrying cannot succeed. No completion attempt was consumed.\n\nFix one of these, then set the task active again:\n\n${WRITES_OFF_FIXES}\n- Create or fix the file(s) by hand from the content in task notes.`,
      detail: `The gate requires workspace ${fileList}, but managed workspace writes are off for this project.`,
      logLine: `[gate] ${task.ref} step "${step.id}" gate is unsatisfiable (workspace writes off) — pausing without consuming an attempt`,
    };
  } else {
    const commands = await unrunnableGateCommands(store, task, gate, outcome);
    if (!commands) return null;
    message = `This gate cannot be met right now: it needs ${commands.join(', ')} to run, and running package scripts is off in the security settings. The task is paused for a human decision; do not retry.`;
    blocker = {
      note: packageCommandsOffNote(step, commands, true),
      detail: packageCommandsOffDetail(step, commands),
      logLine: `[gate] ${task.ref} step "${step.id}" needs ${commands.join(', ')} but package scripts are off — pausing without consuming an attempt`,
    };
  }
  const paused = await pauseBlockedStep(tasks, projectId, task, step.id, blocker, {
    recordVerdict: args.recordVerdict,
    // Activation already paused and reported an unwinnable step; the caller
    // still gets the verdict, but one blocked step must not raise a second
    // needs-help.
    needsHelp: task.status !== 'paused',
  });
  return {
    task: paused,
    info: {
      message,
      messageFingerprint: gateMessageFingerprint(message),
      attempt: args.attempt,
      maxAttempts: gate.maxAttempts,
      paused: true,
      cached: false,
      unsatisfiable: true,
      ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
    },
  };
}

async function pauseBlockedStep(
  tasks: PausingTasks,
  projectId: string,
  task: Task,
  stepId: string,
  blocker: Blocker,
  opts: { recordVerdict?: () => Promise<void>; needsHelp?: boolean } = {},
): Promise<Task> {
  const paused = await tasks
    .setStatus(projectId, task.num, 'paused')
    .catch(() => ({ ...task, status: 'paused' as const }));
  await tasks
    .appendNote(projectId, task.num, { text: blocker.note, author: { kind: 'user' }, stepId })
    .catch(() => {});
  log.warn(blocker.logLine);
  await opts.recordVerdict?.();
  if (opts.needsHelp ?? true) {
    await tasks.emitNeedsHelp({
      projectId,
      task,
      stepId,
      reason: 'gate_unsatisfiable',
      detail: blocker.detail,
    });
  }
  return paused;
}
