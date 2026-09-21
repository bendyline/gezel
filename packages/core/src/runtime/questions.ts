import { z } from 'zod';
import { assertSafeEntityId } from '../entity-id.js';
import { formatAnswerSeed, outstandingSessionQuestion } from '../question-format.js';
import {
  type AnswerQuestionRequest,
  AnswerQuestionRequestSchema,
  type AskQuestionRequest,
  AskQuestionRequestSchema,
} from '../schemas/api.js';
import { type Question, QuestionSchema } from '../schemas/question.js';
import { type ChatSession, ChatSessionSchema } from '../schemas/session.js';
import { validatePortablePath } from './files.js';
import { listProjects, projectRoot, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';
import { getSession, sessionPath } from './sessions.js';
import { getTask } from './tasks.js';

export interface PortableQuestionFilter {
  projectId?: string;
  pending?: boolean;
}
const questionPath = (id: string) => `${projectRoot(id)}/questions.json`;
async function projectQuestions(repo: PortableRepository, projectId: string): Promise<Question[]> {
  await requireProject(repo, projectId);
  const questions = (await repo.record(questionPath(projectId), z.array(QuestionSchema))) ?? [];
  if (questions.some((question) => question.projectId !== projectId))
    throw new Error('Question does not belong to its project');
  return questions;
}
export async function listQuestions(repo: PortableRepository, filter: PortableQuestionFilter = {}) {
  const ids = filter.projectId ? [filter.projectId] : (await listProjects(repo)).map((p) => p.id);
  const questions: Question[] = [];
  for (const id of ids) questions.push(...(await projectQuestions(repo, id)));
  return questions
    .filter((q) => !filter.pending || !q.answer)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getQuestion(repo: PortableRepository, id: string): Promise<Question | null> {
  assertSafeEntityId(id, 'question id');
  return (await listQuestions(repo)).find((q) => q.id === id) ?? null;
}
export async function askQuestion(repo: PortableRepository, raw: AskQuestionRequest) {
  const input = AskQuestionRequestSchema.parse(raw);
  const session = await getSession(repo, input.gezelId, input.sessionId);
  if (
    !session ||
    session.projectId !== input.projectId ||
    (input.taskRef && session.taskRef && input.taskRef !== session.taskRef)
  )
    throw new Error('Question context must match its conversation');
  if (input.taskRef && (await getTask(repo, input.taskRef))?.projectId !== input.projectId)
    throw new Error('The attached task must belong to this project');
  if (input.allowWriteIn === false && !input.choices?.length)
    throw new Error('Provide choices when written answers are disabled');
  if (input.documentPath) validatePortablePath(input.documentPath);
  const questions = await projectQuestions(repo, input.projectId);
  const existing = outstandingSessionQuestion(questions, input.sessionId);
  if (existing) return { question: existing, deduped: true };
  const question = QuestionSchema.parse({ ...input, id: repo.createId(), createdAt: repo.now() });
  if (questions.some((q) => q.id === question.id))
    throw new Error('Question identifier already exists');
  await repo.transactions.commit(
    new Map([[questionPath(input.projectId), repo.json([...questions, question])]]),
  );
  return { question, deduped: false };
}
export function answeredQuestion(
  question: Question,
  raw: AnswerQuestionRequest,
  at: string,
): Question {
  if (question.intent) throw new Error('This approval requires a desktop host');
  const answer = AnswerQuestionRequestSchema.parse(raw);
  if (answer.npmInstallDecisions) throw new Error('Package approvals are unavailable on this host');
  const choices = answer.selectedChoices ?? [];
  if (
    new Set(choices).size !== choices.length ||
    choices.some((i) => i >= (question.choices?.length ?? 0))
  )
    throw new Error('Choose an option from this question');
  if (!question.multiSelect && choices.length > 1) throw new Error('Choose only one option');
  if (question.allowWriteIn === false && answer.writeIn?.trim())
    throw new Error('This question does not accept written answers');
  if (answer.writeIn && answer.writeIn.length > 128_000) throw new Error('This answer is too long');
  if (!answer.silentSkip && !answer.declined && !choices.length && !answer.writeIn?.trim())
    throw new Error('Select an option or write an answer');
  return QuestionSchema.parse({ ...question, answer: { ...answer, at } });
}
/** The answer and its continuation message commit together. A crash cannot
 * acknowledge an answer while losing the user's reply, or replay it on retry. */
export async function answerQuestion(
  repo: PortableRepository,
  id: string,
  raw: AnswerQuestionRequest,
  continuation?: ChatSession,
): Promise<Question> {
  const current = await getQuestion(repo, id);
  if (!current) throw new Error('Question not found');
  if (current.answer) return current;
  const question = answeredQuestion(current, raw, repo.now());
  const writes = new Map<string, Uint8Array>();
  if (!question.answer!.silentSkip) {
    if (!continuation) throw new Error('Answer requires its conversation continuation');
    const session = ChatSessionSchema.parse(continuation);
    const saved = await getSession(repo, question.gezelId, question.sessionId);
    const last = session.messages.at(-1);
    if (
      !saved ||
      session.id !== question.sessionId ||
      session.gezelId !== question.gezelId ||
      session.projectId !== question.projectId ||
      !session.turnStartedAt ||
      last?.role !== 'user' ||
      last.content !== formatAnswerSeed(question) ||
      session.messages.length !== saved.messages.length + 1 ||
      JSON.stringify(session.messages.slice(0, -1)) !== JSON.stringify(saved.messages)
    )
      throw new Error('Answer continuation does not match its conversation');
    writes.set(sessionPath(session.gezelId, session.id), repo.json(session));
  } else if (continuation) throw new Error('Skipping a question must not start a response');
  const questions = await projectQuestions(repo, question.projectId);
  writes.set(
    questionPath(question.projectId),
    repo.json(questions.map((q) => (q.id === id ? question : q))),
  );
  await repo.transactions.commit(writes);
  return question;
}
