import { describe, expect, it } from 'vitest';
import { isReservedShadowArtifactPath } from './shadow-paths.js';

describe('isReservedShadowArtifactPath', () => {
  it('matches the shadow root and everything under it', () => {
    expect(isReservedShadowArtifactPath('shadow')).toBe(true);
    expect(isReservedShadowArtifactPath('shadow/docs/spec.docx_files/spec.md')).toBe(true);
    expect(isReservedShadowArtifactPath('Shadow/x.md')).toBe(true);
  });

  it('matches normalized and traversal-shaped forms', () => {
    expect(isReservedShadowArtifactPath('./shadow/x.md')).toBe(true);
    expect(isReservedShadowArtifactPath('shadow\\x.md')).toBe(true);
    expect(isReservedShadowArtifactPath('docs/../shadow/x.md')).toBe(true);
  });

  it('leaves ordinary artifact paths alone', () => {
    expect(isReservedShadowArtifactPath('reports/shadow-analysis.md')).toBe(false);
    expect(isReservedShadowArtifactPath('docs/shadow/x.md')).toBe(false);
    expect(isReservedShadowArtifactPath('shadowplay.md')).toBe(false);
    expect(isReservedShadowArtifactPath('')).toBe(false);
  });
});
