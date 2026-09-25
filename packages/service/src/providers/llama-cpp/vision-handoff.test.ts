import { describe, expect, it } from 'vitest';
import { LlamaCppProvider } from './provider.js';

function sse(events: unknown[]) {
  return new Response(
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('llama.cpp image tool handoff', () => {
  it.each([true, false])(
    'delivers pixels only with a projector (vision=%s)',
    async (visionEnabled) => {
      const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
      const provider = new LlamaCppProvider({
        baseUrl: 'http://llama.test',
        visionEnabled,
        fetchImpl: (async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return bodies.length === 1
            ? sse([
                {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'image1',
                            type: 'function',
                            function: {
                              name: 'read_image_as_base64',
                              arguments: '{"path":"view.png"}',
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
              ])
            : sse([
                { choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }] },
              ]);
        }) as typeof fetch,
      });
      const session = await provider.createSession({ systemMessage: 'Inspect the image.' });
      let calls = 0;
      (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
        isEmpty: () => false,
        hasTool: () => true,
        getOpenAITools: () => [
          {
            type: 'function',
            name: 'read_image_as_base64',
            description: 'Inspect an image',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
        callTool: async (
          _name: string,
          _args: unknown,
          opts: { onImages?: (images: unknown[]) => void },
        ) => {
          calls++;
          opts.onImages?.([{ base64: 'eA==', mimeType: 'image/png' }]);
          return 'view.png';
        },
        stop: async () => {},
      };
      try {
        expect(await session.sendAndWait('Inspect view.png', { timeoutMs: 5000 })).toBe('Done.');
        expect(calls).toBe(visionEnabled ? 1 : 0);
        const messages = bodies[1]!.messages;
        const tool = messages.find((m) => m.role === 'tool');
        if (visionEnabled) {
          expect(messages.map((m) => m.role)).toEqual([
            'system',
            'user',
            'assistant',
            'tool',
            'user',
          ]);
          expect(messages.at(-1)?.content).toContainEqual({
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,eA==' },
          });
        } else {
          expect(tool?.content).toContain('No image was delivered');
          expect(JSON.stringify(messages)).not.toContain('image_url');
        }
      } finally {
        await session.disconnect();
        await provider.shutdown();
      }
    },
  );
});
