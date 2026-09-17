import { describe, expect, it } from 'vitest';
import { artifactReadSlices } from './artifact-read-evidence.js';

const whole = {
  resolvedPath: 'data/github-pulls/pr-52/files/001.md',
  startLine: 1,
  endLine: 42,
  totalLines: 42,
};

describe('artifactReadSlices', () => {
  it('records a direct artifact read and a workspace-tool reroute', () => {
    expect(artifactReadSlices('read_artifact', whole)).toEqual([
      { path: whole.resolvedPath, startLine: 1, endLine: 42, totalLines: 42 },
    ]);
    expect(
      artifactReadSlices('read_file', { ...whole, resolvedSurface: 'artifact', rerouted: true }),
    ).toHaveLength(1);
    expect(artifactReadSlices('read_file', { ...whole, resolvedSurface: 'workspace' })).toEqual([]);
  });

  it('keeps only successful artifact entries from a batch read', () => {
    expect(
      artifactReadSlices('read_artifacts', {
        results: [
          { ...whole, status: 'ok', resolvedSurface: 'artifact' },
          { ...whole, status: 'error', resolvedSurface: 'artifact' },
          { ...whole, status: 'ok', resolvedSurface: 'workspace' },
        ],
      }),
    ).toEqual([{ path: whole.resolvedPath, startLine: 1, endLine: 42, totalLines: 42 }]);
  });

  it('does not treat search snippets or invalid ranges as a complete read', () => {
    expect(artifactReadSlices('grep_artifact', whole)).toEqual([]);
    expect(artifactReadSlices('read_artifact', { ...whole, endLine: 43 })).toEqual([]);
    expect(artifactReadSlices('read_artifact', { ...whole, resolvedPath: '' })).toEqual([]);
  });
});
