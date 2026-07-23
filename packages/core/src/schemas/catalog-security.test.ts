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
