import { z } from 'zod';
import { assertSafeEntityId } from '../entity-id.js';
import { formatAnswerSeed } from '../question-format.js';
import {
  answeredQuestion as applyAnswer,
  findQuestion,
  pendingQuestions,
  resolveAsk,
  sortQuestionsNewestFirst,
} from '../question-policy.js';
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
  const questions =
    (await repo.tolerantRecord(
      questionPath(projectId),
      z.array(QuestionSchema),
      `questions for ${projectId}`,
    )) ?? [];
  if (questions.some((question) => question.projectId !== projectId))
    throw new Error('Question does not belong to its project');
  return questions;
}
export async function listQuestions(repo: PortableRepository, filter: PortableQuestionFilter = {}) {
  const ids = filter.projectId ? [filter.projectId] : (await listProjects(repo)).map((p) => p.id);
  const questions: Question[] = [];
  for (const id of ids) questions.push(...(await projectQuestions(repo, id)));
  return sortQuestionsNewestFirst(filter.pending ? pendingQuestions(questions) : questions);
}
export async function getQuestion(repo: PortableRepository, id: string): Promise<Question | null> {
  assertSafeEntityId(id, 'question id');
  return findQuestion(await listQuestions(repo), id) ?? null;
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
  if (input.documentPath) validatePortablePath(input.documentPath);
  const questions = await projectQuestions(repo, input.projectId);
  const { question, deduped } = resolveAsk(questions, input, {
    id: repo.createId(),
    at: repo.now(),
  });
  if (deduped) return { question, deduped };
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
  // Two answer shapes belong to desktop-only flows and cannot be honoured here.
  if (question.intent) throw new Error('This approval requires a desktop host');
  if (AnswerQuestionRequestSchema.parse(raw).npmInstallDecisions)
    throw new Error('Package approvals are unavailable on this host');
  return applyAnswer(question, raw, at, { validate: true });
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
