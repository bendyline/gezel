import { normalizeStepGate } from '../schemas/gate.js';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';

/**
 * Entry preface: a fresh-launch gezel has never seen this task before, so
 * before the "you've been assigned" line it is oriented with the craftbook
 * the task came from and the full step arc. The per-step procedure lives in
 * the system prompt; this is the bird's-eye "what is this task and where
 * does my step sit in it" the seed otherwise lacks. Only for the `entry`
 * kind — handoff recipients inherit the same system-prompt context and the
 * prior gezels' notes (and a generalist task carries a Task outline on every
 * turn), so they don't need it re-stated.
 */
export function renderEntryPreface(task: Task, dispatchStepId: string): string {
  const cb = task.craftbook;
  const stepArc = cb.steps
    .map((s, i) => {
      const here = s.id === dispatchStepId ? ' ← your step' : '';
      const desc = s.description?.trim() ? ` — ${s.description.trim()}` : '';
      return `${i + 1}. ${s.name}${desc}${here}`;
    })
    .join('\n');
  const cbDesc = cb.description?.trim() ? ` ${cb.description.trim()}` : '';
  return `Task ${task.ref} ("${task.title}") was just created from the **${cb.name}** craftbook.${cbDesc}\n\nIts steps:\n${stepArc}\n\n`;
}

export interface StepDispatchSeedInput {
  /** `entry` is a fresh launch, `retry` a user-requested retry; handoff otherwise. */
  kind?: 'handoff' | 'entry' | 'retry';
  task: Task | null | undefined;
  taskRef: string;
  stepId: string;
  /** The previous step was this gezel's too (always, for a generalist task). */
  selfHandoff: boolean;
  /** Who handed the step over, already resolved for the naming mode. */
  fromGezelDisplayName?: string;
  /** The session is the one a restarted service is continuing. */
  resumedExisting: boolean;
  /** Artifacts this task already wrote, named for a resumed session. */
  persistedArtifacts?: readonly string[];
}

export interface StepDispatchSeed {
  seed: string;
  dispatchStep: TaskCraftbookStep | undefined;
  /** The step ends on one exact durable action the runtime then evaluates. */
  requiresExactOutcome: boolean;
  /** The step advances once its artifact checkpoint is written and passes. */
  artifactCheckpointOutcome: boolean;
}

/**
 * The first message a gezel receives for a craftbook step. Shared by every
 * host that runs steps, so a book tuned on the desktop is started the same
 * way on a phone.
 */
