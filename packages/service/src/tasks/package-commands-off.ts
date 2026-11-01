/**
 * Whether a step can prove its work while package scripts are off. A
 * `commandEvidence` check passes only on a receipt from `run_package_script`
 * or `run_npx`, and the security policy removes both from every session when
 * `allowPackageScriptExecution` is off, which `lockdown` does. The sibling of
 * writes-off-deliverables.ts, for commands instead of files.
 *
 * Wild-caught (DGX Spark scorecard, 2026-10-28): every bug-fix-tdd,
 * codemod-sweep and refactor-module trial stopped on its first such step. The
 * gate kept telling the model to run `npm run test` with a tool it did not
 * have, and each trial looped 11 to 71 minutes before anything stopped it.
 */
import {
  type GateCheck,
  type NormalizedStepGate,
  type Task,
  type TaskCraftbookStep,
  normalizeStepGate,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { gateCheckLabel } from './gate-eval.js';
import type { StepGateOutcome } from './step-gate.js';

type PolicyReader = Pick<Store, 'readConfig'>;
type CommandEvidenceCheck = Extract<GateCheck, { kind: 'commandEvidence' }>;

/** The Settings label people turn on; keep it equal to the toggle in SecurityComplianceSettings.tsx. */
export const PACKAGE_SCRIPTS_SETTING_LABEL = 'Run package scripts';

/**
 * The commands a newly activated step must see run, when no session may run
 * them. Only checks scoped to this activation count: a task-wide check can
 * still pass on a run from before the policy changed.
 */
export async function unrunnableStepCommands(
  store: PolicyReader,
  task: Pick<Task, 'diffpackId'>,
  step: Pick<TaskCraftbookStep, 'gate'>,
): Promise<string[] | null> {
  if (!step.gate) return null;
  const checks = normalizeStepGate(step.gate).checks.filter(
    (c): c is CommandEvidenceCheck =>
      c.kind === 'commandEvidence' && c.window !== 'task' && !deferredWhileDrafting(task, c),
  );
  if (checks.length === 0) return null;
  if (await packageScriptsAllowed(store)) return null;
  return commandsOf(checks);
}

/** The failing command checks of a rejected gate, when no session may run them. */
export async function unrunnableGateCommands(
  store: PolicyReader,
  task: Pick<Task, 'diffpackId'>,
  gate: NormalizedStepGate,
  outcome: StepGateOutcome,
): Promise<string[] | null> {
  const failing = new Set((outcome.checkResults ?? []).filter((r) => !r.ok).map((r) => r.label));
  const checks = gate.checks.filter(
    (c): c is CommandEvidenceCheck =>
      c.kind === 'commandEvidence' &&
      failing.has(gateCheckLabel(c)) &&
      !deferredWhileDrafting(task, c),
  );
  if (checks.length === 0) return null;
  if (await packageScriptsAllowed(store)) return null;
  return commandsOf(checks);
}

/** The task note that explains the pause; `attempted` says whether the step ran. */
export function packageCommandsOffNote(
  step: Pick<TaskCraftbookStep, 'id' | 'name'>,
  commands: readonly string[],
  attempted: boolean,
): string {
  const list = commands.map((c) => `\`${c}\``).join(', ');
  const consequence = attempted
    ? 'No completion attempt was consumed.'
    : 'The step was not started.';
  return `# Step needs package scripts — task paused\n\nStep "${step.name}" (\`${step.id}\`) proves its work by running ${list}, but "${PACKAGE_SCRIPTS_SETTING_LABEL}" is off in Settings → Security & Compliance, so no gezel can run it. ${consequence}\n\nTo continue, turn on "${PACKAGE_SCRIPTS_SETTING_LABEL}", then set the task active again. Package scripts run outside the script sandbox, as your account, with network access, which is why the stricter security levels keep them off.`;
}

/** One line for the needs-help notice. */
export function packageCommandsOffDetail(
  step: Pick<TaskCraftbookStep, 'name'>,
  commands: readonly string[],
): string {
  return `Step "${step.name}" must run ${commands.join(', ')}, but "${PACKAGE_SCRIPTS_SETTING_LABEL}" is off.`;
}

async function packageScriptsAllowed(store: PolicyReader): Promise<boolean> {
  return resolveSecurityPolicy(await store.readConfig()).allowPackageScriptExecution;
}

/** A drafting task's command gate passes as an honest deferral unless the book opts out. */
function deferredWhileDrafting(task: Pick<Task, 'diffpackId'>, check: CommandEvidenceCheck) {
  return !!task.diffpackId && check.onDraft !== 'require';
}

function commandsOf(checks: readonly CommandEvidenceCheck[]): string[] {
  return [
    ...new Set(
      checks.map((c) => {
        const args = c.args && c.args.length > 0 ? ` ${c.args.join(' ')}` : '';
        return c.script ? `npm run ${c.script}${args}` : `npx ${c.bin ?? '?'}${args}`;
      }),
    ),
  ];
}
