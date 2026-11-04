import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModelProfile } from '../../model-profile/types.js';
import type { LLMSession } from '../types.js';
import { MlxProvider } from './provider.js';

const profile = {
  catalogId: 'qwen-test',
  tier: 'medium',
  style: { family: 'qwen', reasoningFormat: 'think', toolCallFormat: 'function-call' },
  behaviors: [{ id: 'tools.mlx-grammar', config: undefined, behavior: {} as never }],
} as ResolvedModelProfile;

const definition = {
  name: 'lookup_record',
  description: 'Look up a record',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function reply(delta: Record<string, unknown>): Response {
  const frame = { choices: [{ index: 0, delta, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function nativeCall(args: Record<string, unknown>): Record<string, unknown> {
  return {
    tool_calls: [
      {
        index: 0,
        id: 'lookup',
        type: 'function',
        function: { name: 'lookup_record', arguments: JSON.stringify(args) },
      },
    ],
  };
}

const sessions: LLMSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

async function exercise(first: Record<string, unknown>, firstValidatorFailure = false) {
  const bodies: Array<Record<string, unknown>> = [];
  const responses = [first, nativeCall({ query: 'invoice' }), { content: 'Found it.' }];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return reply(responses.shift() ?? { content: 'Done.' });
  });
  const provider = new MlxProvider({
    baseUrl: 'http://engine.test',
    fetchImpl: fetchImpl as typeof fetch,
  });
  const session = await provider.createSession({ systemMessage: 'system', profile });
  sessions.push(session);
  const execute = vi.fn(async (..._args: unknown[]) => 'Found invoice.');
  if (firstValidatorFailure) {
    execute.mockResolvedValueOnce(
      'ERROR: lookup_record rejected by validator. Missing required fields: scope',
    );
  }
  (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
    isEmpty: () => false,
    getOpenAITools: () => [definition],
    hasTool: (name: string) => name === definition.name,
    hasCallableRestriction: () => false,
    isRestrictedFromCalling: () => false,
    callTool: execute,
    stop: async () => {},
  };
  await session.sendAndWait('Find the invoice record.');
  // Check that a failed salvage does not disable drafting on later user turns either.
  await session.sendAndWait('Thanks.');
  const feedback = (bodies[1]?.messages as Array<{ role: string; content: string }>).find(
    (message) => message.role === 'tool',
  )?.content;
  return { bodies, execute, feedback };
}

describe('MLX grammar fallback attribution', () => {
  it('rejects an incomplete prose call without disabling drafting', async () => {
    // The October 27 false alarms followed this shape: it is ordinary TEXT
    // to the Hermes grammar, then promoted to a call by prose salvage.
    const { bodies, execute, feedback } = await exercise({ content: 'lookup_record({})' });
    expect(bodies[0]?.tool_grammar).toMatchObject({ format: 'hermes', mode: 'name-and-params' });
    expect(feedback).toContain('query');
    expect(feedback).not.toContain('sequential');
    expect(bodies.every((body) => body.disable_speculation !== true)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]).toEqual([
      'lookup_record',
      { query: 'invoice' },
      expect.any(Object),
    ]);
  });

  it.each([
    ['native', nativeCall({})],
    ['Hermes envelope', { content: '<tool_call><function=lookup_record></function></tool_call>' }],
  ])('still rejects a %s grammar violation and retries sequentially', async (_label, first) => {
    const { bodies, execute, feedback } = await exercise(first as Record<string, unknown>);
    expect(feedback).toContain('sequential');
    expect(bodies[0]?.disable_speculation).toBeUndefined();
    expect(bodies.slice(1).every((body) => body.disable_speculation === true)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]).toEqual([
      'lookup_record',
      { query: 'invoice' },
      expect.any(Object),
    ]);
  });

  it('does not blame speculation when a prose call reaches a stricter MCP schema', async () => {
    const { bodies, execute, feedback } = await exercise(
      { content: 'lookup_record({"query":"invoice"})' },
      true,
    );
    expect(feedback).toContain('Missing required fields: scope');
    expect(bodies.every((body) => body.disable_speculation !== true)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
