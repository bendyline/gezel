import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_PREFILL_EVENT,
  mergeComposerPrefill,
  queueComposerPrefill,
  takeComposerPrefill,
  takeComposerTaskLaunch,
} from './composer-prefill.js';

describe('composer prefill handoff', () => {
  it('delivers a queued draft once and notifies an already-mounted composer', () => {
    const listener = vi.fn();
    window.addEventListener(COMPOSER_PREFILL_EVENT, listener);

    queueComposerPrefill('project-prefill-test', 'Please inspect this failure.');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { projectId: 'project-prefill-test' } }),
    );
    expect(takeComposerPrefill('project-prefill-test')).toEqual({
      markdown: 'Please inspect this failure.',
      replace: false,
    });
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

describe('a prefill with its task attached', () => {
  it('hands the launch over once, beside the sentence it came with', () => {
    const launch = {
      origin: 'user' as const,
      craftbookId: 'tidy-spreadsheet',
      params: {},
      inputs: { source: { from: 'sample' as const, sampleId: 'club-members' } },
    };
    queueComposerPrefill('default', 'Tidy up this spreadsheet.', launch);
    expect(takeComposerPrefill('default')).toEqual({
      markdown: 'Tidy up this spreadsheet.',
      replace: false,
    });
    expect(takeComposerTaskLaunch('default')).toEqual(launch);
    expect(takeComposerTaskLaunch('default')).toBeUndefined();
  });

  it('drops a launch left over from an earlier prefill', () => {
    queueComposerPrefill('default', 'One', {
      origin: 'user',
      craftbookId: 'x',
      params: {},
    });
    queueComposerPrefill('default', 'Plan a trip to Lisbon.');
    expect(takeComposerTaskLaunch('default')).toBeUndefined();
  });

  it('asks the composer to detach its task when a replacing prefill brings none', () => {
    queueComposerPrefill('default', 'Plan a trip to Lisbon.', undefined, { replace: true });
    expect(takeComposerPrefill('default')).toEqual({
      markdown: 'Plan a trip to Lisbon.',
      replace: true,
    });
    expect(takeComposerTaskLaunch('default')).toBeNull();
    expect(takeComposerTaskLaunch('default')).toBeUndefined();
  });
});
