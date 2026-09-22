import { describe, expect, it } from 'vitest';
import type { McpBridgePool } from '../mcp-bridge-pool.js';
import { ProviderQueue } from '../queue.js';
import { RemoteSession } from './session.js';
import { RemoteInferRequestSchema } from './wire.js';

function stream(frames: unknown[]) {
  return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('remote image handoff', () => {
  it.each([false, true])(
    'preserves successful image pixels after tool pairs (tool failed=%s)',
    async (isError) => {
      const requests: ReturnType<typeof RemoteInferRequestSchema.parse>[] = [];
      const session = new RemoteSession({
        baseUrl: 'https://broker',
        token: 'token',
        model: 'mlx:qwen',
        systemMessage: 'inspect',
        numCtx: 32768,
        timeoutMs: 5000,
        priorMessages: [],
        queue: new ProviderQueue({ concurrency: 1 }),
        fetch: (async (_url, init) => {
          requests.push(RemoteInferRequestSchema.parse(JSON.parse(String(init?.body))));
          return requests.length === 1
            ? stream([
                {
                  type: 'tool_call',
                  calls: [
                    { id: 'img1', name: 'read_image_as_base64', arguments: '{"path":"view.png"}' },
                  ],
                },
                { type: 'done' },
              ])
            : stream([{ type: 'delta', text: 'reviewed' }, { type: 'done' }]);
        }) as typeof fetch,
        bridges: {
          isEmpty: () => false,
          getOpenAITools: () => [{ name: 'read_image_as_base64', parameters: { type: 'object' } }],
          callToolRich: async () => ({
            text: isError ? 'ERROR: unavailable' : 'view.png',
            isError,
            images: [{ base64: 'eA==', mimeType: 'image/png' }],
          }),
          stop: async () => {},
        } as unknown as McpBridgePool,
      });
      expect(await session.sendAndWait('Inspect view.png')).toBe('reviewed');
      const continuation = requests[1]!;
      expect(continuation.prompt).toBe('');
      expect(continuation.protocolVersion).toBe(isError ? 1 : 2);
      expect(continuation.priorMessages.map((m) => m.role)).toEqual(
        isError ? ['user', 'assistant', 'tool'] : ['user', 'assistant', 'tool', 'user'],
      );
      if (!isError) {
        expect(continuation.priorMessages.at(-1)).toMatchObject({ images: ['eA=='] });
        expect(session.estimatePromptChars()).toBeGreaterThan(8192);
        await session.prewarm('image-session');
        expect(requests).toHaveLength(2); // image history must never enter text-only KV warming
      }
      await session.disconnect();
    },
  );
});
