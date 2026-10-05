import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnPreambleFolding } from '../model-profile/behaviors/turn-preamble-folding.js';
import { ExternalLlamaServer } from './test-utils/external-llama-server.js';

const answer = [
  'Margherita pizza combines tomatoes, mozzarella, and basil. The simplicity of those toppings makes the dough, cheese, and baking especially noticeable.',
  '### History\nThe familiar story associates the pizza with Queen Margherita and the colors of the Italian flag. The retrieved source also describes similar toppings before that royal visit, so the naming story should be distinguished from the origins of the food.',
  '### Ingredients\nTomatoes provide acidity and sweetness, mozzarella melts across the surface, and basil adds a fresh aroma. Olive oil finishes the toppings. Different cheeses and tomatoes change the balance without requiring a long list of ingredients.',
  '### Baking\nThe dough and oven shape the result as much as the toppings. A hot oven can give the edge a light, airy texture while keeping the center soft. For home cooking, preheating the baking surface helps the base cook before the toppings become dry. Let the pizza cool briefly before slicing, and add delicate basil near the end if it would otherwise burn in your oven.',
].join('\n\n');

function sse(delta: Record<string, unknown>, finishReason: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('post-tool answers', () => {
  it.each(['', '\n\nThose are the main characteristics.'])(
    'preserves the full researched answer regardless of the closing paragraph %j',
    async (closing) => {
      const expected = answer + closing;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          sse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'search-1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"query":"Margherita pizza"}' },
                },
              ],
            },
            'tool_calls',
          ),
        )
        .mockResolvedValueOnce(
          sse({ content: `<think>Compare the retrieved sources.</think>${expected}` }, 'stop'),
        );
      vi.stubGlobal('fetch', fetchMock);
      const provider = new ExternalLlamaServer({ baseUrl: 'http://engine.test' });
      const session = await provider.createSession({
        systemMessage: 'Answer the question using the available sources.',
        model: 'gemma4-31b-q4',
        profile: {
          style: { family: 'gemma', reasoningFormat: 'channel', toolCallFormat: 'function-call' },
          behaviors: [
            { id: 'turn.preamble-folding', config: undefined, behavior: TurnPreambleFolding },
          ],
        },
      });
      const execute = vi.fn(
        async () => 'Retrieved history and ingredients from the reference catalog.',
      );
      (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
        isEmpty: () => false,
        getOpenAITools: () => [
          { name: 'search', description: 'Search sources.', parameters: { type: 'object' } },
        ],
        hasTool: (name: string) => name === 'search',
        callTool: execute,
        stop: async () => {},
      };
      try {
        expect(await session.sendAndWait('Can you tell me more about Margherita pizza?')).toBe(
          expected,
        );
        expect(execute).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const reasoning = (
          session as unknown as { getLastTurnReasoning(): string }
        ).getLastTurnReasoning();
        expect(reasoning).toContain('Compare the retrieved sources.');
        expect(reasoning).not.toContain('### History');
      } finally {
        await session.disconnect();
      }
    },
  );
});
