import type { WorkspaceCommandIndex } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { resolveTerminalInput } from './resolve.js';

function makeIndex(commands: WorkspaceCommandIndex['commands']): WorkspaceCommandIndex {
  return {
    meta: {
      version: 2,
      scannedAt: new Date().toISOString(),
      root: '/tmp/proj',
      durationMs: 0,
      fileCount: 0,
      commandCount: commands.length,
    },
    commands,
  };
}

describe('resolveTerminalInput', () => {
  it('returns empty for whitespace-only input', () => {
    expect(resolveTerminalInput('', null)).toEqual({ kind: 'empty' });
    expect(resolveTerminalInput('   \t  ', null)).toEqual({ kind: 'empty' });
  });

  it('intercepts pwd / clear without spawning', () => {
    expect(resolveTerminalInput('pwd', null)).toEqual({ kind: 'intercept', intercept: 'pwd' });
    expect(resolveTerminalInput('clear', null)).toEqual({ kind: 'intercept', intercept: 'clear' });
  });

  it('passes cd through to the shell as argv (no longer intercepted)', () => {
    // `cd` used to be intercepted server-side with a "use the folder
    // picker" hint. With persistent shells the shell handles `cd`
    // natively and the manager emits a workingDirChanged event when
    // its cwd drifts — so the resolver hands `cd` straight through.
    const result = resolveTerminalInput('cd packages/ui', null);
    expect(result.kind).toBe('argv');
    if (result.kind !== 'argv') return;
    expect(result.bin).toBe('cd');
    expect(result.args).toEqual(['packages/ui']);
  });

  it('returns raw argv when no index match', () => {
    const result = resolveTerminalInput('git status', null);
    expect(result.kind).toBe('argv');
    if (result.kind !== 'argv') return;
    expect(result.bin).toBe('git');
    expect(result.args).toEqual(['status']);
    expect(result.resolvedFrom).toBeUndefined();
  });

  it('resolves a typed name through the workspace index', () => {
    const index = makeIndex([
      { name: 'build', kind: 'npm-script', source: 'package.json', run: 'pnpm run build' },
    ]);
    const result = resolveTerminalInput('build', index);
    expect(result.kind).toBe('argv');
    if (result.kind !== 'argv') return;
    expect(result.bin).toBe('pnpm');
    expect(result.args).toEqual(['run', 'build']);
    expect(result.resolvedFrom).toBe('build');
    expect(result.matchedKind).toBe('npm-script');
  });

  it('appends extra user args after an index-resolved command', () => {
    const index = makeIndex([
      { name: 'test', kind: 'npm-script', source: 'package.json', run: 'pnpm run test' },
    ]);
    const result = resolveTerminalInput('test --watch packages/core', index);
    expect(result.kind).toBe('argv');
    if (result.kind !== 'argv') return;
    expect(result.args).toEqual(['run', 'test', '--watch', 'packages/core']);
  });

  it('parses double-quoted arguments correctly', () => {
    const result = resolveTerminalInput(`git commit -m "fix: a bug"`, null);
    expect(result.kind).toBe('argv');
    if (result.kind !== 'argv') return;
    expect(result.bin).toBe('git');
    expect(result.args).toEqual(['commit', '-m', 'fix: a bug']);
  });

  it('parses single-quoted arguments literally', () => {
    const result = resolveTerminalInput(`echo 'hello $USER'`, null);
    expect(result.kind).toBe('argv');
    if (result.kind !== 'argv') return;
    expect(result.args).toEqual(['hello $USER']);
  });

  it('returns parseError for unterminated quotes', () => {
    const result = resolveTerminalInput(`echo "oops`, null);
    expect(result.kind).toBe('parseError');
  });

  it('prefers index match over raw pass-through', () => {
    // User typed `ls` but the index promotes a workspace alias.
    const index = makeIndex([
      {
        name: 'ls',
        kind: 'workspace-script',
        source: 'scripts/ls.sh',
        run: './scripts/ls.sh',
      },
    ]);
    const result = resolveTerminalInput('ls -la', index);
    expect(result.kind).toBe('argv');
    if (result.kind !== 'argv') return;
    expect(result.bin).toBe('./scripts/ls.sh');
    expect(result.resolvedFrom).toBe('ls -la');
  });
});

