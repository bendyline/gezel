import { afterEach, describe, expect, it } from 'vitest';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import type { LLMSession } from '../types.js';
import { MlxProvider } from './provider.js';
import { MlxVisionMode } from './vision-mode.js';

function sse(delta: Record<string, unknown>, finish: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n');
}

function reply(content: string): Response {
  return new Response(sse({ content }, 'stop'), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolCall(name: string, args: Record<string, unknown>): Response {
  const call = {
    index: 0,
    id: 'call-1',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
  return new Response(sse({ tool_calls: [call] }, 'tool_calls'), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

type WireMessage = { role: string; content?: string; images?: string[] };

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
});

/** Stub the MCP bridge: one tool that succeeds and returns one image. */
function withImageTool(session: LLMSession, name: string, calls: string[]): void {
  (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
    isEmpty: () => false,
    getOpenAITools: () => [tool(name)],
    hasTool: () => true,
    callTool: async (
      toolName: string,
      _args: unknown,
      opts: { onImages?: (images: Array<{ base64: string; mimeType: string }>) => void },
    ) => {
      calls.push(toolName);
      opts.onImages?.([{ base64: 'cGl4ZWxz', mimeType: 'image/png' }]);
      return 'Saved image to artifacts/cat.png';
    },
    stop: async () => {},
  };
}

/**
 * Supervised MLX engine whose launches go through `takeLaunch`, the way
 * build-provider's `resolveLaunch` does, so the test sees which tower served
 * each request and when the reload happened.
 */
function supervisedProvider(
  vision: MlxVisionMode,
  respond: (body: { messages: WireMessage[] }, index: number) => Response,
) {
  const events: string[] = [];
  const bodies: Array<{ messages: WireMessage[] }> = [];
  let running = false;
  let tower: 'text' | 'vision' = 'text';
  const supervisor = {
    coordinatesCapacity: false,
    lifecycleSnapshot: () => ({ running }),
    ensureRunning: async () => {
      if (!running) {
        tower = vision.takeLaunch() ? 'vision' : 'text';
        events.push(`launch:${tower}`);
        running = true;
      }
      return { baseUrl: 'http://mlx.test' };
    },
    stop: async () => {
      events.push('stop');
      running = false;
    },
    markUsed: () => {},
    currentBaseUrl: () => (running ? 'http://mlx.test' : undefined),
  } as unknown as NativeEngineSupervisor;
  const provider = new MlxProvider({
    supervisor,
    vision,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: WireMessage[] };
      bodies.push(body);
      const images = body.messages.some((m) => m.images?.length);
      // The sidecar answers 422 to pixels on a text-only launch.
      if (images && tower !== 'vision') return new Response('no vision tower', { status: 422 });
      events.push(images ? 'request:images' : 'request:text');
      return respond(body, bodies.length - 1);
    }) as typeof fetch,
  });
  return { provider, events, bodies };
}

const sessions: LLMSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

describe('MLX vision on demand', () => {
  it('serves text on the text tower and reloads into vision only when an image arrives', async () => {
    const { provider, events } = supervisedProvider(new MlxVisionMode('on-demand', 'qwen'), () =>
      reply('ok'),
    );
    expect(provider.supportsImageInput).toBe(true);
    const session = await provider.createSession({ systemMessage: 'system' });
    sessions.push(session);

    await session.sendAndWait('hello', { timeoutMs: 5_000 });
    expect(events).toEqual(['launch:text', 'request:text']);

    await session.sendAndWait('what is in this picture?', {
      timeoutMs: 5_000,
      attachments: [{ base64: 'eA==', mimeType: 'image/png', filename: 'cat.png' }],
    });
    expect(events).toEqual([
      'launch:text',
      'request:text',
      'stop',
      'launch:vision',
      'request:images',
    ]);

    // The picture stays in history; the engine stays in vision mode, no flapping.
    await session.sendAndWait('and the colour?', { timeoutMs: 5_000 });
    expect(events.filter((e) => e === 'stop')).toHaveLength(1);
    expect(events.at(-1)).toBe('request:images');
  });

  it('reloads into vision when a tool returns images the model must inspect', async () => {
    const calls: string[] = [];
    const { provider, events, bodies } = supervisedProvider(
      new MlxVisionMode('on-demand'),
      (_body, index) =>
        index === 0
          ? toolCall('preview_document', { prompt: 'deck' })
          : reply('Slides look right.'),
    );
    const session = await provider.createSession({ systemMessage: 'system' });
    sessions.push(session);
    withImageTool(session, 'preview_document', calls);

    await session.sendAndWait('Check the deck.', { timeoutMs: 5_000 });
    expect(calls).toEqual(['preview_document']);
    expect(events).toEqual([
      'launch:text',
      'request:text',
      'stop',
      'launch:vision',
      'request:images',
    ]);
    expect(bodies[1]?.messages.at(-1)).toMatchObject({ images: ['cGl4ZWxz'] });
  });

  it('keeps an explicit opt-out text-only for the life of the engine', async () => {
    const calls: string[] = [];
    const { provider, events } = supervisedProvider(new MlxVisionMode('never'), (_body, index) =>
      index === 0 ? toolCall('generate_image', { prompt: 'a cat' }) : reply('Made a cat.'),
    );
    expect(provider.supportsImageInput).toBe(false);
    const session = await provider.createSession({ systemMessage: 'system' });
    sessions.push(session);
    withImageTool(session, 'generate_image', calls);

    await session.sendAndWait('Draw a cat.', { timeoutMs: 5_000 });
    expect(events).toEqual(['launch:text', 'request:text', 'request:text']);
  });
});

describe('text-only MLX with image-returning tools', () => {
  it('keeps the successful result, drops the pixels with a note, and does not re-run the tool', async () => {
    const bodies: Array<{ messages: WireMessage[] }> = [];
    const provider = new MlxProvider({
      baseUrl: 'http://mlx.test',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return bodies.length === 1
          ? toolCall('generate_image', { prompt: 'a cat' })
          : reply('I generated the cat at artifacts/cat.png.');
      }) as typeof fetch,
    });
    const session = await provider.createSession({ systemMessage: 'system' });
    sessions.push(session);
    const calls: string[] = [];
    withImageTool(session, 'generate_image', calls);

    await expect(session.sendAndWait('Draw a cat.', { timeoutMs: 5_000 })).resolves.toContain(
      'artifacts/cat.png',
    );
    expect(calls).toEqual(['generate_image']);
    const toolMessage = bodies[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toMatch(/^Saved image to artifacts\/cat\.png/);
    expect(toolMessage?.content).toContain('The tool succeeded');
    expect(toolMessage?.content).not.toContain('ERROR');
    expect(bodies[1]?.messages.some((m) => m.images?.length)).toBe(false);
  });
});
