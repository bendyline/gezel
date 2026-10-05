import { lookupBehavior } from '@bendyline/gezel/local-loop';
import { expect, it, vi } from 'vitest';
import { MlxProvider } from './provider.js';

function reply(delta: Record<string, unknown>, finishReason: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

it('keeps a long visible answer after search, with explicit reasoning still separate', async () => {
  const answer = [
    '# The research findings',
    'The retrieved sources describe the history, ingredients, and preparation. '.repeat(12),
    'The details matter when comparing the accounts: check which evidence each author cites and distinguish the naming story from the origins of the recipe. '.repeat(
      4,
    ),
  ].join('\n\n');
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(
      reply(
        {
          tool_calls: [
            {
              index: 0,
              id: 'search-1',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"pizza history"}' },
            },
          ],
        },
        'tool_calls',
      ),
    )
    .mockResolvedValueOnce(reply({ content: `<think>Read the sources.</think>${answer}` }, 'stop'));
  const behavior = lookupBehavior('turn.preamble-folding')!;
  const provider = new MlxProvider({
    baseUrl: 'http://engine.test',
    fetchImpl: fetchImpl as typeof fetch,
  });
  const session = await provider.createSession({
    systemMessage: 'Answer from sources.',
    profile: {
      catalogId: 'gemma4-31b',
      tier: 'medium',
      style: { family: 'gemma', reasoningFormat: 'channel', toolCallFormat: 'function-call' },
      behaviors: [{ id: 'turn.preamble-folding', config: undefined, behavior }],
    },
  });
  const execute = vi.fn(async () => 'Source excerpts.');
  (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
    isEmpty: () => false,
    getOpenAITools: () => [
      { name: 'search', description: 'Search sources.', parameters: { type: 'object' } },
    ],
    hasTool: (name: string) => name === 'search',
    hasCallableRestriction: () => false,
    isRestrictedFromCalling: () => false,
    callTool: execute,
    stop: async () => {},
  };
  try {
    expect(await session.sendAndWait('Explain the history of pizza.')).toBe(answer.trim());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    await session.disconnect();
  }
});
