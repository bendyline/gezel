/**
 * What it means to ask a question, to answer one, and to list the ones
 * still waiting: the decisions both hosts make about a `Question` record,
 * separated from how each host stores it.
 *
 * Asking dedupes against the session's outstanding card, so a gezel that
 * re-asks a reworded question every turn does not stack cards. Answering is
 * idempotent, so a stale UI submitting twice changes nothing. Validation is
 * optional because the desktop also carries intent questions (approvals,
 * installs) whose answer shapes belong to those flows.
 */
import { outstandingSessionQuestion } from './question-format.js';
import {
  type AnswerQuestionRequest,
  AnswerQuestionRequestSchema,
  type AskQuestionRequest,
} from './schemas/api.js';
import { type Question, type QuestionAnswer, QuestionSchema } from './schemas/question.js';

export interface QuestionIdentity {
  id: string;
  at: string;
}

/** A request shaped into a record: empty choice lists dropped, unset options omitted. */
export function newQuestion(input: AskQuestionRequest, identity: QuestionIdentity): Question {
  if (input.allowWriteIn === false && !input.choices?.length)
    throw new Error('Provide choices when written answers are disabled');
  return QuestionSchema.parse({
    id: identity.id,
    projectId: input.projectId,
    gezelId: input.gezelId,
    sessionId: input.sessionId,
    prompt: input.prompt,
    ...(input.choices && input.choices.length > 0 ? { choices: input.choices } : {}),
    ...(input.allowWriteIn !== undefined ? { allowWriteIn: input.allowWriteIn } : {}),
    ...(input.multiSelect !== undefined ? { multiSelect: input.multiSelect } : {}),
    ...(input.taskRef ? { taskRef: input.taskRef } : {}),
    ...(input.documentPath ? { documentPath: input.documentPath } : {}),
    createdAt: identity.at,
  });
}

/**
 * The session's outstanding plain question if it has one, else a new record.
 * `deduped` tells the caller nothing was created.
 */
export function resolveAsk(
  existing: readonly Question[],
  input: AskQuestionRequest,
  identity: QuestionIdentity,
): { question: Question; deduped: boolean } {
  const outstanding = outstandingSessionQuestion(existing, input.sessionId);
  if (outstanding) return { question: outstanding, deduped: true };
  const question = newQuestion(input, identity);
  if (existing.some((q) => q.id === question.id))
    throw new Error('Question identifier already exists');
  return { question, deduped: false };
}

/** An answer request shaped into the stored answer: empties dropped, stamped. */
export function normalizeQuestionAnswer(raw: AnswerQuestionRequest, at: string): QuestionAnswer {
  const body = AnswerQuestionRequestSchema.parse(raw);
  return {
    ...(body.selectedChoices && body.selectedChoices.length > 0
      ? { selectedChoices: body.selectedChoices }
      : {}),
    ...(body.writeIn ? { writeIn: body.writeIn } : {}),
    ...(body.declined ? { declined: true } : {}),
    ...(body.silentSkip ? { silentSkip: true } : {}),
    ...(body.npmInstallDecisions && body.npmInstallDecisions.length > 0
      ? { npmInstallDecisions: body.npmInstallDecisions }
      : {}),
    at,
  };
}

/** Refuse an answer the question cannot accept. */
export function assertAnswerFitsQuestion(question: Question, answer: QuestionAnswer): void {
  const choices = answer.selectedChoices ?? [];
  if (
    new Set(choices).size !== choices.length ||
    choices.some((index) => index >= (question.choices?.length ?? 0))
  )
    throw new Error('Choose an option from this question');
  if (!question.multiSelect && choices.length > 1) throw new Error('Choose only one option');
  if (question.allowWriteIn === false && answer.writeIn?.trim())
    throw new Error('This question does not accept written answers');
  if (answer.writeIn && answer.writeIn.length > 128_000) throw new Error('This answer is too long');
  if (!answer.silentSkip && !answer.declined && !choices.length && !answer.writeIn?.trim())
    throw new Error('Select an option or write an answer');
}

/** The question with its answer recorded; unchanged when it already had one. */
export function answeredQuestion(
  question: Question,
  raw: AnswerQuestionRequest,
  at: string,
  options: { validate?: boolean } = {},
): Question {
  if (question.answer) return question;
  const answer = normalizeQuestionAnswer(raw, at);
  if (options.validate) assertAnswerFitsQuestion(question, answer);
  return QuestionSchema.parse({ ...question, answer });
}

export function pendingQuestions(questions: readonly Question[]): Question[] {
  return questions.filter((question) => !question.answer);
}

export function sortQuestionsNewestFirst(questions: readonly Question[]): Question[] {
  return [...questions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findQuestion(questions: readonly Question[], id: string): Question | undefined {
  return questions.find((question) => question.id === id);
}
