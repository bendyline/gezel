import { afterEach, describe, expect, it } from 'vitest';
import {
  clearComposerDraft,
  composerDraftKey,
  moveComposerDraft,
  readComposerDraft,
  resetComposerDrafts,
  writeComposerDraft,
} from './composer-drafts.js';

afterEach(() => resetComposerDrafts());

describe('composerDraftKey', () => {
  it('separates surfaces that share a (project, gezel) pair', () => {
    const base = { projectId: 'default', gezelId: 'tomas' };
    expect(composerDraftKey({ ...base, scope: 'meester' })).not.toBe(
      composerDraftKey({ ...base, scope: 'gezel' }),
    );
    expect(composerDraftKey({ ...base, taskRef: 'default/7' })).not.toBe(composerDraftKey(base));
    expect(composerDraftKey({ ...base, craftbookRef: 'pr-review' })).not.toBe(
      composerDraftKey(base),
    );
  });

  it('is stable for the same address', () => {
    expect(composerDraftKey({ projectId: 'p', gezelId: 'g' })).toBe(
      composerDraftKey({ projectId: 'p', gezelId: 'g' }),
    );
  });
});

describe('draft storage', () => {
  it('round-trips a draft and reports an empty string for an unknown key', () => {
    writeComposerDraft('a', 'abcdef');
    expect(readComposerDraft('a')).toBe('abcdef');
    expect(readComposerDraft('b')).toBe('');
  });

  it('drops an all-whitespace draft rather than storing it', () => {
    writeComposerDraft('a', 'abcdef');
    writeComposerDraft('a', '  \n ');
    expect(readComposerDraft('a')).toBe('');
  });

  it('clears on demand', () => {
    writeComposerDraft('a', 'abcdef');
    clearComposerDraft('a');
    expect(readComposerDraft('a')).toBe('');
  });

  it('moves a live draft to a new address without picking up what was there', () => {
    writeComposerDraft('old', 'in progress');
    writeComposerDraft('new', 'stale');
    moveComposerDraft('old', 'new', 'in progress');
    expect(readComposerDraft('old')).toBe('');
    expect(readComposerDraft('new')).toBe('in progress');
  });

  it('evicts the least-recently-written draft past the cap', () => {
    for (let i = 0; i < 64; i += 1) writeComposerDraft(`k${i}`, `draft ${i}`);
    // Touching k0 makes k1 the oldest.
    writeComposerDraft('k0', 'draft 0 again');
    writeComposerDraft('overflow', 'newest');
    expect(readComposerDraft('k1')).toBe('');
    expect(readComposerDraft('k0')).toBe('draft 0 again');
    expect(readComposerDraft('overflow')).toBe('newest');
  });
});
