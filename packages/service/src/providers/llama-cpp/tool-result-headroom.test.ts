import { describe, expect, it } from 'vitest';
import {
  type ToolOutputBudgetOptions,
  capToolOutput,
  computeToolBudgetChars,
} from '../mcp-bridge.js';
import { LlamaCppProvider } from './provider.js';

/**
 * Build an SSE Response body out of an array of events. Pass `'[DONE]'`
 * as a literal string for the terminator frame; everything else is
 * JSON-stringified and wrapped in `data: … \n\n`.
 */
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
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('LlamaCppSession tool-result headroom', () => {
  it('recovers tool read headroom before the engine-overflow threshold', async () => {
    const numCtx = 32_768;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx });
    const session = await provider.createSession({ systemMessage: 'sys' });
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      messages: Array<{ role: string; content: string; tool_call_id?: string }>;
      estimatePromptChars: () => number;
      makeRoomForToolResults: () => Promise<void>;
      submittedToolResults: WeakSet<object>;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.messages.push({ role: 'user', content: 'Compare the supplied evidence.' });
    for (let i = 0; i < 5; i++) {
      internal.messages.push({ role: 'assistant', content: `Read ${i}` });
      internal.messages.push({
        role: 'tool',
        content: `${i}:${'x'.repeat(15_500)}`,
        tool_call_id: `call-${i}`,
      });
    }
    const before = structuredClone(internal.messages);
    for (const message of internal.messages) internal.submittedToolResults.add(message);
    expect(internal.estimatePromptChars()).toBeLessThan(numCtx * 0.8 * 4);
    expect(computeToolBudgetChars(numCtx, internal.estimatePromptChars())).toBeLessThan(500);
    await internal.makeRoomForToolResults();
    expect(computeToolBudgetChars(numCtx, internal.estimatePromptChars())).toBeGreaterThanOrEqual(
      16_000,
    );
    expect(internal.messages.map((m) => [m.role, m.tool_call_id])).toEqual(
      before.map((m) => [m.role, m.tool_call_id]),
    );
    expect(internal.messages.slice(-4)).toEqual(before.slice(-4));
    expect(internal.messages.filter((m) => m.role !== 'tool')).toEqual(
      before.filter((m) => m.role !== 'tool'),
    );
    expect(internal.messages.find((m) => m.tool_call_id === 'call-0')?.content).toContain(
      'Earlier tool response shortened for context',
    );
    expect(internal.messages.find((m) => m.tool_call_id === 'call-0')?.content).not.toContain(
      're-run with a narrower request',
    );
    const recovered = structuredClone(internal.messages);
    await internal.makeRoomForToolResults();
    expect(internal.messages).toEqual(recovered);
  });

  it('leaves healthy tool transcripts and protected newest results intact', async () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx: 32_768 });
    const session = await provider.createSession({ systemMessage: 'sys' });
    const internal = session as unknown as {
      currentTurnStartIdx: number;
      messages: Array<{ role: string; content: string }>;
      makeRoomForToolResults: () => Promise<void>;
    };
    internal.currentTurnStartIdx = internal.messages.length;
    internal.messages.push({ role: 'user', content: 'Read a file' });
    internal.messages.push({ role: 'tool', content: 'complete observation'.repeat(100) });
    const healthy = structuredClone(internal.messages);
    await internal.makeRoomForToolResults();
    expect(internal.messages).toEqual(healthy);
    internal.messages.push({ role: 'tool', content: 'x'.repeat(80_000) });
    const protectedResults = structuredClone(internal.messages);
    await internal.makeRoomForToolResults();
    expect(internal.messages).toEqual(protectedResults);
  });

  it('delivers every new result in a multi-call response before condensing it', async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: string; tool_call_id?: string }>;
    }> = [];
    const output = (id: number) => `SOURCE-${id}:${'x'.repeat(16_000)}`;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      numCtx: 32_768,
      fetchImpl: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const ids = bodies.length === 1 ? [1, 2, 3, 4] : bodies.length === 2 ? [5, 6, 7] : [];
        return sseResponse(
          ids.length
            ? [
                {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: ids.map((id, index) => ({
                          index,
                          id: `read-${id}`,
                          type: 'function',
                          function: { name: 'read_artifact', arguments: JSON.stringify({ id }) },
                        })),
                      },
                    },
                  ],
                },
                { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
                '[DONE]',
              ]
            : [
                { choices: [{ index: 0, delta: { content: 'Finished.' } }] },
                { choices: [{ index: 0, finish_reason: 'stop' }] },
                '[DONE]',
              ],
        );
      }) as typeof fetch,
    });
    const session = await provider.createSession({ systemMessage: 'Review these sources.' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (
            name: string,
            args: Record<string, unknown>,
            opts?: ToolOutputBudgetOptions,
          ) => Promise<string>;
        };
      };
    };
    const delivered: string[] = [];
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_artifact', description: 'Read a source.', parameters: { type: 'object' } },
      ],
      hasTool: (name) => name === 'read_artifact',
      callTool: async (_name, args, opts) => {
        const text = output(Number(args.id));
        const budget = (await opts?.prepareOutputBudget?.(text.length)) ?? opts?.budgetChars;
        const result = capToolOutput(text, budget, opts);
        delivered.push(result);
        return result;
      },
    };
    expect(await session.sendAndWait('Read all seven source files.')).toBe('Finished.');
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7].map(output));
    expect(bodies).toHaveLength(3);
    for (const [request, ids] of [
      [1, [1, 2, 3, 4]],
      [2, [5, 6, 7]],
    ] as const) {
      for (const id of ids) {
        expect(
          bodies[request]!.messages.find((m) => m.tool_call_id === `read-${id}`)?.content,
        ).toBe(output(id));
      }
    }
    expect(bodies[2]!.messages.find((m) => m.tool_call_id === 'read-1')?.content).toContain(
      'Earlier tool response shortened for context',
    );
  });

  it('does not condense unread results even when their batch exceeds the context budget', async () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx: 32_768 });
    const session = await provider.createSession({ systemMessage: 'sys' });
    const internal = session as unknown as {
      messages: Array<{ role: string; content: string }>;
      prepareToolOutputBudget: (chars: number) => Promise<number>;
    };
    for (let i = 0; i < 5; i++)
      internal.messages.push({ role: 'tool', content: 'x'.repeat(16_000) });
    const before = structuredClone(internal.messages);
    const budget = await internal.prepareToolOutputBudget(16_000);
    expect(budget).toBeLessThan(16_000);
    expect(internal.messages).toEqual(before);
    expect(capToolOutput('x'.repeat(16_000), budget)).toContain('truncated');
  });
});
