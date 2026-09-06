import type { FileTurnIntent } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlamaCppProvider } from './llama-cpp/provider.js';
import { MlxProvider } from './mlx/provider.js';
import type { LLMSession } from './types.js';

function reply(content: string): Response {
  return stream({ content });
}
function call(name: string, args: unknown): Response {
  return stream({
    tool_calls: [
      {
        index: 0,
        id: 'call',
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      },
    ],
  });
}
function stream(delta: unknown): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const names = ['read_file', 'write_file', 'replace_in_file', 'replace_lines'];
const definitions = names.map((name) => ({
  name,
  description: name,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
  },
}));
type WireTool = { function: { name: string } };
const sessions: LLMSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

describe.each([
  ['llama.cpp', LlamaCppProvider],
  ['MLX', MlxProvider],
] as const)('%s recovery contract', (_label, Provider) => {
  async function setup(
    responses: (body: Record<string, unknown>, iteration: number) => Response,
    execute = vi.fn(
      async (name: string): Promise<string> =>
        name === 'read_file' ? 'current source' : 'Wrote requested file',
    ),
  ) {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return responses(body, bodies.length);
    });
    const provider = new Provider({
      baseUrl: 'http://engine.test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const session = await provider.createSession({ systemMessage: 'system' });
    sessions.push(session);
    // Stub the tool boundary, retaining each real provider's request, recovery,
    // transcript, and execution loops. No native model or filesystem is involved.
    (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => definitions,
      hasTool: (name: string) => names.includes(name),
      callTool: execute,
      stop: async () => {},
    };
    return { session, bodies, execute };
  }

  it.each(['reports/budget.rst', 'src/codec.rs', 'views/mobile.html'])(
    'rescues a stalled write of %s independent of feedback text',
    async (path) => {
      const { session, bodies, execute } = await setup((_body, n) =>
        n === 1 ? reply('I will do that.') : call('write_file', { path, content: 'complete' }),
      );
      await session.sendAndWait('Please finish the requested work.', {
        fileTurnIntent: { kind: 'create-file', path },
      });
      expect(bodies).toHaveLength(2);
      for (const body of bodies)
        expect((body.tools as WireTool[]).map((tool) => tool.function.name)).toEqual([
          'write_file',
        ]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toBe('write_file');
    },
  );

  it('reads then patches a failing file under structured repair intent', async () => {
    const path = 'lib/payment.py';
    const { session, bodies, execute } = await setup((_body, n) =>
      n === 1
        ? call('read_file', { path })
        : call('replace_in_file', { path, find: 'bad', replace: 'good' }),
    );
    await session.sendAndWait('The validator found an issue; please address it.', {
      fileTurnIntent: { kind: 'repair-file', path, readPaths: [path] },
    });
    expect(bodies).toHaveLength(2);
    expect(execute.mock.calls.map((args) => args[0])).toEqual(['read_file', 'replace_in_file']);
    expect((bodies[0]!.tools as WireTool[]).map((tool) => tool.function.name)).toEqual([
      'read_file',
    ]);
    expect((bodies[1]!.tools as WireTool[]).map((tool) => tool.function.name)).toContain(
      'replace_in_file',
    );
  });

  it('escalates failed patches using the same bounded repair sequence', async () => {
    const path = 'src/counter.ts';
    const execute = vi.fn(
      async (name: string): Promise<string> =>
        name === 'read_file'
          ? 'current source'
          : name === 'write_file'
            ? 'Wrote requested file'
            : 'ERROR: patch did not match',
    );
    const { session, bodies } = await setup(
      (_body, n) =>
        n === 1
          ? call('read_file', { path })
          : n < 4
            ? call('replace_in_file', { path, find: 'old', replace: 'new' })
            : call('write_file', { path, content: 'corrected source' }),
      execute,
    );
    await session.sendAndWait('Tests for src/counter.ts failed. Correct the regression.', {
      fileTurnIntent: { kind: 'repair-file', path },
    });
    expect(bodies).toHaveLength(4);
    expect((bodies[3]!.tools as WireTool[]).map((tool) => tool.function.name)).toEqual([
      'write_file',
    ]);
    expect(execute.mock.calls.map((args) => args[0])).toEqual([
      'read_file',
      'replace_in_file',
      'replace_in_file',
      'write_file',
    ]);
  });

  it.each([
    'The acceptance checks for views/dashboard.html failed. Please correct the existing file.',
    'Tests are still failing in views/dashboard.html; investigate and fix the regression.',
  ])('repairs ordinary user feedback: %s', async (prompt) => {
    const { session, bodies, execute } = await setup((_body, n) =>
      n === 1
        ? call('read_file', { path: 'views/dashboard.html' })
        : call('replace_in_file', { path: 'views/dashboard.html', find: 'old', replace: 'new' }),
    );
    await session.sendAndWait(prompt);
    expect(bodies).toHaveLength(2);
    expect(execute.mock.calls.map((args) => args[0])).toEqual(['read_file', 'replace_in_file']);
  });

  it('bounds no-progress attempts and resets the budget on a new send', async () => {
    const { session, bodies, execute } = await setup(() => reply('I am considering the request.'));
    const fileTurnIntent: FileTurnIntent = { kind: 'create-file', path: 'output/result.xml' };
    await expect(session.sendAndWait('Proceed.', { fileTurnIntent })).rejects.toThrow(
      /without a successful workspace mutation/,
    );
    expect(bodies).toHaveLength(3);
    await expect(session.sendAndWait('Try again.', { fileTurnIntent })).rejects.toThrow(
      /without a successful workspace mutation/,
    );
    expect(bodies).toHaveLength(6);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute malformed arguments and bounds recovery', async () => {
    const { session, bodies, execute } = await setup(() => call('read_file', '{broken'));
    await expect(session.sendAndWait('Inspect the file.')).rejects.toThrow(
      /Malformed tool-call recovery budget exhausted/,
    );
    expect(bodies.length).toBeLessThanOrEqual(3);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { kind: 'create-file', path: 'notes/plan.rst' },
    { kind: 'repair-file', path: 'src/codec.rs' },
  ] satisfies (FileTurnIntent | undefined)[])(
    'uses one bounded retry for a repeated unknown tool with intent %j',
    async (fileTurnIntent) => {
      const { session, bodies, execute } = await setup(() =>
        reply('{"tool":"invented_tool","args":{}}'),
      );
      await session.sendAndWait('Please inspect the current state.', { fileTurnIntent });
      expect(bodies).toHaveLength(2);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('honors cancellation during rescue even when the stream closes normally', async () => {
    const ctrl = new AbortController();
    const { session, bodies, execute } = await setup((_body, n) => {
      if (n === 1) return reply('I will write it.');
      ctrl.abort();
      return call('write_file', { path: 'notes/plan.rst', content: 'late write' });
    });
    await expect(
      session.sendAndWait('Finish it.', {
        fileTurnIntent: { kind: 'create-file', path: 'notes/plan.rst' },
        queue: { lane: 'interactive', signal: ctrl.signal },
      }),
    ).rejects.toThrow(/cancelled|stopped/i);
    expect(bodies).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });
});
