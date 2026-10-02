import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlamaCppProvider } from './llama-cpp/provider.js';
import { MlxProvider } from './mlx/provider.js';
import { OllamaProvider } from './ollama.js';
import type { ActiveCraftbookStep, LLMSession } from './types.js';

/**
 * The deliverable-ready footer and backstop on each local tool loop:
 * llama.cpp (the core session, including the backstop) and its MLX and
 * Ollama mirrors. spreadsheet-model 1.0.4 `build` on qwen3.8-flash-next
 * polished a passing `index.html` for 12-20 minutes in one turn because
 * `advanceWhen` is only judged at end of turn.
 */
const FOOTER =
  "[runtime] `index.html` now meets this step's completion condition — stop polishing it. Finish any other file the procedure names, then call `write_task_note` with the path and result, then `advance_task_step`.";

const TOOL_NAMES = ['write_file', 'write_task_note', 'advance_task_step'];

const buildStep = (ready: boolean): ActiveCraftbookStep => ({
  name: 'Build the model',
  deliverableFile: 'index.html',
  deliverableReady: async () => ready,
});

function installBridges(session: LLMSession): void {
  (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
    isEmpty: () => false,
    getOpenAITools: () =>
      TOOL_NAMES.map((name) => ({
        name,
        description: name,
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      })),
    hasTool: (name: string) => TOOL_NAMES.includes(name),
    hasCallableRestriction: () => false,
    isRestrictedFromCalling: () => false,
    callTool: async (_name: string, args: Record<string, unknown>) => `Wrote ${String(args.path)}`,
    stop: async () => {},
  };
}

const WRITE_ARGS = { path: 'index.html', content: '<!doctype html><html><body>m</body></html>' };

describe('llama.cpp deliverable-ready footer and backstop', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function sseResponse(events: Array<unknown>): Response {
    const body = events
      .map((ev) => `data: ${ev === '[DONE]' ? '[DONE]' : JSON.stringify(ev)}\n\n`)
      .join('');
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  function toolCallResponse(id: string, name: string, args: Record<string, unknown>): Response {
    return sseResponse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ index: 0, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      },
      '[DONE]',
    ]);
  }

  async function buildSession(
    deliverableReady: (ctx: { writtenThisTurn: boolean }) => Promise<boolean>,
  ) {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'Build the model.',
      model: 'qwen',
      activeCraftbookStep: {
        name: 'Build the model',
        deliverableFile: 'index.html',
        deliverableReady,
      },
    });
    const toolNames = [
      'write_file',
      'replace_in_file',
      'validate',
      'grep_files',
      'write_task_note',
      'advance_task_step',
    ];
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
          hasCallableRestriction: () => boolean;
          isRestrictedFromCalling: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () =>
        toolNames.map((name) => ({ name, description: name, parameters: { type: 'object' } })),
      hasTool: (name: string) => toolNames.includes(name),
      hasCallableRestriction: () => false,
      isRestrictedFromCalling: () => false,
      callTool: async (name: string, args: Record<string, unknown>) =>
        name === 'write_file'
          ? `Wrote ${String(args.path)}`
          : name === 'validate'
            ? `validate ${String(args.path)} — PASS (4 checks)`
            : name === 'grep_files'
              ? 'index.html:12: total'
              : `Edited ${String(args.path)}`,
    };
    return session;
  }

  // spreadsheet-model 1.0.4 `build` on qwen3.8-flash-next: the file passed
  // early and the developer polished it for 12-20 minutes in one turn.
  it('appends the footer to the deliverable write that makes the step ready', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
      if (bodies.length === 1) {
        return toolCallResponse('call_write', 'write_file', {
          path: 'index.html',
          content: '<!doctype html><html><body>model</body></html>',
        });
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'Built index.html.' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const probes: boolean[] = [];
    const session = await buildSession(async ({ writtenThisTurn }) => {
      probes.push(writtenThisTurn);
      return true;
    });

    await session.sendAndWait('Continue the build step.');

    const toolResult = bodies[1]?.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toBe(`Wrote index.html\n\n${FOOTER}`);
    expect(probes).toEqual([true]);
  });

  it('leaves the tool result alone while the deliverable is not ready', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
      if (bodies.length === 1) {
        return toolCallResponse('call_write', 'write_file', {
          path: 'index.html',
          content: '<html><body>',
        });
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'Still working.' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const session = await buildSession(async () => false);

    await session.sendAndWait('Continue the build step.');

    expect(bodies[1]?.messages.find((m) => m.role === 'tool')?.content).toBe('Wrote index.html');
  });

  // The wild trace kept going after `validate` passed: test files it could
  // not run, surgical edits, greps — never a note or an advance.
  it('ends a polishing turn after two footers and the grace iterations', async () => {
    const polish: Array<[string, Record<string, unknown>]> = [
      ['write_file', { path: 'index.html', content: '<!doctype html><html></html>' }],
      ['validate', { path: 'index.html' }],
      ['write_file', { path: 'tests/model.test.js', content: 'test("a", () => {});' }],
      ['replace_in_file', { path: 'index.html', old: 'Total', new: 'Grand total' }],
      ['grep_files', { pattern: 'total' }],
      ['write_file', { path: 'tests/totals.test.js', content: 'test("b", () => {});' }],
      ['replace_in_file', { path: 'index.html', old: 'Grand', new: 'Overall' }],
    ];
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
      const [name, args] = polish[bodies.length - 1] ?? polish[polish.length - 1]!;
      return toolCallResponse(`call_polish_${bodies.length}`, name, args);
    }) as typeof fetch;
    const session = await buildSession(async () => true);

    const reply = await session.sendAndWait('Continue the build step.');

    expect(reply).toBe("Finished `index.html`; handing it to the step's completion check.");
    // Footers on iterations 1 and 2, then four grace iterations.
    expect(bodies).toHaveLength(6);
    const history = (
      session as unknown as { messages: Array<{ role: string; content: string | null }> }
    ).messages;
    const footers = history.filter(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.endsWith(FOOTER),
    );
    expect(footers).toHaveLength(2);
  });
});

