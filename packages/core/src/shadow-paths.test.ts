import { describe, expect, it } from 'vitest';
import { isReservedPromptDraftArtifactPath, isReservedShadowArtifactPath } from './shadow-paths.js';

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

describe('isReservedPromptDraftArtifactPath', () => {
  it('matches the prompts root and everything under it', () => {
    expect(isReservedPromptDraftArtifactPath('prompts')).toBe(true);
    expect(isReservedPromptDraftArtifactPath('prompts/2026-09-03-0001/message.md')).toBe(true);
    expect(isReservedPromptDraftArtifactPath('prompts/2026-09-03-0001/message_files/a.png')).toBe(
      true,
    );
    expect(isReservedPromptDraftArtifactPath('Prompts/x.md')).toBe(true);
  });

  it('matches normalized and traversal-shaped forms', () => {
    expect(isReservedPromptDraftArtifactPath('./prompts/x.md')).toBe(true);
    expect(isReservedPromptDraftArtifactPath('prompts\\x.md')).toBe(true);
    expect(isReservedPromptDraftArtifactPath('reports/../prompts/x.md')).toBe(true);
  });

  it('leaves ordinary artifact paths alone', () => {
    expect(isReservedPromptDraftArtifactPath('reports/prompts-review.md')).toBe(false);
    expect(isReservedPromptDraftArtifactPath('docs/prompts/x.md')).toBe(false);
    expect(isReservedPromptDraftArtifactPath('promptsy.md')).toBe(false);
    expect(isReservedPromptDraftArtifactPath('')).toBe(false);
  });
});
