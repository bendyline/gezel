import type { ToolsetRuntime } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { isTrustedConstrainedToolset } from './trust.js';

const runtime: ToolsetRuntime = {
  kind: 'npm-package',
  package: '@bendyline/docblocks-cli',
  version: '2.0.0',
  sha256: 'd4e71b41dfd4ae5f90abac45a163c8dd9d5f5b01393f6237968ab5db205ce1f1',
  entry: 'dist/index.js',
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
