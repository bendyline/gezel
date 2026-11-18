import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel } from '../log.js';
import { resolveTuning } from '../tuning-resolve.js';
import {
  REDUCED_THINKING_FLOOR_TOKENS,
  applyReducedThinkingBudget,
  reducedThinkingBudget,
} from './reasoning-budget.js';
import { ExternalLlamaServer } from './test-utils/external-llama-server.js';

function sseResponse(events: Array<unknown>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const ev of events) {
        const payload = ev === '[DONE]' ? '[DONE]' : JSON.stringify(ev);
        ctrl.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const answer = (text: string) =>
  sseResponse([
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, finish_reason: 'stop' }] },
    '[DONE]',
  ]);

const readCall = () =>
  sseResponse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'read_artifact', arguments: JSON.stringify({ path: 'a.md' }) },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);

describe('reducedThinkingBudget', () => {
  it('is a quarter of the normal budget', () => {
    expect(reducedThinkingBudget(4096)).toBe(1024);
    expect(reducedThinkingBudget(16384)).toBe(4096);
  });

  it('stops at the floor and never raises a budget already below it', () => {
    expect(reducedThinkingBudget(1024)).toBe(REDUCED_THINKING_FLOOR_TOKENS);
    expect(reducedThinkingBudget(600)).toBe(REDUCED_THINKING_FLOOR_TOKENS);
    expect(reducedThinkingBudget(256)).toBe(256);
  });
});

describe('applyReducedThinkingBudget', () => {
  it('lowers the budget a request carries and reports the change', () => {
    const body: Record<string, unknown> = { max_thinking_tokens: 4096 };
    expect(applyReducedThinkingBudget(body, 'max_thinking_tokens')).toEqual({
      from: 4096,
      to: 1024,
    });
    expect(body.max_thinking_tokens).toBe(1024);
  });

  it('leaves a request with no budget, or one it cannot lower, as it was', () => {
    const none: Record<string, unknown> = { temperature: 0.7 };
    expect(applyReducedThinkingBudget(none, 'reasoning_budget_tokens')).toBeNull();
    expect(none).toEqual({ temperature: 0.7 });

    const small: Record<string, unknown> = { reasoning_budget_tokens: 256 };
    expect(applyReducedThinkingBudget(small, 'reasoning_budget_tokens')).toBeNull();
    expect(small.reasoning_budget_tokens).toBe(256);
  });
});

describe('a reduced-thinking turn on llama.cpp', () => {
  const originalLevel = getLogLevel();
  afterEach(() => {
    setLogLevel(originalLevel);
    vi.restoreAllMocks();
  });

  async function startSession(
    responses: Array<() => Response>,
    thinkingBudget: number | undefined,
    shape: 'chat-template' | 'deepseek' = 'chat-template',
  ) {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new ExternalLlamaServer({
      baseUrl: 'http://llama.test',
      disableThinkingRequestShape: shape,
      fetchImpl: (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return (responses.shift() ?? (() => answer('Done.')))();
      }) as typeof fetch,
    });
    const session = await provider.createSession({
      systemMessage: 'You are a test.',
      tuning: resolveTuning({
        catalog: {
          reasoning: {
            enableThinking: true,
            ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
          },
        },
      }),
    });
    (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_artifact', description: 'read', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_artifact',
      callTool: async () => 'contents of a.md',
    };
    return { provider, session, requests };
  }

  it('sends the reduced budget on every request of the turn, then the normal one', async () => {
    setLogLevel('info');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { provider, session, requests } = await startSession(
      [readCall, () => answer('Rewritten.'), () => answer('Next.')],
      4096,
    );
    try {
      expect(await session.sendAndWait('The gate rejected it.', { reducedThinking: true })).toBe(
        'Rewritten.',
      );
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.reasoning_budget_tokens)).toEqual([1024, 1024]);

      expect(await session.sendAndWait('Carry on.')).toBe('Next.');
      expect(requests[2]?.reasoning_budget_tokens).toBe(4096);

      const logged = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(logged.match(/reduced thinking budget for this turn/g)).toHaveLength(1);
      expect(logged).toContain('budget=4096 → 1024');
    } finally {
      await provider.shutdown();
    }
  });

  it('leaves a model with no thinking budget alone', async () => {
    const { provider, session, requests } = await startSession(
      [() => answer('Rewritten.')],
      undefined,
    );
    try {
      await session.sendAndWait('The gate rejected it.', { reducedThinking: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty('reasoning_budget_tokens');
    } finally {
      await provider.shutdown();
    }
  });

  it('keeps an eval-pinned budget ahead of the reduction', async () => {
    vi.stubEnv('GEZEL_LLAMA_REASONING_BUDGET_TOKENS', '2048');
    const { provider, session, requests } = await startSession([() => answer('Rewritten.')], 4096);
    try {
      await session.sendAndWait('The gate rejected it.', { reducedThinking: true });
      expect(requests[0]?.reasoning_budget_tokens).toBe(2048);
    } finally {
      await provider.shutdown();
      vi.unstubAllEnvs();
    }
  });
});
