import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_PREFILL_EVENT,
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
});
