import type { ToolsetRuntime } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { isTrustedConstrainedToolset } from './trust.js';

const runtime: ToolsetRuntime = {
  kind: 'npm-package',
  package: '@bendyline/docblocks-cli',
  version: '2.3.4',
  sha256: 'f9ebde4f7ea370778c9becf2a4f7a15fd435b4f2bcfdbcdf0f4242a1ef2db674',
  entry: 'dist/bin.js',
  args: ['mcp'],
  envHints: [],
};

describe('isTrustedConstrainedToolset', () => {
  it('accepts only the exact bundled, pinned DocBlocks runtime', () => {
    expect(
      isTrustedConstrainedToolset({
        toolsetId: 'docblocks',
        sourceId: 'bundled',
        runtime,
      }),
    ).toBe(true);
  });

  it.each([
    { sourceId: 'community', runtime },
    { sourceId: 'bundled', runtime: { ...runtime, args: ['mcp', '--allow-write', 'C:\\'] } },
    { sourceId: 'bundled', runtime: { ...runtime, sha256: 'not-a-sha' } },
    { sourceId: 'bundled', runtime: { ...runtime, package: 'lookalike-docblocks' } },
    { sourceId: 'bundled', runtime: { ...runtime, entry: 'dist/other.js' } },
  ])('rejects a spoofed or authority-expanded runtime', ({ sourceId, runtime: candidate }) => {
    expect(
      isTrustedConstrainedToolset({
        toolsetId: 'docblocks',
        sourceId,
        runtime: candidate as ToolsetRuntime,
      }),
    ).toBe(false);
  });
});
