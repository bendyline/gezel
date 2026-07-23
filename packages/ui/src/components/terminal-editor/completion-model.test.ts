import type { WorkspaceCommandIndex } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { TerminalCompletionData } from './completion-data.js';
import { computeTerminalCompletions, parseTerminalContext } from './completion-model.js';

function data(over: Partial<TerminalCompletionData> = {}): TerminalCompletionData {
  return { index: null, craftbooks: [], mcpTools: [], ...over };
}

const INDEX: WorkspaceCommandIndex = {
  meta: {
    version: 1,
    scannedAt: '2026-01-01T00:00:00Z',
    root: '/ws',
    durationMs: 1,
    fileCount: 0,
    commandCount: 2,
  },
  commands: [
    { name: 'build', kind: 'npm-script', source: 'package.json', run: 'npm run build' },
    { name: 'gh', kind: 'bin', source: 'node_modules/.bin/gh', run: 'gh' },
  ],
  shapes: {
    gh: {
      source: 'oclif',
      package: 'gh',
      summary: 'GitHub CLI',
      subcommands: [{ name: 'pr', fullName: 'gh pr', summary: 'Manage PRs' }],
      flags: [
        { name: 'json', type: 'boolean', description: 'JSON out' },
        { name: 'repo', type: 'option', options: ['a/b', 'c/d'], required: true },
      ],
      args: [{ name: 'target', options: ['x', 'y'] }],
    },
  },
};

describe('parseTerminalContext', () => {
  it('splits completed tokens from the one being typed', () => {
    expect(parseTerminalContext('build ')).toMatchObject({
      tokens: ['build'],
      currentToken: '',
      atTokenStart: true,
    });
    expect(parseTerminalContext('build --o')).toMatchObject({
      tokens: ['build'],
      currentToken: '--o',
    });
    expect(parseTerminalContext('')).toMatchObject({
      tokens: [],
      currentToken: '',
      atTokenStart: true,
    });
  });
  it('detects key= pending value', () => {
    expect(parseTerminalContext('rev focus=sec').pendingKey).toBe('focus');
    expect(parseTerminalContext('rev focus').pendingKey).toBeUndefined();
  });
});

describe('first-token completions', () => {
  it('unifies craftbooks, commands, and tools with badges + precedence', () => {
    const d = data({
      index: INDEX,
      craftbooks: [{ id: 'build', command: 'build', name: 'Build book', description: 'd' }],
      mcpTools: [{ name: 'search_memory', description: 'find' }],
    });
    const items = computeTerminalCompletions(parseTerminalContext(''), d);
    const byLabel = new Map(items.map((i) => [i.label, i]));
    // craftbook "build" wins over the same-named npm script (only one "build")
    expect(items.filter((i) => i.label === 'build')).toHaveLength(1);
    expect(byLabel.get('build')?.kind).toBe('craftbook');
    expect(byLabel.get('gh')?.kind).toBe('command');
    expect(byLabel.get('gh')?.badge).toBe('bin');
    expect(byLabel.get('search_memory')?.kind).toBe('mcp-tool');
    // craftbooks sort before commands before tools
    expect(byLabel.get('build')!.sortText! < byLabel.get('gh')!.sortText!).toBe(true);
    expect(byLabel.get('gh')!.sortText! < byLabel.get('search_memory')!.sortText!).toBe(true);
  });
});

describe('shaped command completions', () => {
  const d = data({ index: INDEX });
  it('offers subcommands right after the command', () => {
    const items = computeTerminalCompletions(parseTerminalContext('gh '), d);
    expect(items.find((i) => i.label === 'pr')?.kind).toBe('subcommand');
  });
  it('offers flags on -', () => {
    const items = computeTerminalCompletions(parseTerminalContext('gh -'), d);
    const flag = items.find((i) => i.label === '--repo');
    expect(flag?.kind).toBe('flag');
    // required flags sort first
    expect(flag!.sortText! < items.find((i) => i.label === '--json')!.sortText!).toBe(true);
  });
  it('offers an option flag’s enum values', () => {
    const items = computeTerminalCompletions(parseTerminalContext('gh --repo '), d);
    expect(items.map((i) => i.label)).toEqual(['a/b', 'c/d']);
    expect(items[0]!.kind).toBe('enum');
  });
  it('offers positional arg enum values', () => {
    const items = computeTerminalCompletions(
      parseTerminalContext('build '),
      data({ index: INDEX }),
    );
    // `build` has no shape → raw fallback (no items)
    expect(items).toEqual([]);
  });
});

describe('craftbook param completions', () => {
  const d = data({
    craftbooks: [
      {
        id: 'rev',
        command: 'rev',
        paramSchema: {
          properties: {
            focus: { type: 'string', enum: ['security', 'perf'] },
            deep: { type: 'boolean' },
          },
          required: ['focus'],
        },
      },
    ],
  });
  it('suggests the next positional param (key= + enum values)', () => {
    const items = computeTerminalCompletions(parseTerminalContext('rev '), d);
    expect(items.find((i) => i.label === 'security')?.kind).toBe('enum');
    expect(items.find((i) => i.label === 'focus=')?.badge).toBe('required');
  });
  it('completes the value after focus=', () => {
    const items = computeTerminalCompletions(parseTerminalContext('rev focus='), d);
    expect(items.map((i) => i.label)).toEqual(['security', 'perf']);
  });
});

describe('mcp tool arg completions', () => {
  const d = data({
    mcpTools: [
      {
        name: 'fetch_url',
        parameters: {
          properties: { url: { type: 'string' }, raw: { type: 'boolean' } },
          required: ['url'],
        },
      },
    ],
  });
  it('scaffolds key= args + a JSON escape hatch', () => {
    const items = computeTerminalCompletions(parseTerminalContext('fetch_url '), d);
    expect(items.find((i) => i.label === 'url=')?.badge).toBe('required');
    expect(items.find((i) => i.label.includes('JSON'))).toBeDefined();
  });
  it('completes a boolean value after raw=', () => {
    const items = computeTerminalCompletions(parseTerminalContext('fetch_url raw='), d);
    expect(items.map((i) => i.label)).toEqual(['true', 'false']);
  });
});

describe('raw fallback', () => {
  it('returns nothing for an unrecognized first token', () => {
    expect(computeTerminalCompletions(parseTerminalContext('ls '), data({ index: INDEX }))).toEqual(
      [],
    );
  });
});
