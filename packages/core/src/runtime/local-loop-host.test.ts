import { describe, expect, it, vi } from 'vitest';
import { UnresolvedToolFailureLedger } from '../local-loop/unresolved-tool-failure-ledger.js';
import { PortableToolExecutor, type PortableToolOutcome } from './local-loop-host.js';

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
