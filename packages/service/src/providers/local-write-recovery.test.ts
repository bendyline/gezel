import type { FileTurnIntent } from '@bendyline/gezel';
import { LlamaCppProvider } from '@bendyline/gezel-inference/internal/providers/llama-cpp/provider';
import { MlxProvider } from '@bendyline/gezel-inference/internal/providers/mlx/provider';
import type { LLMSession } from '@bendyline/gezel-inference/internal/providers/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sessions: LLMSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

const definitions = ['write_file', 'read_file', 'search', 'replace_in_file'].map((name) => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
}));
function call(name: string, args: Record<string, unknown>) {
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}
function reply(content: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

describe.each([
  ['MLX', MlxProvider],
  ['llama.cpp', LlamaCppProvider],
] as const)('%s write recovery', (_name, Provider) => {
  it('reopens read and surgical edits after a rejected full rewrite', async () => {
    const bodies: { tools: { function: { name: string } }[] }[] = [];
    const responses = [
      call('write_file', { path: 'src/widget.js', content: 'incomplete source' }),
      call('read_file', { path: 'src/widget.js' }),
      call('replace_in_file', { path: 'src/widget.js', find: 'broken', replace: 'fixed' }),
      'Saved the correction.',
    ];
    const provider = new Provider({
      baseUrl: 'http://engine.test',
      fetchImpl: vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        const response = responses.shift();
        if (response === undefined) throw new Error('Unexpected extra inference request');
        return reply(response);
      }) as typeof fetch,
    });
    const session = await provider.createSession({ systemMessage: 'Correct the source file.' });
    sessions.push(session);
    const execute = vi.fn(async (name: string) =>
      name === 'write_file'
        ? 'ERROR: Refusing to replace src/widget.js with a much shorter source file. Read it and use replace_in_file for targeted edits.'
        : name === 'read_file'
          ? '1 | broken'
          : 'Replaced one occurrence in src/widget.js',
    );
    (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => definitions,
      hasTool: (name: string) => definitions.some((tool) => tool.name === name),
      hasCallableRestriction: () => false,
      isRestrictedFromCalling: () => false,
      callTool: execute,
      stop: async () => {},
    };
    await session.sendAndWait('Correct src/widget.js.', {
      fileTurnIntent: { kind: 'repair-file', path: 'src/widget.js', strategy: 'rewrite' },
    });
    expect(bodies[0]!.tools.map((tool) => tool.function.name)).toEqual(['write_file']);
    expect(bodies[1]!.tools.map((tool) => tool.function.name)).toContain('read_file');
    expect(bodies[2]!.tools.map((tool) => tool.function.name)).toContain('replace_in_file');
    expect(execute.mock.calls.map(([name]) => name)).toEqual([
      'write_file',
      'read_file',
      'replace_in_file',
    ]);
  });

  it.each<FileTurnIntent>([
    { kind: 'create-file', path: 'report.md' },
    { kind: 'repair-file', path: 'report.md', strategy: 'rewrite' },
  ])('reopens research after a rejected $kind write', async (fileTurnIntent) => {
    const bodies: { tools: { function: { name: string } }[] }[] = [];
    const responses = [
      call('write_file', { path: 'report.md', content: 'Unverified account' }),
      call('search', { query: 'source evidence' }),
      call('read_file', { path: 'source.md' }),
      call('write_file', { path: 'report.md', content: 'Verified account with citations' }),
      'Saved the report.',
    ];
    const provider = new Provider({
      baseUrl: 'http://engine.test',
      fetchImpl: vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        const response = responses.shift();
        if (response === undefined) throw new Error('Unexpected extra inference request');
        return reply(response);
      }) as typeof fetch,
    });
    const session = await provider.createSession({
      systemMessage: 'Use source evidence before writing.',
    });
    sessions.push(session);
    let writes = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'write_file' && writes++ === 0) {
        return 'Not saved: no source evidence has been collected. Your next tool call must be `search`.';
      }
      return name === 'write_file' ? 'Wrote report.md' : 'Source evidence collected';
    });
    (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => definitions,
      hasTool: (name: string) => definitions.some((tool) => tool.name === name),
      hasCallableRestriction: () => false,
      isRestrictedFromCalling: () => false,
      callTool: execute,
      stop: async () => {},
    };
    await session.sendAndWait('Write a sourced report to report.md.', { fileTurnIntent });
    const names = (index: number) => bodies[index]!.tools.map((tool) => tool.function.name);
    expect(names(0)).toEqual(['write_file']);
    expect(names(1)).toEqual(['search']);
    expect(names(2)).toEqual(definitions.map((tool) => tool.name));
    expect(names(3)).toEqual(names(2));
    expect(execute.mock.calls.map(([name]) => name)).toEqual([
      'write_file',
      'search',
      'read_file',
      'write_file',
    ]);
  });
});
