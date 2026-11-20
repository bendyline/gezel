import { describe, expect, it } from 'vitest';
import { looksLikeWindowsShortName } from './path-rules.js';
import {
  isReservedDiffpackArtifactPath,
  isReservedPromptDraftArtifactPath,
  isReservedShadowArtifactPath,
  touchesReservedDiffpackArtifactPath,
} from './shadow-paths.js';

describe('isReservedDiffpackArtifactPath', () => {
  it("covers everything the runtime writes in a pack folder, and not the gezel's notes", () => {
    for (const path of [
      'diffpacks/12/after/src/a.ts',
      'diffpacks/12/files/01-a.diff',
      'diffpacks/12/deletions.json',
      'diffpacks/12/operations.json',
      'Diffpacks/12/Manifest.json',
      'diffpacks/12/files./01.diff',
    ]) {
      expect(isReservedDiffpackArtifactPath(path), path).toBe(true);
    }
    for (const path of ['diffpacks/12/notes.md', 'diffpacks/12', 'diffpacks', 'notes/files/a']) {
      expect(isReservedDiffpackArtifactPath(path), path).toBe(false);
    }
  });

  it('counts the folders that hold a proposal when it is moved or deleted', () => {
    for (const path of [
      'diffpacks',
      'diffpacks/12',
      'diffpacks/12/files',
      'diffpacks/12/after/x',
    ]) {
      expect(touchesReservedDiffpackArtifactPath(path), path).toBe(true);
    }
    for (const path of ['diffpacks/12/notes.md', 'scratch/diffpacks', 'tasks/12']) {
      expect(touchesReservedDiffpackArtifactPath(path), path).toBe(false);
    }
  });
});

describe('looksLikeWindowsShortName', () => {
  it('matches the 8.3 aliases NTFS generates', () => {
    for (const name of [
      'DIFFPA~1',
      '_META~1.JSO',
      'GIT~1',
      'MESSA~12',
      'di3f2a~1',
      'PACKAG~1.JSO.',
    ]) {
      expect(looksLikeWindowsShortName(name), name).toBe(true);
    }
  });

  it('leaves longer names and other tildes alone', () => {
    for (const name of [
      'diffpacks',
      'draft~old-version.md',
      '~1.md.bak',
      'notes~',
      'a~b.txt',
      '~$doc.docx',
    ]) {
      expect(looksLikeWindowsShortName(name), name).toBe(false);
    }
  });
});

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
    // Windows opens `shadow./x.md` and `shadow /x.md` as `shadow/x.md`.
    expect(isReservedShadowArtifactPath('shadow./x.md')).toBe(true);
    expect(isReservedShadowArtifactPath('shadow /x.md')).toBe(true);
    expect(isReservedShadowArtifactPath('.../shadow/x.md')).toBe(true);
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
