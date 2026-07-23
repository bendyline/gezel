import type { ChatEventEnvelope } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { updateActiveTraySessions } from './tray-activity.js';

function envelope(sessionId: string, event: ChatEventEnvelope['event']): ChatEventEnvelope {
  return { sessionId, gezelId: 'gezel-1', projectId: 'project-1', event };
}

describe('updateActiveTraySessions', () => {
  it('enters working on a user message and returns to idle on done', () => {
    const active = new Set<string>();
    expect(
      updateActiveTraySessions(
        active,
        envelope('session-1', {
          type: 'user_message',
          message: { role: 'user', content: 'Build it', at: '2026-07-18T00:00:00.000Z' },
        }),
      ),
    ).toBe(true);
    expect(active).toEqual(new Set(['session-1']));

    expect(updateActiveTraySessions(active, envelope('session-1', { type: 'done' }))).toBe(true);
    expect(active.size).toBe(0);
  });

  it('stays working until every concurrent session finishes', () => {
    const active = new Set<string>();
    const start = (sessionId: string) =>
      envelope(sessionId, {
        type: 'user_message',
        message: { role: 'user', content: 'Go', at: '2026-07-18T00:00:00.000Z' },
      });

    expect(updateActiveTraySessions(active, start('session-1'))).toBe(true);
    expect(updateActiveTraySessions(active, start('session-2'))).toBe(false);
    expect(updateActiveTraySessions(active, envelope('session-1', { type: 'done' }))).toBe(false);
    expect(
      updateActiveTraySessions(active, envelope('session-2', { type: 'error', error: 'x' })),
    ).toBe(true);
  });

  it('ignores non-lifecycle events', () => {
    const active = new Set(['session-1']);
    expect(
      updateActiveTraySessions(active, envelope('session-1', { type: 'delta', content: 'Hi' })),
    ).toBe(false);
    expect(active).toEqual(new Set(['session-1']));
  });
});
