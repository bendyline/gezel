import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMSession } from '../types.js';
import { MlxProvider } from './provider.js';

// qwen3.8-27b MLX Meester, 2026-09-23: a JSON-envelope `invoke_craftbook`
// call, the call again, then `</function>` until max_tokens.
const CALL =
  '\n\n<tool_call>\n{\n"name": "invoke_craftbook",\n"arguments": {\n"craftbookId": "powerpoint-deck",\n"params": {\n"topic": "Pizza"\n}\n}\n}\n</tool_call>\n';
const TAIL = '</parameter>\n</invoke>\n</parameter>\n</function>\n';
const LOOP_LINE = '</function>\n';
const LOOP_CAP = 2000;

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

/**
 * Streams the call, then the orphan-closer loop until aborted. If the
 * abort never lands the loop closes itself after LOOP_CAP lines, so a
 * regression fails on the emitted count instead of hanging the suite.
 */
function loopingStream(
  signal: AbortSignal | undefined,
  emitted: { lines: number },
  call: string,
): Response {
  const encoder = new TextEncoder();
  const pieces = [...call.match(/[\s\S]{1,12}/g)!, TAIL];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) return;
      const next = pieces.shift();
      if (next !== undefined) {
        controller.enqueue(encoder.encode(chunk(next)));
        return;
      }
      if (emitted.lines >= LOOP_CAP) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      emitted.lines++;
      controller.enqueue(encoder.encode(chunk(LOOP_LINE)));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function reply(content: string): Response {
  return new Response(
    `${chunk(content).replace('}}]}', '}, "finish_reason": "stop"}]}')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const definitions = [
  {
    name: 'invoke_craftbook',
    description: 'Start a craftbook',
    parameters: {
      type: 'object',
      properties: { craftbookId: { type: 'string' }, params: { type: 'object' } },
      required: ['craftbookId'],
    },
  },
];

const sessions: LLMSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

async function run(opts: { singleToolCallTurn?: boolean }, call = CALL) {
  const emitted = { lines: 0 };
  let requests = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests++;
    return requests === 1
      ? loopingStream(init?.signal ?? undefined, emitted, call)
      : reply('The deck is under way.');
  });
  const provider = new MlxProvider({
    baseUrl: 'http://engine.test',
    fetchImpl: fetchImpl as typeof fetch,
  });
  const session = await provider.createSession({ systemMessage: 'system', ...opts });
  sessions.push(session);
  const execute = vi.fn(
    async (_name: string, _args: Record<string, unknown>) => 'Craftbook started: task default/12',
  );
  (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
    isEmpty: () => false,
    getOpenAITools: () => definitions,
    hasTool: (name: string) => name === 'invoke_craftbook',
    callTool: execute,
    stop: async () => {},
  };
  await session.sendAndWait('Can you create a new PowerPoint about Pizza?');
  return { emitted, execute };
}

describe('MLX single-call turn', () => {
  it('stops the stream at the first complete call and still fires it', async () => {
    const { emitted, execute } = await run({ singleToolCallTurn: true });
    expect(emitted.lines).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe('invoke_craftbook');
  });

  it('without the clamp, the stuck-line guard cuts the closer loop and salvages the call', async () => {
    const { emitted, execute } = await run({});
    expect(emitted.lines).toBeGreaterThan(0);
    expect(emitted.lines).toBeLessThan(100);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe('invoke_craftbook');
  });

  it('reads an object argument written as JSON inside its parameter tag (Qwen template idiom)', async () => {
    const native =
      '\n\n<tool_call>\n<function=invoke_craftbook>\n<parameter=craftbookId>\npowerpoint-deck\n</parameter>\n<parameter=params>\n{"topic": "Pizza"}\n</parameter>\n</function>\n</tool_call>\n';
    const { emitted, execute } = await run({ singleToolCallTurn: true }, native);
    expect(emitted.lines).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      craftbookId: 'powerpoint-deck',
      params: { topic: 'Pizza' },
    });
  });
});
