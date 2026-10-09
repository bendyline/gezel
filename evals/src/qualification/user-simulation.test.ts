import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QualificationBoundary } from './boundary.ts';
import type { QualificationOptions } from './config.ts';
import { pollScriptedUser } from './user-simulation.ts';

describe('explicit simulated user', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-user-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const prompt = 'Allow the command?';
  const question = {
    id: 'q1',
    prompt,
    choices: ['Allow', 'Deny'],
    intent: { kind: 'command-approval' },
  };
  function setup(options: QualificationOptions) {
    const answer = vi.fn(async () => ({}));
    const client = {
      listQuestions: async () => ({ questions: [question] }),
      listChatSessions: async () => ({ sessions: [] }),
      answerQuestion: answer,
    } as unknown as GezelClient;
    const boundary = new QualificationBoundary(dir, 'runtime');
    return { args: { client, boundary, options, meesterId: 'frontdoor' }, answer };
  }
  it('disabled means zero answers, with an unanswered request recorded once', async () => {
    const { args, answer } = setup({
      userSimulation: 'disabled',
      userScript: [],
      completionTimeoutMs: 100,
    });
    await pollScriptedUser(args);
    await pollScriptedUser(args);
    expect(answer).not.toHaveBeenCalled();
    expect(args.boundary.interventions.map((e) => e.status)).toEqual(['unanswered']);
  });
  it('preserves an exact scripted denial and does not reuse it after restart', async () => {
    const { args, answer } = setup({
      userSimulation: 'scripted',
      completionTimeoutMs: 100,
      userScript: [
        { kind: 'structured', prompt, intentKind: 'command-approval', answer: { choice: 'Deny' } },
      ],
    });
    await pollScriptedUser(args);
    const restarted = {
      ...args,
      client: {
        ...args.client,
        listQuestions: async () => ({ questions: [{ ...question, id: 'q2' }] }),
      } as unknown as GezelClient,
    };
    await pollScriptedUser(restarted);
    expect(answer).toHaveBeenCalledExactlyOnceWith('q1', { selectedChoices: [1] });
    expect(args.boundary.usedScriptEntries.has(0)).toBe(true);
    expect(args.boundary.interventions.at(-1)?.status).toBe('unanswered');
  });
  it('does not approve a permission question from a script without its exact intent', async () => {
    const { args, answer } = setup({
      userSimulation: 'scripted',
      completionTimeoutMs: 100,
      userScript: [{ kind: 'structured', prompt, answer: { choice: 'Allow' } }],
    });
    await pollScriptedUser(args);
    expect(answer).not.toHaveBeenCalled();
  });
});