describe('MLX deliverable-ready footer', () => {
  function sse(payloads: unknown[]): Response {
    const body = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('');
    return new Response(`${body}data: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  async function run(ready: boolean): Promise<Array<{ role: string; content: unknown }>> {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
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
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'write_file', arguments: JSON.stringify(WRITE_ARGS) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ])
        : sse([
            { choices: [{ index: 0, delta: { content: 'Built it.' }, finish_reason: 'stop' }] },
          ]);
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    const session = await provider.createSession({
      systemMessage: 'Build the model.',
      activeCraftbookStep: buildStep(ready),
    });
    installBridges(session);
    try {
      await session.sendAndWait('Continue the build step.', { timeoutMs: 5_000 });
    } finally {
      await session.disconnect();
    }
    return bodies[1]?.messages ?? [];
  }

  it('appends the footer to the deliverable write result once the step is ready', async () => {
    const tool = (await run(true)).find((m) => m.role === 'tool');
    expect(tool?.content).toBe(`Wrote index.html\n\n${FOOTER}`);
  });

  it('leaves the result alone while the deliverable is not ready', async () => {
    const tool = (await run(false)).find((m) => m.role === 'tool');
    expect(tool?.content).toBe('Wrote index.html');
  });
});

describe('Ollama deliverable-ready footer', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function ndjson(lines: unknown[]): Response {
    return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  }

  async function run(ready: boolean): Promise<Array<{ role: string; content: unknown }>> {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (!url.includes('/api/chat')) throw new Error(`[test-fetch] no handler for ${url}`);
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number]);
      return bodies.length === 1
        ? ndjson([
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'write_file', arguments: WRITE_ARGS } }],
              },
            },
            { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
          ])
        : ndjson([{ message: { role: 'assistant', content: 'Built it.' }, done: true }]);
    }) as typeof fetch;
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'Build the model.',
      model: 'qwen3',
      activeCraftbookStep: buildStep(ready),
    });
    installBridges(session);
    await session.sendAndWait('Continue the build step.');
    return bodies[1]?.messages ?? [];
  }

  it('appends the footer to the deliverable write result once the step is ready', async () => {
    const tool = (await run(true)).find((m) => m.role === 'tool');
    expect(tool?.content).toBe(`Wrote index.html\n\n${FOOTER}`);
  });

  it('leaves the result alone while the deliverable is not ready', async () => {
    const tool = (await run(false)).find((m) => m.role === 'tool');
    expect(tool?.content).toBe('Wrote index.html');
  });
});
