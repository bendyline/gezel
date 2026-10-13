/**
 * What a craftbook step tells the local turn loop, for the desktop and the
 * phone alike: the step the anti-spin guidance names, and, for a step whose
 * outcome is one exact action, the tool whose success ends the turn and how
 * the request narrows to reach it.
 */

import type { ActiveCraftbookStep, TerminalToolPolicy } from '../local-loop/provider-contract.js';
import { stepOnEnterProducesAdvanceFile } from '../schemas/craftbook.js';
import { normalizeStepGate } from '../schemas/gate.js';
import { normalizeScriptRefs } from '../schemas/script.js';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import type { ResolvedTuning } from '../tuning-resolve.js';
import { withInferredConsumes } from './inferred-step-inputs.js';

/**
 * `evidence`: the step's whole job is a fixed read the gate counts.
 * `checkpoint`: the step ends on one `write_artifact` the gate judges.
 */
export type StepTurnAction = 'evidence' | 'checkpoint';

export interface StepTurnSteering {
  activeStep: Omit<ActiveCraftbookStep, 'deliverableReady'>;
  /**
   * True when the step advances on a workspace file the model writes, so a
   * host can tell the loop mid-turn that the deliverable is ready.
   */
  workspaceDeliverable: boolean;
  action?: StepTurnAction;
  terminalToolPolicy?: TerminalToolPolicy;
}

export function stepTurnSteering(
  task: Pick<Task, 'executionMode' | 'craftbook'>,
  rawStep: TaskCraftbookStep,
): StepTurnSteering {
  const step = withInferredConsumes(task, rawStep);
  // Lists run in order; the LAST onExit ref's output drives branch
  // routing, so that's the one the anti-spin corrective names.
  const exitRefs = normalizeScriptRefs(step.onExit);
  const lastExit = exitRefs[exitRefs.length - 1];
  const activeStep: StepTurnSteering['activeStep'] = {
    name: step.name,
    ...(lastExit?.name ? { onExitScriptName: lastExit.name } : {}),
    ...(step.advanceWhen?.file ? { deliverableFile: step.advanceWhen.file } : {}),
    ...(step.advanceWhen?.artifact ? { deliverableIsArtifact: true } : {}),
    ...(step.consumes?.length
      ? {
          requiredInputs: step.consumes.map((input) => ({
            path: input.file,
            artifact: input.artifact === true,
          })),
        }
      : {}),
  };
  // Workspace deliverables only: an artifact checkpoint already ends the
  // turn on its write, and a file the step's onEnter hook wrote proves
  // nothing about the model's work.
  const workspaceDeliverable = Boolean(
    step.advanceWhen?.file && !step.advanceWhen.artifact && !stepOnEnterProducesAdvanceFile(step),
  );
  const gate = step.gate ? normalizeStepGate(step.gate) : undefined;
  const evidence =
    step.toolPolicy?.outputMedium === 'none' &&
    (step.toolPolicy.allowTools?.length ?? 0) > 0 &&
    gate?.at === 'completion' &&
    gate.checks.length > 0 &&
    gate.checks.every(
      (check) => check.kind === 'corpusReadEvidence' || check.kind === 'artifactReadEvidence',
    ) &&
    gate.scripts.length === 0;
  const checkpoint =
    step.toolPolicy?.outputMedium === 'artifact' &&
    step.advanceWhen?.artifact === true &&
    gate?.at === 'completion';
  if (!evidence && !checkpoint) return { activeStep, workspaceDeliverable };
  // The completion gate, not another generation, decides whether the action
  // was sufficient. Ending the loop on its first successful exact action
  // avoids five identical reads (and five full prefills) before the gate
  // gets to judge the durable evidence.
  return {
    activeStep,
    workspaceDeliverable,
    action: evidence ? 'evidence' : 'checkpoint',
    terminalToolPolicy: {
      toolNames: evidence ? [...step.toolPolicy!.allowTools!] : ['write_artifact'],
      fallbackText: evidence ? 'Assigned records opened.' : 'Checkpoint written for validation.',
      maxClosingChars: 120,
      ...(checkpoint && step.advanceWhen?.file
        ? { onlyWhenArgEquals: { arg: 'path', value: step.advanceWhen.file } }
        : {}),
    },
  };
}

/**
 * The request shape for a step's exact action. An evidence read is a
 * mechanical invocation, not a reasoning task: dual-mode local models
 * otherwise spend the whole thinking budget explaining the read and finish
 * without calling it. A checkpoint may need real reasoning, but its outcome
 * is the artifact write, so only the outcome shape is constrained.
 */
export function tuningForStepAction(
  tuning: ResolvedTuning,
  action: StepTurnAction,
): ResolvedTuning {
  if (action === 'checkpoint') return { ...tuning, toolChoice: 'required' };
  return {
    ...tuning,
    sampling: {
      ...tuning.sampling,
      maxTokens: Math.min(tuning.sampling.maxTokens ?? 512, 512),
    },
    reasoning: {
      ...tuning.reasoning,
      enableThinking: false,
      thinkingBudget: undefined,
    },
    toolChoice: 'required',
  };
}
