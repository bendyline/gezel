import { describe, expect, it } from 'vitest';
import { TOOL_IMAGES_MESSAGE } from '../mlx/tool-image-retention.js';
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

  it('shows a projector the tool images a remote transcript carries', async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      visionEnabled: true,
      fetchImpl: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse([
          {
            choices: [
              { index: 0, delta: { content: 'Slides look right.' }, finish_reason: 'stop' },
            ],
          },
        ]);
      }) as typeof fetch,
    });
    const blind = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    expect(provider.supportsImageInput).toBe(true);
    expect(blind.supportsImageInput).toBe(false);
    // What `/v1/remote/infer` builds for the forward pass after a remote
    // client's `preview_document` returned slide renders.
    const session = await provider.createSession({
      systemMessage: 'Review the deck.',
      priorMessages: [
        { role: 'user', content: 'Review the deck.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'p1', name: 'preview_document', arguments: '{}' }],
        },
        { role: 'tool', content: 'rendered 2 slides', toolCallId: 'p1' },
        { role: 'user', content: TOOL_IMAGES_MESSAGE, images: ['/9j/AAAA', 'iVBORw0K'] },
      ],
    });
    try {
      expect(await session.sendAndWait('', { timeoutMs: 5000, continueFromToolResult: true })).toBe(
        'Slides look right.',
      );
      const last = bodies[0]!.messages.at(-1);
      expect(last?.role).toBe('user');
      expect(last?.content).toEqual([
        { type: 'text', text: TOOL_IMAGES_MESSAGE },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AAAA' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
      ]);
    } finally {
      await session.disconnect();
      await provider.shutdown();
      await blind.shutdown();
    }
  });
});
