import type { StepRunWhen } from './schemas/craftbook.js';
import type { Question } from './schemas/question.js';

/**
 * Whether a `runWhen` step runs, decided from the owner's recorded answer
 * rather than by a model turn. The newest answered question the `answerOf`
 * step asked on this task is the one that counts: a review that looped back
 * for revisions asks again, and only the last answer reflects what the owner
 * finally wanted.
 */
export interface RunWhenVerdict {
  run: boolean;
  /** Plain-language reason, written to the task note when the step is skipped. */
  reason: string;
}

export function runWhenVerdict(
  runWhen: StepRunWhen,
  questions: readonly Question[],
  taskRef: string,
): RunWhenVerdict {
  const answered = questions
    .filter(
      (q) =>
        q.taskRef === taskRef &&
        q.stepId === runWhen.answerOf &&
        !q.intent &&
        q.answer &&
        !q.answer.declined &&
        !q.answer.silentSkip,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const latest = answered.at(-1);
  if (!latest?.answer) {
    return runWhen.onMissing === 'skip'
      ? { run: false, reason: 'no answer was recorded for it' }
      : { run: true, reason: 'no answer was recorded, so it runs' };
  }
  const picked = new Set(
    (latest.answer.selectedChoices ?? [])
      .map((index) => latest.choices?.[index]?.trim().toLowerCase())
      .filter((choice): choice is string => Boolean(choice)),
  );
  const wanted = runWhen.choiceAnyOf?.find((choice) => picked.has(choice.trim().toLowerCase()));
  if (wanted) return { run: true, reason: `the owner chose "${wanted}"` };
  const writeIn = latest.answer.writeIn?.trim() ?? '';
  if (runWhen.writeInMatches && writeIn && safeRegExp(runWhen.writeInMatches)?.test(writeIn)) {
    return { run: true, reason: 'the owner asked for it in their reply' };
  }
  return { run: false, reason: "the owner's answer did not ask for it" };
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}
