import type { Question } from '@bendyline/gezel';

/**
 * The TUI currently handles plain model-authored questions. Specialized
 * approval intents keep their purpose-built desktop forms.
 */
export function plainPendingQuestions(questions: ReadonlyArray<Question>): Question[] {
  return questions
    .filter((question) => !question.answer && !question.intent)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Fold a question SSE event into the TUI's oldest-first pending queue. */
export function updatePendingQuestion(
  questions: ReadonlyArray<Question>,
  question: Question,
): Question[] {
  const withoutCurrent = questions.filter((candidate) => candidate.id !== question.id);
  return plainPendingQuestions(question.answer ? withoutCurrent : [...withoutCurrent, question]);
}
