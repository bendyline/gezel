import { resolveTuning } from '@bendyline/gezel-inference/internal/model-profile/tuning';
import { MlxProvider } from '@bendyline/gezel-inference/internal/providers/mlx/provider';
import type { LLMSession } from '@bendyline/gezel-inference/internal/providers/types';
import { afterEach, describe, expect, it } from 'vitest';

// Pull Request Review on qwen3.8-27b, 2026-11-17: every generation spent the
// whole 4,096-token thinking budget, gate-repair turns included, and the two
// admitted shards ran strictly one generation at a time behind the drafter.

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  })}\n\n`;
}

function sse(...frames: string[]): Response {
  return new Response(`${frames.join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const READ_CALL =
  '<tool_call>\n<function=read_artifact>\n<parameter=path>\na.md\n</parameter>\n</function>\n</tool_call>';

const sessions: LLMSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

async function startSession(responses: Array<() => Response>, thinkingBudget?: number) {
  const requests: Array<Record<string, unknown>> = [];
  const provider = new MlxProvider({
    baseUrl: 'http://engine.test',
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return (responses.shift() ?? (() => sse(chunk({ content: 'Done.' }, 'stop'))))();
    }) as typeof fetch,
  });
  const session = await provider.createSession({
    systemMessage: 'system',
    tuning: resolveTuning({
      catalog: {
        reasoning: {
          enableThinking: true,
          ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
        },
      },
    }),
  });
  sessions.push(session);
  (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
    isEmpty: () => false,
    getOpenAITools: () => [
      {
        name: 'read_artifact',
        description: 'Read an artifact',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
    hasTool: (name: string) => name === 'read_artifact',
    hasCallableRestriction: () => false,
    isRestrictedFromCalling: () => false,
    callTool: async () => 'contents of a.md',
    stop: async () => {},
  };
  return { session, requests };
}

describe('MLX reduced-thinking turn', () => {
  it('sends the reduced budget on every request of the turn, then the normal one', async () => {
    const { session, requests } = await startSession(
      [
        () => sse(chunk({ content: READ_CALL }, 'stop')),
        () => sse(chunk({ content: 'Rewritten.' }, 'stop')),
        () => sse(chunk({ content: 'Next.' }, 'stop')),
      ],
      4096,
    );

    await session.sendAndWait('The gate rejected it.', { reducedThinking: true });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.max_thinking_tokens)).toEqual([1024, 1024]);

    await session.sendAndWait('Carry on.');
    expect(requests[2]?.max_thinking_tokens).toBe(4096);
  });

  it('leaves a model with no thinking budget alone', async () => {
    const { session, requests } = await startSession([
      () => sse(chunk({ content: 'Rewritten.' }, 'stop')),
    ]);

    await session.sendAndWait('The gate rejected it.', { reducedThinking: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('max_thinking_tokens');
  });
});

describe('MLX task-session width', () => {
  it('asks for one task session at a time when a speculative drafter is armed', () => {
    const provider = new MlxProvider({
      baseUrl: 'http://engine.test',
      batchMaxConcurrency: 3,
      speculativeDrafter: true,
    });
    expect(provider.batch).toEqual({ maxConcurrency: 3, taskConcurrency: 1 });
    // Chats and a turn's own one-shots keep their lanes.
    expect(provider.queue.interactiveConcurrency).toBe(3);
    expect(provider.queue.backgroundConcurrency).toBe(2);
  });

  it('declares no task width without a drafter', () => {
    const provider = new MlxProvider({ baseUrl: 'http://engine.test', batchMaxConcurrency: 3 });
    expect(provider.batch).toEqual({ maxConcurrency: 3 });
    expect(provider.queue.backgroundConcurrency).toBe(2);
  });
});
