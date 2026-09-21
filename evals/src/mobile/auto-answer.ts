import type { Question } from '@bendyline/gezel';
import { createAutoAnswerPoller } from '../auto-answer.ts';
import type { MobileTrial } from './report.ts';

export type MobileAutoAnswer = {
  kind: 'answerQuestion' | 'sendChatMessage';
  gezelId: string;
  projectId: string;
  sessionId: string;
  questionId?: string;
  question: string;
  body: Record<string, unknown>;
};

/** Only ordinary product questions; never consent, installation, or native UI. */
export function isOrdinaryEvalQuestion(question: Question): boolean {
  if (question.intent) return false;
  return !/\b(?:download|install)\b.{0,80}\b(?:model|gguf|package|app)\b|\b(?:approve|allow|consent|enable|confirm)\b.{0,80}\b(?:privacy|network access|camera|microphone|location|model download)\b/i.test(
    [question.prompt, ...(question.choices ?? [])].join('\n'),
  );
}

export class MobileAutoAnswerer {
  private trial!: MobileTrial;
  private actions: MobileAutoAnswer[] = [];
  private logs: string[] = [];
  private readonly poll: () => Promise<void>;
  constructor(meesterId: string) {
    const retained = (id: string) => {
      const session = this.trial.sessions.find((item) => item.id === id);
      if (!session) throw new Error('Auto-answer session is outside the native snapshot');
      return session;
    };
    const client = {
      listQuestions: async () => ({
        questions: (this.trial.questions ?? []).filter(
          (q) =>
            !q.answer &&
            isOrdinaryEvalQuestion(q) &&
            this.trial.sessions.some(
              (s) => s.id === q.sessionId && s.projectId === q.projectId && s.gezelId === q.gezelId,
            ),
        ),
      }),
      answerQuestion: async (id: string, body: Record<string, unknown>) => {
        const question = this.trial.questions?.find((q) => q.id === id);
        if (!question || !isOrdinaryEvalQuestion(question))
          throw new Error('Unsupported auto-answer question');
        retained(question.sessionId);
        this.actions.push({
          kind: 'answerQuestion',
          questionId: id,
          question: question.prompt,
          gezelId: question.gezelId,
          projectId: question.projectId,
          sessionId: question.sessionId,
          body,
        });
        return {};
      },
      listChatSessions: async (filter: { gezelId?: string; projectId?: string }) => ({
        sessions: this.trial.sessions.filter(
          (s) =>
            (!filter.gezelId || s.gezelId === filter.gezelId) &&
            (!filter.projectId || s.projectId === filter.projectId) &&
            isOrdinaryEvalQuestion({ prompt: s.messages.at(-1)?.content ?? '' } as Question),
        ),
      }),
      getChatSession: async (id: string) => retained(id),
      sendChatMessage: async (gezelId: string, body: Record<string, unknown>) => {
        const session = this.trial.sessions
          .filter((s) => s.gezelId === gezelId && s.projectId === body.projectId && !s.archived)
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
        if (!session || gezelId !== meesterId || body.projectId !== 'default')
          throw new Error('Inline auto-answer requires the retained Meester front-door session');
        const question = session.messages.at(-1)?.content ?? '';
        if (!isOrdinaryEvalQuestion({ prompt: question } as Question))
          throw new Error('Inline confirmation requires the user');
        this.actions.push({
          kind: 'sendChatMessage',
          gezelId,
          projectId: session.projectId,
          sessionId: session.id,
          question,
          body,
        });
        return {};
      },
    };
    this.poll = createAutoAnswerPoller({
      client: client as unknown as Parameters<typeof createAutoAnswerPoller>[0]['client'],
      meesterId,
      now: () => Date.parse(String(this.trial.snapshotAt)),
      log: (line) => this.logs.push(line),
    });
  }
  async plan(trial: MobileTrial) {
    if (!Array.isArray(trial.inflight) || trial.inflight.length)
      throw new Error('Auto-answer requires an explicitly idle native snapshot');
    if (!Number.isFinite(Date.parse(String(trial.snapshotAt))))
      throw new Error('Auto-answer requires a native snapshot timestamp');
    this.trial = trial;
    this.actions = [];
    this.logs = [];
    await this.poll();
    return { actions: this.actions, logs: this.logs };
  }
}
