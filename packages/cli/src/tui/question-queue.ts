import type { Question } from '@bendyline/gezel';
import { canAnswerQuestionInTui } from './question-presentation.js';

/**
 * Questions the terminal can answer, oldest first. Approval intents must stay
 * in this queue: several providers synchronously wait for the answer, so
 * dropping one leaves the gezel paused with no visible way to continue.
 */
export function pendingQuestionsForTui(questions: ReadonlyArray<Question>): Question[] {
  return questions
    .filter((question) => !question.answer && canAnswerQuestionInTui(question))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Fold a question SSE event into the TUI's oldest-first pending queue. */
export function updatePendingQuestion(
  questions: ReadonlyArray<Question>,
  question: Question,
): Question[] {
  const withoutCurrent = questions.filter((candidate) => candidate.id !== question.id);
  return pendingQuestionsForTui(question.answer ? withoutCurrent : [...withoutCurrent, question]);
}
