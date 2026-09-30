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
    'sends image pixels after tool pairs, then retires them once inspected (tool failed=%s)',
    async (isError) => {
      const requests: ReturnType<typeof RemoteInferRequestSchema.parse>[] = [];
      const warmed: Array<{ priorMessages: Array<{ content: string; images?: string[] }> }> = [];
      const session = new RemoteSession({
        baseUrl: 'https://broker',
        token: 'token',
        model: 'mlx:qwen',
        systemMessage: 'inspect',
        numCtx: 32768,
        timeoutMs: 5000,
        priorMessages: [],
        queue: new ProviderQueue({ concurrency: 1 }),
        fetch: (async (url, init) => {
          if (String(url).endsWith('/v1/remote/cache/warm')) {
            warmed.push(JSON.parse(String(init?.body)));
            return new Response('{}');
          }
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
        // The model answered after seeing them, so nothing carries them forward.
        expect(session.estimatePromptChars()).toBeLessThan(8192);
        await session.prewarm('image-session');
        expect(JSON.stringify(warmed)).not.toContain('eA=='); // text-only KV warming
        expect(warmed[0]!.priorMessages.at(-2)?.content).toContain(
          '1 image(s) returned by an earlier tool call',
        );
      }
      await session.disconnect();
    },
  );

  it('sends tool images on the next request only', async () => {
    const requests: ReturnType<typeof RemoteInferRequestSchema.parse>[] = [];
    const call = (id: string, name: string) =>
      stream([
        { type: 'tool_call', calls: [{ id, name, arguments: '{"source":"deck.pptx"}' }] },
        { type: 'done' },
      ]);
    const session = new RemoteSession({
      baseUrl: 'https://broker',
      token: 'token',
      model: 'llama-cpp:qwen3.8-27b-q4',
      systemMessage: 'review',
      numCtx: 32768,
      timeoutMs: 5000,
      priorMessages: [],
      queue: new ProviderQueue({ concurrency: 1 }),
      fetch: (async (_url, init) => {
        requests.push(RemoteInferRequestSchema.parse(JSON.parse(String(init?.body))));
        if (requests.length === 1) return call('p1', 'preview_document');
        if (requests.length === 2) return call('i1', 'inspect_document');
        return stream([{ type: 'delta', text: 'reviewed' }, { type: 'done' }]);
      }) as typeof fetch,
      bridges: {
        isEmpty: () => false,
        getOpenAITools: () => [
          { name: 'preview_document', parameters: { type: 'object' } },
          { name: 'inspect_document', parameters: { type: 'object' } },
        ],
        callToolRich: async (name: string) => ({
          text: `${name} ok`,
          isError: false,
          images: name === 'preview_document' ? [{ base64: 'eA==', mimeType: 'image/png' }] : [],
        }),
        stop: async () => {},
      } as unknown as McpBridgePool,
    });

    expect(await session.sendAndWait('Review the deck')).toBe('reviewed');
    expect(requests.map((r) => r.protocolVersion)).toEqual([1, 2, 1]);
    expect(requests[1]!.priorMessages.at(-1)).toMatchObject({ images: ['eA=='] });
    expect(JSON.stringify(requests[2])).not.toContain('eA==');
    await session.disconnect();
  });

  it('continues without the pixels when the broker engine takes no image input', async () => {
    const requests: ReturnType<typeof RemoteInferRequestSchema.parse>[] = [];
    const session = new RemoteSession({
      baseUrl: 'https://broker',
      token: 'token',
      model: 'llama-cpp:gemma4-26b-q4',
      systemMessage: 'review',
      numCtx: 32768,
      timeoutMs: 5000,
      priorMessages: [],
      queue: new ProviderQueue({ concurrency: 1 }),
      fetch: (async (_url, init) => {
        const body = RemoteInferRequestSchema.parse(JSON.parse(String(init?.body)));
        requests.push(body);
        if (body.priorMessages.some((m) => m.role === 'user' && m.images?.length)) {
          return new Response(JSON.stringify({ error: 'image_history_not_supported_by_engine' }), {
            status: 422,
          });
        }
        return body.prompt
          ? stream([
              {
                type: 'tool_call',
                calls: [
                  {
                    id: `call${requests.length}`,
                    name: 'preview_document',
                    arguments: '{"source":"deck.pptx"}',
                  },
                ],
              },
              { type: 'done' },
            ])
          : stream([{ type: 'delta', text: 'reviewed' }, { type: 'done' }]);
      }) as typeof fetch,
      bridges: {
        isEmpty: () => false,
        getOpenAITools: () => [{ name: 'preview_document', parameters: { type: 'object' } }],
        callToolRich: async () => ({
          text: 'rendered 2 slides',
          isError: false,
          images: [
            { base64: 'eA==', mimeType: 'image/png' },
            { base64: 'eQ==', mimeType: 'image/png' },
          ],
        }),
        stop: async () => {},
      } as unknown as McpBridgePool,
    });

    expect(await session.sendAndWait('Review the deck')).toBe('reviewed');
    expect(requests.map((r) => r.protocolVersion)).toEqual([1, 2, 1]);
    expect(requests[2]!.priorMessages.at(-1)).toEqual({
      role: 'user',
      content: '[2 image(s) could not be shown here: this model is running without image input.]',
    });

    // Known text-only now: the next preview never offers the broker pixels.
    expect(await session.sendAndWait('Check it again')).toBe('reviewed');
    const secondTurn = requests.slice(3);
    expect(secondTurn.map((r) => r.protocolVersion)).toEqual([1, 1]);
    const toolResult = secondTurn[1]!.priorMessages.filter((m) => m.role === 'tool').at(-1);
    expect(toolResult?.content).toContain('rendered 2 slides');
    expect(toolResult?.content).toContain('not shown to you because this model runs without image');
    await session.disconnect();
  });

  it('still surfaces other broker rejections', async () => {
    const session = new RemoteSession({
      baseUrl: 'https://broker',
      token: 'token',
      model: 'llama-cpp:gemma4-26b-q4',
      systemMessage: 'review',
      numCtx: 32768,
      timeoutMs: 5000,
      priorMessages: [],
      queue: new ProviderQueue({ concurrency: 1 }),
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'invalid_model' }), { status: 400 })) as typeof fetch,
      bridges: {
        isEmpty: () => true,
        stop: async () => {},
      } as unknown as McpBridgePool,
    });
    await expect(session.sendAndWait('hello')).rejects.toThrow(
      '[remote] /v1/remote/infer returned HTTP 400 {"error":"invalid_model"}',
    );
    await session.disconnect();
  });
});
