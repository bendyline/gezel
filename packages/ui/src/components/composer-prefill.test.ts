import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_PREFILL_EVENT,
  mergeComposerPrefill,
  queueComposerPrefill,
  takeComposerPrefill,
} from './composer-prefill.js';

describe('composer prefill handoff', () => {
  it('delivers a queued draft once and notifies an already-mounted composer', () => {
    const listener = vi.fn();
    window.addEventListener(COMPOSER_PREFILL_EVENT, listener);

    queueComposerPrefill('project-prefill-test', 'Please inspect this failure.');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { projectId: 'project-prefill-test' } }),
    );
    expect(takeComposerPrefill('project-prefill-test')).toBe('Please inspect this failure.');
    expect(takeComposerPrefill('project-prefill-test')).toBeUndefined();

    window.removeEventListener(COMPOSER_PREFILL_EVENT, listener);
  });

  it('adds a prefill below the draft, but never the same block twice', () => {
    const opener = 'I want to start a project — can you help me work out what it needs?';
    expect(mergeComposerPrefill('', opener)).toBe(opener);
    expect(mergeComposerPrefill(opener, opener)).toBeNull();
    expect(mergeComposerPrefill(`Hi.\n\n${opener}\n`, opener)).toBeNull();
    expect(mergeComposerPrefill('Hi.', opener)).toBe(`Hi.\n\n${opener}`);
    // Contained in a longer sentence is not the same block.
    expect(mergeComposerPrefill(`${opener} Quickly.`, opener)).toBe(
      `${opener} Quickly.\n\n${opener}`,
    );
  });
});
