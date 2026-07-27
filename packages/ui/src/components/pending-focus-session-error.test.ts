import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeFocusSessionError, queueFocusSessionError } from './pending-focus-session-error.js';

afterEach(() => {
  vi.useRealTimers();
  // Drain whatever a test left behind so the module-level mailbox doesn't
  // leak into the next one.
  consumeFocusSessionError('p1');
  consumeFocusSessionError('p2');
});

describe('pending focus-session-error intent', () => {
  it('returns nothing when no jump was requested', () => {
    expect(consumeFocusSessionError('p1')).toBeNull();
  });

  it('hands the intent to the matching project, exactly once', () => {
    queueFocusSessionError({ projectId: 'p1', sessionId: 's1' });
    expect(consumeFocusSessionError('p1')).toEqual({ projectId: 'p1', sessionId: 's1' });
    expect(consumeFocusSessionError('p1')).toBeNull();
  });

  it('ignores a consume from a different project (and leaves the intent queued)', () => {
    queueFocusSessionError({ projectId: 'p1', sessionId: 's1' });
    expect(consumeFocusSessionError('p2')).toBeNull();
    expect(consumeFocusSessionError('p1')).toEqual({ projectId: 'p1', sessionId: 's1' });
  });

  it('drops a stale intent rather than jumping on a later navigation', () => {
    vi.useFakeTimers();
    queueFocusSessionError({ projectId: 'p1', sessionId: 's1' });
    vi.advanceTimersByTime(11_000);
    expect(consumeFocusSessionError('p1')).toBeNull();
  });
});