describe('resolveTerminalInput — craftbook commands', () => {
  // `command` (a short alias) intentionally differs from `id` so the
  // alias-vs-id matching is exercised.
  const review = {
    id: 'pull-request-review',
    command: 'pr-review',
    paramSchema: {
      type: 'object',
      properties: {
        focus: { type: 'string' },
        intensity: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
    },
  };

  it('recognizes by command alias and by id', () => {
    const byAlias = resolveTerminalInput('pr-review', null, [review]);
    expect(byAlias.kind).toBe('craftbook');
    if (byAlias.kind === 'craftbook') expect(byAlias.id).toBe('pull-request-review');

    const byId = resolveTerminalInput('pull-request-review', null, [review]);
    expect(byId.kind).toBe('craftbook');
    if (byId.kind === 'craftbook') expect(byId.id).toBe('pull-request-review');
  });

  it('parses positional params in declaration order', () => {
    const r = resolveTerminalInput('pr-review security high', null, [review]);
    expect(r.kind).toBe('craftbook');
    if (r.kind !== 'craftbook') return;
    expect(r.params).toEqual({ focus: 'security', intensity: 'high' });
  });

  it('parses key=value params (any/no dashes)', () => {
    const r = resolveTerminalInput('pr-review intensity=high', null, [review]);
    expect(r.kind).toBe('craftbook');
    if (r.kind !== 'craftbook') return;
    expect(r.params).toEqual({ intensity: 'high' });

    const dashed = resolveTerminalInput('pr-review --intensity=low', null, [review]);
    expect(dashed.kind).toBe('craftbook');
    if (dashed.kind === 'craftbook') expect(dashed.params).toEqual({ intensity: 'low' });
  });

  it('rejects an out-of-range enum value', () => {
    const r = resolveTerminalInput('pr-review security nuclear', null, [review]);
    expect(r.kind).toBe('parseError');
    if (r.kind === 'parseError') expect(r.message).toMatch(/intensity.*low\|medium\|high/);
  });

  it('rejects a missing required param', () => {
    const requiredFocus = {
      id: 'x',
      command: 'x',
      paramSchema: {
        type: 'object',
        properties: { focus: { type: 'string' } },
        required: ['focus'],
      },
    };
    const r = resolveTerminalInput('x', null, [requiredFocus]);
    expect(r.kind).toBe('parseError');
    if (r.kind === 'parseError') expect(r.message).toMatch(/missing required parameter "focus"/);
  });

  it('rejects an extra positional token past the declared params', () => {
    // focus=a, intensity=low (valid), then `c` has no param to land on.
    const r = resolveTerminalInput('pr-review a low c', null, [review]);
    expect(r.kind).toBe('parseError');
    if (r.kind === 'parseError') expect(r.message).toMatch(/unexpected argument "c"/);
  });

  it('wins over a same-named workspace command (checked first)', () => {
    const index = makeIndex([
      {
        name: 'pull-request-review',
        kind: 'npm-script',
        source: 'package.json',
        run: 'npm run pull-request-review',
      },
    ]);
    const r = resolveTerminalInput('pull-request-review', index, [review]);
    expect(r.kind).toBe('craftbook');
  });

  it('falls through to shell when no craftbook matches', () => {
    const r = resolveTerminalInput('pr-review', null, []);
    expect(r.kind).toBe('argv');
  });

  describe('mcp tools', () => {
    const tools = [{ name: 'fetch_url' }, { name: 'list_memories' }];

    it('recognizes a tool name and parses key=value args (scalar-coerced)', () => {
      const r = resolveTerminalInput('fetch_url url=https://x.dev raw=true n=3', null, null, tools);
      expect(r.kind).toBe('mcpTool');
      if (r.kind !== 'mcpTool') return;
      expect(r.name).toBe('fetch_url');
      expect(r.args).toEqual({ url: 'https://x.dev', raw: true, n: 3 });
    });

    it('accepts a trailing JSON object for complex args', () => {
      const r = resolveTerminalInput(
        'fetch_url { "url": "https://x.dev", "headers": {"a":"b"} }',
        null,
        null,
        tools,
      );
      expect(r.kind).toBe('mcpTool');
      if (r.kind !== 'mcpTool') return;
      expect(r.args).toEqual({ url: 'https://x.dev', headers: { a: 'b' } });
    });

    it('runs a no-arg tool', () => {
      const r = resolveTerminalInput('list_memories', null, null, tools);
      expect(r.kind).toBe('mcpTool');
      if (r.kind !== 'mcpTool') return;
      expect(r.args).toEqual({});
    });

    it('reports a parse error on malformed args', () => {
      expect(resolveTerminalInput('fetch_url not-a-kv', null, null, tools).kind).toBe('parseError');
      expect(resolveTerminalInput('fetch_url {bad json}', null, null, tools).kind).toBe(
        'parseError',
      );
    });

    it('falls through to shell when the token is not a tool', () => {
      expect(resolveTerminalInput('ls -la', null, null, tools).kind).toBe('argv');
    });

    it('craftbooks + index commands win over a same-named tool', () => {
      const idx = makeIndex([{ name: 'fetch_url', kind: 'bin', source: 'x', run: 'fetch_url' }]);
      // index command matches first → argv, not mcpTool
      expect(resolveTerminalInput('fetch_url', idx, null, tools).kind).toBe('argv');
    });
  });
});
