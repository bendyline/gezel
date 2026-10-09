import { setTimeout as wait } from 'node:timers/promises';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { startAutoAnswerer } from '../auto-answer.ts';
import { type QualificationBoundary, digest } from './boundary.ts';
import type { QualificationOptions } from './config.ts';

export async function pollScriptedUser(args: {
  client: GezelClient;
  boundary: QualificationBoundary;
  options: QualificationOptions;
  meesterId: string;
}): Promise<void> {
  const { client, boundary, options } = args;
  const { questions } = await client.listQuestions({ pending: true });
  // A task-finished card is an informational notification, not a request for assistance.
  const pending: Array<{
    id: string;
    prompt: string;
    kind: 'structured' | 'inline';
    intentKind?: string;
    choices: string[];
    reply: (answer: { writeIn: string } | { selectedChoices: number[] }) => Promise<unknown>;
  }> = questions
    .filter((q) => q.intent?.kind !== 'task-finished')
    .map((q) => ({
      id: q.id,
      prompt: q.prompt,
      kind: 'structured',
      choices: q.choices ?? [],
      intentKind: q.intent?.kind,
      reply: (answer) => client.answerQuestion(q.id, answer),
    }));
  const { sessions } = await client.listChatSessions();
  for (const latest of sessions.filter((s) => !s.archived)) {
    const session = await client.getChatSession(latest.id);
    const last = session.messages.at(-1);
    if (
      last?.role === 'assistant' &&
      typeof last.content === 'string' &&
      last.content.trim().endsWith('?') &&
      Date.now() - new Date(last.at).getTime() >= 30_000 &&
      !(await client.getChatSessionInflight(latest.id)).inflight
    ) {
      pending.push({
        id: `${latest.id}:${last.at}`,
        prompt: last.content.trim(),
        kind: 'inline',
        choices: [],
        reply: (answer) =>
          client.sendToChatSession(latest.id, {
            message: 'writeIn' in answer ? answer.writeIn : '',
          }),
      });
    }
  }
  for (const question of pending) {
    if (boundary.observedQuestions.has(question.id)) continue;
    const index =
      options.userSimulation === 'scripted'
        ? options.userScript.findIndex(
            (entry, i) =>
              !boundary.usedScriptEntries.has(i) &&
              entry.kind === question.kind &&
              entry.prompt === question.prompt &&
              entry.intentKind === question.intentKind &&
              ('writeIn' in entry.answer || question.choices.includes(entry.answer.choice)),
          )
        : -1;
    if (index < 0) {
      boundary.observedQuestions.add(question.id);
      boundary.record({
        source: 'simulated-user',
        reason: 'no-scripted-answer',
        method: question.kind,
        target: question.id,
        payloadHash: digest(question.prompt),
        status: 'unanswered',
      });
      continue;
    }
    const entry = options.userScript[index]!;
    await boundary.run('simulated-user', `script-entry:${index}`, () =>
      question.reply(
        'writeIn' in entry.answer
          ? entry.answer
          : { selectedChoices: [question.choices.indexOf(entry.answer.choice)] },
      ),
    );
    boundary.usedScriptEntries.add(index);
    boundary.observedQuestions.add(question.id);
  }
}

export function startUserSimulation(
  args: Parameters<typeof pollScriptedUser>[0] & {
    log: (line: string) => void;
    signal?: AbortSignal;
  },
): () => Promise<void> {
  if (args.options.userSimulation === 'heuristic') {
    return args.boundary.run('simulated-user', 'legacy-heuristic', () => startAutoAnswerer(args));
  }
  let stopped = false;
  const loop = (async () => {
    while (!stopped && !args.signal?.aborted) {
      try {
        await pollScriptedUser(args);
      } catch {
        args.boundary.record({
          source: 'simulated-user',
          reason: 'observation-failed',
          method: 'observe',
          target: null,
          payloadHash: digest(null),
          status: 'failed',
        });
        args.log('[qualification] user observation failed; will retry');
      }
      for (let i = 0; i < 20 && !stopped && !args.signal?.aborted; i++) await wait(250);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}
