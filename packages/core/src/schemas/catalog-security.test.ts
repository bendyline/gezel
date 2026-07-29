import { describe, expect, it } from 'vitest';
import { ToolsetRuntimeSchema } from './catalog.js';

const validRuntime = {
  kind: 'npm-package' as const,
  package: '@example/tool',
  version: '1.2.3',
  sha256: 'a'.repeat(64),
  entry: 'dist/server.js',
};

describe('npm toolset runtime validation', () => {
  it('accepts a pinned, contained npm runtime', () => {
    expect(ToolsetRuntimeSchema.parse(validRuntime)).toMatchObject(validRuntime);
  });

  it.each(['../outside.js', 'dist/../../outside.js', '/absolute.js', 'dist\\server.js'])(
    'rejects unsafe runtime entry %s',
    (entry) => {
      expect(() => ToolsetRuntimeSchema.parse({ ...validRuntime, entry })).toThrow();
    },
  );

  it('rejects package ranges and unbounded process inputs', () => {
    expect(() => ToolsetRuntimeSchema.parse({ ...validRuntime, version: '^1.2.3' })).toThrow();
    expect(() =>
      ToolsetRuntimeSchema.parse({ ...validRuntime, args: Array.from({ length: 65 }, () => 'x') }),
    ).toThrow();
    expect(() => ToolsetRuntimeSchema.parse({ ...validRuntime, envHints: ['bad-name'] })).toThrow();
  });
});

describe('custom MCP runtime validation', () => {
  it('accepts project-file references without persisting the live command', () => {
    expect(
      ToolsetRuntimeSchema.parse({
        kind: 'custom-mcp',
        serverName: 'workspace-tools',
        transport: 'stdio',
        source: { kind: 'project-file', relativePath: '.vscode/mcp.json' },
      }),
    ).toMatchObject({
      kind: 'custom-mcp',
      args: [],
      envKeys: [],
      headerKeys: [],
    });
  });

  it('requires the executable or URL for explicit imports', () => {
    expect(() =>
      ToolsetRuntimeSchema.parse({
        kind: 'custom-mcp',
        serverName: 'local',
        transport: 'stdio',
        source: { kind: 'imported' },
      }),
    ).toThrow();
    expect(() =>
      ToolsetRuntimeSchema.parse({
        kind: 'custom-mcp',
        serverName: 'remote',
        transport: 'streamable-http',
        source: { kind: 'imported' },
      }),
    ).toThrow();
  });
});
