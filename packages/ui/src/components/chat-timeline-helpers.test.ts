import type { TimelineMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { mergeTimelineMessages } from './chat-timeline-helpers.js';

function message(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
  return {
    sessionId: 'session-1',
    gezelId: 'gezel-1',
    projectId: 'project-1',
    sessionTitle: 'A thread',
    sessionCreatedAt: '2026-09-01T10:00:00.000Z',
    sessionLastActivityAt: '2026-09-01T10:00:00.000Z',
    sessionProviderName: 'mock',
    role: 'user',
    content: 'Hello',
    at: '2026-09-01T10:00:00.000Z',
    ...overrides,
  } as TimelineMessage;
}

describe('mergeTimelineMessages', () => {
  it('lets a canonical refresh clear stale session error metadata', () => {
    const stale = message({
      sessionLastTurnError: 'engine stopped',
      sessionLastTurnErrorDetail: { code: 'native-engine-crash' },
    });
    const canonical = message();

    const merged = mergeTimelineMessages([stale], [canonical]);

    expect(merged).toEqual([canonical]);
    expect(merged[0]).not.toHaveProperty('sessionLastTurnError');
  });

  it('keeps older rows that are outside the refreshed page', () => {
    const older = message({ at: '2026-08-31T10:00:00.000Z', content: 'Older' });
    const newest = message();

    expect(mergeTimelineMessages([older], [newest])).toEqual([older, newest]);
  });
});
