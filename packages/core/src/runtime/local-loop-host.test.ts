import { describe, expect, it, vi } from 'vitest';
import { UnresolvedToolFailureLedger } from '../local-loop/unresolved-tool-failure-ledger.js';
import {
  PortableEngineHost,
  PortableToolExecutor,
  type PortableToolOutcome,
} from './local-loop-host.js';

const tool = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'function' as const,
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties, required },
});

function executor(
  run: (name: string, args: Record<string, unknown>) => Promise<PortableToolOutcome>,
  ledger?: UnresolvedToolFailureLedger,
) {
  return new PortableToolExecutor({
    tools: [
      tool('write_file', { path: { type: 'string' }, content: { type: 'string' } }, ['path']),
      tool('create_task', {
        title: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } },
      }),
      tool('advance_task_step', { ref: { type: 'string' } }),
    ],
    run,
    modelTier: 'small',
    isMeester: false,
    ...(ledger ? { ledger } : {}),
  });
}

describe('the phone tool pipeline, as the desktop MCP bridge runs it', () => {
  it('resolves legacy spellings and repairs flattened arguments', async () => {
    const run = vi.fn(async () => ({ text: '{"written":true}', isError: false }));
    const tools = executor(run);
    expect(tools.hasTool('writeFile')).toBe(true);
    await tools.callTool('writeFile', { path: 'notes.md', content: 'hi' });
    expect(run).toHaveBeenLastCalledWith('write_file', { path: 'notes.md', content: 'hi' });
    await tools.callTool('create_task', { title: 'T', steps: '[{"name":"a"}]' });
    expect(run).toHaveBeenLastCalledWith('create_task', { title: 'T', steps: [{ name: 'a' }] });
  });

  it('applies the gezel-tool wrappers before the call', async () => {
    const run = vi.fn(async () => ({ text: 'ok', isError: false }));
    await executor(run).callTool('write_file', { path: 'workspace/index.html', content: '<p/>' });
    expect(run).toHaveBeenLastCalledWith('write_file', { path: 'index.html', content: '<p/>' });
  });

  it('explains a schema rejection the way the desktop translator does', async () => {
    const run = vi.fn(async () => ({
      text: 'ignored',
      isError: true,
      validationIssues: [
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['path'],
          message: 'Invalid input: expected string, received undefined',
        },
      ],
    }));
    const text = await executor(run).callTool('write_file', { content: 'x' });
    expect(text).toMatch(/^ERROR: /);
    expect(text).toContain('write_file');
    expect(text).toContain('`path`');
    expect(text).not.toContain('MCP error -32602');
  });

  it('holds step advancement behind a tool that keeps failing validation', async () => {
    const ledger = new UnresolvedToolFailureLedger();
    const run = vi.fn(
      async (name: string): Promise<PortableToolOutcome> =>
        name === 'write_file'
          ? {
              text: 'bad',
              isError: true,
              validationIssues: [
                {
                  code: 'invalid_type',
                  expected: 'string',
                  path: ['path'],
                  message: 'Invalid input: expected string, received undefined',
                },
              ],
            }
          : { text: 'advanced', isError: false },
    );
    const tools = executor(run, ledger);
    await tools.callTool('write_file', { content: 'x' });
    await tools.callTool('write_file', { content: 'x' });
    const blocked = await tools.callTool('advance_task_step', { ref: 'p/1' });
    expect(blocked).toMatch(/^ERROR: /);
    expect(run).not.toHaveBeenCalledWith('advance_task_step', expect.anything());
  });

  it('caps a success to the budget and never caps an error', async () => {
    const long = 'x'.repeat(5_000);
    const tools = executor(async () => ({ text: long, isError: false }));
    const capped = await tools.callTool(
      'write_file',
      { path: 'a', content: 'b' },
      { budgetChars: 1_000 },
    );
    expect(capped.length).toBeLessThan(long.length);
    expect(capped).toContain('tool output truncated');
  });
});

// The desktop provider keeps the same engine-scoped limits; see its provider.test.ts.
describe('the phone engine host, as the desktop provider scopes tool limits', () => {
  it('stops forcing tool choice engine-wide once the model rejects it', () => {
    // Wild-caught on Nanbeige4.2-3B: `tool_choice: "required"` 400s for this
    // model with one tool or forty, under its own template or a generic
    // ChatML override, while qwen3.5-2b on the same binary accepts it. Since
    // forcing the call IS the local-model rescue, an unguarded rejection
    // makes the rescue fail and the turn burn its whole repair allowance.
    const provider = new PortableEngineHost();
    expect(provider.supportsForcedToolChoice).toBe(true);

    provider.noteForcedToolChoiceUnsupported();
    expect(provider.supportsForcedToolChoice).toBe(false);

    // Monotonic — a later turn never re-enables it and re-pays the 400.
    provider.noteForcedToolChoiceUnsupported();
    expect(provider.supportsForcedToolChoice).toBe(false);
  });

  it('does not degrade a smaller tool roster because a larger one blew the grammar limit', () => {
    const provider = new PortableEngineHost();
    provider.noteToolGrammarFloor(48, 'simplified');
    // The ceiling that failed is a grammar-SIZE limit, so it says nothing
    // about a small roster; degrading that one would cost tool-argument
    // fidelity for free.
    expect(provider.toolGrammarFloorFor(5)).toBe('none');
    expect(provider.toolGrammarFloorFor(48)).toBe('simplified');
    expect(provider.toolGrammarFloorFor(75)).toBe('simplified');
    // The floor only ever widens: a smaller failing count lowers the bar,
    // and a more permissive tier sticks.
    provider.noteToolGrammarFloor(12, 'strip-patterns');
    expect(provider.toolGrammarFloorFor(12)).toBe('simplified');
    provider.noteToolGrammarFloor(48, 'permissive');
    expect(provider.toolGrammarFloorFor(12)).toBe('permissive');
  });
});
