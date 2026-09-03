import { afterEach, describe, expect, it } from 'vitest';
import {
  composerDraftKey,
  forgetDraft,
  moveActiveDraftId,
  promptDraftSlotKey,
  readActiveDraftId,
  readDraftText,
  resetComposerDrafts,
  writeActiveDraftId,
  writeDraftText,
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

describe('promptDraftSlotKey', () => {
  it('gives each thread its own slot, and one to the thread that does not exist yet', () => {
    const base = { projectId: 'default', gezelId: 'tomas' };
    const onThread = promptDraftSlotKey({ ...base, sessionId: 's1' });
    const otherThread = promptDraftSlotKey({ ...base, sessionId: 's2' });
    const newThread = promptDraftSlotKey({ ...base, sessionId: null });
    expect(new Set([onThread, otherThread, newThread]).size).toBe(3);
    expect(newThread.endsWith('|new')).toBe(true);
  });
});

describe('the slot index', () => {
  it('remembers which draft a slot had open', () => {
    writeActiveDraftId('slot', '2026-09-03-0001');
    expect(readActiveDraftId('slot')).toBe('2026-09-03-0001');
    expect(readActiveDraftId('other')).toBeUndefined();
  });

  it('forgets a slot when handed nothing', () => {
    writeActiveDraftId('slot', '2026-09-03-0001');
    writeActiveDraftId('slot', undefined);
    expect(readActiveDraftId('slot')).toBeUndefined();
  });

  it('re-points a slot without picking up what the destination held', () => {
    writeActiveDraftId('old', '2026-09-03-0001');
    writeActiveDraftId('new', '2026-09-03-0002');
    moveActiveDraftId('old', 'new', '2026-09-03-0001');
    expect(readActiveDraftId('old')).toBeUndefined();
    expect(readActiveDraftId('new')).toBe('2026-09-03-0001');
  });

  it('evicts the least recently used slot past the cap', () => {
    for (let i = 0; i < 64; i += 1) writeActiveDraftId(`k${i}`, `2026-09-03-${i}`);
    writeActiveDraftId('k0', '2026-09-03-0000');
    writeActiveDraftId('overflow', '2026-09-03-9999');
    expect(readActiveDraftId('k1')).toBeUndefined();
    expect(readActiveDraftId('k0')).toBe('2026-09-03-0000');
    expect(readActiveDraftId('overflow')).toBe('2026-09-03-9999');
  });
});

describe('the text cache', () => {
  it('round-trips the last known text for a draft', () => {
    writeDraftText('2026-09-03-0001', 'half a thought');
    expect(readDraftText('2026-09-03-0001')).toBe('half a thought');
    expect(readDraftText('2026-09-03-0002')).toBeUndefined();
  });

  it('keeps an empty draft distinguishable from one it has never seen', () => {
    // Disk is the source of truth now, so an empty string is a real answer:
    // it means "loaded, and empty", not "unknown".
    writeDraftText('2026-09-03-0001', '');
    expect(readDraftText('2026-09-03-0001')).toBe('');
  });

  it('drops a draft and every slot pointing at it', () => {
    writeDraftText('2026-09-03-0001', 'text');
    writeActiveDraftId('slot-a', '2026-09-03-0001');
    writeActiveDraftId('slot-b', '2026-09-03-0001');
    writeActiveDraftId('slot-c', '2026-09-03-0002');
    forgetDraft('2026-09-03-0001');
    expect(readDraftText('2026-09-03-0001')).toBeUndefined();
    expect(readActiveDraftId('slot-a')).toBeUndefined();
    expect(readActiveDraftId('slot-b')).toBeUndefined();
    expect(readActiveDraftId('slot-c')).toBe('2026-09-03-0002');
  });
});
