import { describe, expect, it } from 'vitest';
import { ACCESSORY_ARTIFACT_PREFIXES, isAccessoryArtifactPath } from './artifact-surface.js';

describe('isAccessoryArtifactPath', () => {
  it.each(ACCESSORY_ARTIFACT_PREFIXES)('recognizes the reserved %s prefix', (prefix) => {
    expect(isAccessoryArtifactPath(`${prefix}handoff.md`)).toBe(true);
  });

  it('normalizes relative and Windows-style paths', () => {
    expect(isAccessoryArtifactPath('./reviews/findings.md')).toBe(true);
    expect(isAccessoryArtifactPath('reports\\audit.md')).toBe(true);
  });

  it('leaves project source paths on the workspace surface', () => {
    expect(isAccessoryArtifactPath('src/reports/audit.ts')).toBe(false);
    expect(isAccessoryArtifactPath('report/audit.md')).toBe(false);
    expect(isAccessoryArtifactPath('reports.md')).toBe(false);
  });
});