export function buildStepDispatchSeed(input: StepDispatchSeedInput): StepDispatchSeed {
  const { task: taskRecord, taskRef, stepId: dispatchStepId } = input;
  const entryPreface =
    input.kind === 'entry' && taskRecord ? renderEntryPreface(taskRecord, dispatchStepId) : '';
  const generalistTask = taskRecord?.executionMode === 'generalist';
  // Seed wording: deliberately does NOT name `read_task_notes` as the
  // first action. The system prompt already carries the step procedure
  // and (for gated steps) a recency anchor that tells the model the
  // FIRST tool to call — and explicitly says "Do NOT call
  // `read_task_notes` to find the procedure; it's in the prompt above."
  // The old seed mandated `read_task_notes` first, which head-on
  // contradicted that anchor; a small/verbose model can't arbitrate two
  // opposite "first move" instructions and spends the turn deliberating
  // (then aborts on the ramble cap before any tool fires). So the seed
  // now defers to the in-prompt instructions and leaves note-reading to
  // the model's judgement (it's only needed on a resume / loop-back).
  const fromGezelDisplayName = input.fromGezelDisplayName;
  // What has this task already put on disk? A restart mid-batch is the
  // moment a model most needs to know that its own partial deliverable
  // survived — otherwise its only recovery is to re-read every source
  // record, which is precisely the loop that cannot converge when the
  // evidence is larger than any replay budget. Naming the artifacts turns
  // "read all 25 records again" into "read back what I already wrote and
  // continue from there".
  const written = input.persistedArtifacts ?? [];
  const persistedWork =
    input.resumedExisting && written.length > 0
      ? ` ${[
          `You have already written these artifacts for this task: ${written
            .map((f) => `\`${f}\``)
            .join(', ')}.`,
          'Read them back with `read_artifact` before re-reading any source — they hold the work',
          'you already did, and continuing them is cheaper and more reliable than reconstructing it.',
          'Persist each finding as you go rather than holding every source in your head;',
          'that is what makes a restart cheap.',
        ].join(' ')}`
      : '';
  const dispatchStep = taskRecord?.craftbook.steps.find((step) => step.id === dispatchStepId);
  const explicitOutputMedium = dispatchStep?.toolPolicy?.outputMedium;
  const additionalOutputMedia = dispatchStep?.toolPolicy?.additionalOutputMedia ?? [];
  const secondaryClause =
    additionalOutputMedia.length > 0
      ? ` The procedure also authorizes secondary output in: ${additionalOutputMedia.join(', ')}; those writes do not substitute for the primary result.`
      : '';
  const progressClause =
    explicitOutputMedium === 'workspace'
      ? ` Persist the primary result to the workspace path named by the procedure.${secondaryClause}`
      : explicitOutputMedium === 'artifact'
        ? ` Persist the primary result to the artifacts-drawer path named by the procedure.${secondaryClause}`
        : explicitOutputMedium === 'task-note'
          ? ` Persist the primary result with \`write_task_note\`.${secondaryClause}`
          : explicitOutputMedium === 'none'
            ? ' This step has no persisted output; inspect or route as instructed without creating a file, artifact, or task note.'
            : ' Append focused notes with `write_task_note` as you go.';
  // A tiny fixed-action entry step is especially vulnerable to the
  // generic seed's final "advance when done" sentence: local instruct
  // models sometimes jump straight to the completion tool without doing
  // the one read/routing action in the system band. Repeat only this
  // bounded procedure at the END of the user-visible seed, where recency
  // makes the required first action unambiguous. Larger/output-producing
  // steps keep the non-duplicated prompt.
  const exactStepAutoAdvances =
    (dispatchStep?.toolPolicy?.allowTools?.length ?? 0) > 0 &&
    !dispatchStep?.toolPolicy?.allowTools?.includes('advance_task_step');
  const dispatchGate = dispatchStep?.gate ? normalizeStepGate(dispatchStep.gate) : undefined;
  const fixedEvidenceOutcome =
    dispatchStep?.toolPolicy?.outputMedium === 'none' &&
    dispatchGate?.at === 'completion' &&
    dispatchGate.checks.length > 0 &&
    dispatchGate.checks.every(
      (check) => check.kind === 'corpusReadEvidence' || check.kind === 'artifactReadEvidence',
    ) &&
    dispatchGate.scripts.length === 0;
  const artifactCheckpointOutcome =
    dispatchStep?.toolPolicy?.outputMedium === 'artifact' &&
    dispatchStep.advanceWhen?.artifact === true &&
    dispatchGate?.at === 'completion';
  const requiresExactOutcome = fixedEvidenceOutcome || artifactCheckpointOutcome;
  const completionClause = exactStepAutoAdvances
    ? ' The runtime evaluates the declared evidence after your required action and advances the step when it passes; `advance_task_step` is intentionally unavailable.'
    : " When the step is done, call `advance_task_step` to hand off to whoever's next.";
  const fixedEntryProcedure =
    input.kind === 'entry' &&
    explicitOutputMedium === 'none' &&
    (dispatchStep?.toolPolicy?.allowTools?.length ?? 0) > 0 &&
    dispatchStep?.prompt?.trim()
      ? `\n\nFIXED-ACTION ENTRY — call the procedure's named tool now. The runtime will end this turn and evaluate its durable evidence after the first successful action; do not narrate, repeat the call, or call \`advance_task_step\`:\n${dispatchStep.prompt.trim()}`
      : '';
  const retrySeed =
    exactStepAutoAdvances && dispatchStep?.prompt?.trim()
      ? `Task ${taskRef} is still active on fixed-action step \`${dispatchStepId}\`. The previous provider turn failed before its required action completed. Call the procedure's named tool now; the runtime will evaluate its durable evidence and advance automatically. Do not call \`read_task_notes\` or \`advance_task_step\` — neither is available on this exact step:\n\n${dispatchStep.prompt.trim()}`
      : `You paused on step \`${dispatchStepId}\` of task ${taskRef}, and the user has asked you to try again. Call \`read_task_notes\` first — the newest note says why it stopped. Then take a DIFFERENT approach to the same deliverable instead of repeating the attempt that failed, and call \`advance_task_step\` when it is done. If it still cannot work, say exactly what you need with \`ask_user_question\` rather than going quiet.`;
  const generalistClause = generalistTask
    ? " The Task outline in your prompt shows where this step sits in the whole task; only the active step's procedure is in force now."
    : '';
  const seed =
    input.kind === 'retry'
      ? retrySeed
      : input.resumedExisting
        ? `The service restarted while task ${taskRef} was still active on step \`${dispatchStepId}\`. Your earlier tool results are restored above, each marked \`[recovered from an earlier turn]\` — treat those as already read and do NOT read them again. Some may be missing or marked TRUNCATED: if a source is larger than what can be restored, do NOT keep re-reading everything hoping it all lands at once — work through the remainder in small groups, writing what you conclude after each group so progress survives the next restart.${persistedWork}${progressClause}${completionClause}`
        : input.kind === 'entry'
          ? `${entryPreface}You've been assigned task ${taskRef} (step \`${dispatchStepId}\`). Follow the step instructions already in your prompt — start with the first tool call they name, then keep working through the procedure.${progressClause}${completionClause}${fixedEntryProcedure}`
          : input.selfHandoff
            ? `Task ${taskRef} has advanced to the next step — \`${dispatchStepId}\`, which is yours as well.${generalistClause} Please continue: follow the step instructions already in your prompt — start with the first tool call they name, then keep working through the procedure.${progressClause}${completionClause}`
            : `${
                fromGezelDisplayName
                  ? `${fromGezelDisplayName} has`
                  : 'The previous step has been completed and'
              } handed step \`${dispatchStepId}\` of task ${taskRef} to you. Follow the step instructions already in your prompt — start with the first tool call they name, then keep working through the procedure.${progressClause}${completionClause}`;
  return { seed, dispatchStep, requiresExactOutcome, artifactCheckpointOutcome };
}
