import { randomUUID } from 'node:crypto';
import {
  type Question,
  type ReferencedFile,
  type StepAwaitsOwnerIntent,
  type Task,
  type TaskCraftbookStep,
  createLogger,
  nowIso,
  parseTaskRef,
} from '@bendyline/gezel';
import { previewableArtifact } from './completion-wrapup.js';
import { type FigureReview, renderFigureReview } from './figure-review.js';
import type { TaskManager } from './manager.js';

const log = createLogger('tasks');

/**
 * Owner steps — review, approval, sign-off — belong to the person, never to a
 * gezel. A Meester-authored book once gave "Owner Review" to a gezel role; a
 * model did the review and advanced the task, and a missing deliverable went
 * through. The runtime now dispatches no one for these steps, so this card is
 * how the owner learns one is waiting, and their answer is how it moves.
 */

export const OWNER_STEP_APPROVE = 'Approve';

/** Most files a review card names; the task page has the rest. */
const REVIEW_MAX_FILES = 5;

/**
 * What the owner is asked to look at: the files earlier steps were gated on,
 * nearest first, then everything else the task has made. A normalized owner
 * step no longer runs the book's own review procedure, so nothing else puts
 * the work in front of the person approving it.
 */
export function filesUnderReview(
  task: Task,
  step: TaskCraftbookStep,
  outputs: readonly ReferencedFile[],
): ReferencedFile[] {
  const at = task.craftbook.steps.findIndex((s) => s.id === step.id);
  const earlier = (at < 0 ? [] : task.craftbook.steps.slice(0, at)).reverse();
  const key = (file: ReferencedFile) => `${file.kind}:${file.path}`;
  const made = new Map(outputs.map((file) => [key(file), file]));
  const lead: ReferencedFile[] = [];
  for (const s of earlier) {
    const gated = s.advanceWhen?.file;
    if (!gated) continue;
    const file = made.get(
      key({ kind: s.advanceWhen?.artifact ? 'artifact' : 'workspace', path: gated }),
    );
    if (file && !lead.includes(file)) lead.push(file);
  }
  return [...lead, ...outputs.filter((file) => !lead.includes(file))];
}

/** The card that tells the owner a step is waiting for them. */
export function ownerStepQuestion(opts: {
  task: Task;
  step: TaskCraftbookStep;
  returnTo?: TaskCraftbookStep;
  askerGezelId: string;
  /** What the task has made so far (`loadTaskOutputs`). */
  outputs?: readonly ReferencedFile[];
  /** What checking those files' numbers found (`reviewTaskFigures`). */
  figures?: FigureReview | null;
}): Question {
  const { task, step, returnTo } = opts;
  const intent: StepAwaitsOwnerIntent = {
    kind: 'step-awaits-owner',
    taskRef: task.ref,
    stepId: step.id,
    ...(returnTo ? { returnToStepId: returnTo.id } : {}),
  };
  const sendBack = returnTo
    ? `, or write what should change and it goes back to "${returnTo.name}"`
    : ', or write what should change';
  const head = `**${step.name}** on "${task.title}" is waiting for you.`;
  const choose = `Choose ${OWNER_STEP_APPROVE} to continue${sendBack}.`;
  const files = filesUnderReview(task, step, opts.outputs ?? []);
  const shown = files.slice(0, REVIEW_MAX_FILES);
  const more = files.length - shown.length;
  const checks = renderFigureReview(opts.figures, 'Before you approve, check:');
  const prompt =
    shown.length === 0
      ? `${head} ${choose}`
      : [
          head,
          '',
          'To review:',
          '',
          ...shown.map((file) =>
            file.kind === 'artifact'
              ? `- \`${file.path}\``
              : `- \`${file.path}\` (in the project folder)`,
          ),
          ...(more > 0 ? [`- …and ${more} more`] : []),
          ...(checks.length > 0 ? ['', ...checks] : []),
          '',
          choose,
        ].join('\n');
  const preview = previewableArtifact(files);
  return {
    id: randomUUID(),
    projectId: task.projectId,
    gezelId: opts.askerGezelId,
    // No live session: the answer acts on the task directly.
    sessionId: '',
    prompt,
    choices: [OWNER_STEP_APPROVE],
    allowWriteIn: true,
    multiSelect: false,
    taskRef: task.ref,
    ...(preview ? { documentPath: preview } : {}),
    intent,
    createdAt: nowIso(),
  };
}

export type OwnerStepAnswerResult = 'approved' | 'sent-back' | 'noted' | 'stale' | 'skipped';

/**
 * Apply the owner's answer. Approve completes the step as the owner (their
 * approval is the gate). A written reply without Approve becomes a note on
 * the step under review, and the task goes back to it. A card for a step that
 * is no longer active changes nothing.
 */
export async function answerOwnerStep(
  tasks: Pick<TaskManager, 'get' | 'appendNote' | 'completeStepChecked'>,
  question: Question,
): Promise<OwnerStepAnswerResult> {
  const intent = question.intent;
  if (intent?.kind !== 'step-awaits-owner') return 'skipped';
  const answer = question.answer;
  if (!answer || answer.declined || answer.silentSkip) return 'skipped';
  const ref = parseTaskRef(intent.taskRef);
  if (!ref) return 'stale';
  const task = await tasks.get(ref.projectId, ref.num).catch(() => null);
  if (!task || task.status !== 'active' || task.activeStepId !== intent.stepId) return 'stale';

  const approved = (answer.selectedChoices ?? []).includes(0);
  const feedback = answer.writeIn?.trim() ?? '';
  if (approved) {
    if (feedback) {
      await tasks.appendNote(ref.projectId, ref.num, {
        text: feedback,
        author: { kind: 'user' },
        stepId: intent.stepId,
      });
    }
    await tasks.completeStepChecked(ref.projectId, ref.num, intent.stepId, undefined, {
      force: true,
      cause: 'user',
    });
    return 'approved';
  }
  if (!feedback) return 'skipped';
  const target = intent.returnToStepId;
  await tasks.appendNote(ref.projectId, ref.num, {
    text: `The owner asked for changes: ${feedback}`,
    author: { kind: 'user' },
    ...(target ? { stepId: target } : { stepId: intent.stepId }),
  });
  if (!target) return 'noted';
  await tasks.completeStepChecked(ref.projectId, ref.num, intent.stepId, target, {
    force: true,
    cause: 'user',
  });
  log.info(`[tasks] ${task.ref} owner sent "${intent.stepId}" back to "${target}"`);
  return 'sent-back';
}
