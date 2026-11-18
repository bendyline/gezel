import type { Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { stepGateRejectedSince } from './gate-repair-turn.js';

const SINCE = '2026-11-18T03:05:21.095Z';

function taskWith(step: Record<string, unknown>): Pick<Task, 'craftbook'> {
  return {
    craftbook: { steps: [{ id: 'review-batch', name: 'Review', ...step }] },
  } as unknown as Pick<Task, 'craftbook'>;
}

describe('stepGateRejectedSince', () => {
  it('is true when the gate rejected the step during the send', () => {
    const task = taskWith({
      lastGateReject: {
        messageFingerprint: '1xxwej0',
        message: 'V3-1 claim is too long.',
        at: '2026-11-18T03:11:39.859Z',
      },
    });
    expect(stepGateRejectedSince(task, 'review-batch', SINCE)).toBe(true);
  });

  it('reads the attempt history when a self-looping gate cleared the last rejection', () => {
    const task = taskWith({
      gateAttemptHistory: [
        {
          at: '2026-11-18T02:47:01.041Z',
          attempt: 1,
          signatureHash: 'cb319643a5bcae08',
          messageFingerprint: 'ecisne',
        },
        {
          at: '2026-11-18T03:11:39.859Z',
          attempt: 2,
          signatureHash: 'cb319643a5bcae08',
          messageFingerprint: '1xxwej0',
        },
      ],
    });
    expect(stepGateRejectedSince(task, 'review-batch', SINCE)).toBe(true);
  });

  it('is false for a rejection from before the send, another step, or no rejection at all', () => {
    const earlier = taskWith({
      lastGateReject: {
        messageFingerprint: 'ecisne',
        message: 'Add the heading.',
        at: '2026-11-18T02:47:01.041Z',
      },
    });
    expect(stepGateRejectedSince(earlier, 'review-batch', SINCE)).toBe(false);
    expect(stepGateRejectedSince(earlier, 'open-batch', '2026-11-18T02:00:00.000Z')).toBe(false);
    expect(stepGateRejectedSince(taskWith({}), 'review-batch', SINCE)).toBe(false);
    expect(stepGateRejectedSince(null, 'review-batch', SINCE)).toBe(false);
    expect(stepGateRejectedSince(earlier, 'review-batch', 'not a date')).toBe(false);
  });
});
