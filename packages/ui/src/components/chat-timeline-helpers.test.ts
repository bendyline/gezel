import type { TimelineMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  hadWrapUpAtLoad,
  isExpectedAvailabilityError,
  isRetryableFailedTurn,
  mergeTimelineMessages,
  newestMessageAt,
  turnFailureShownElsewhere,
} from './chat-timeline-helpers.js';

describe('a turn waiting on its first download', () => {
  const nothingInstalled =
    'Local model: no model is installed yet. Download one from Settings → Artificial intelligence, then try again.';
  const downloading =
    'Local model: your model is 42% downloaded — hang tight. Send this again once it finishes and it will go through.';

  it('is an expected wait, never a bug to report', () => {
    expect(isExpectedAvailabilityError({ code: 'model-not-ready' })).toBe(true);
    expect(isExpectedAvailabilityError({ code: 'engine-not-ready' })).toBe(true);
  });

  it('treats an out-of-memory stop as the machine running short, still worth a Retry', () => {
    const oom = { code: 'native-engine-crash', panicKind: 'host-out-of-memory' };
    expect(isExpectedAvailabilityError(oom)).toBe(true);
    expect(isRetryableFailedTurn('[llama-cpp] on-device engine ran out of memory', oom)).toBe(true);
    expect(isExpectedAvailabilityError({ code: 'native-engine-crash' })).toBe(false);
  });

  it('treats a missing Windows runtime as the PC’s, and keeps Retry for after the install', () => {
    const missing = { code: 'native-engine-crash', panicKind: 'missing-runtime' };
    expect(isExpectedAvailabilityError(missing)).toBe(true);
    expect(isRetryableFailedTurn('[llama-cpp] on-device engine could not start', missing)).toBe(
      true,
    );
  });

  it('offers Retry only while something is on its way', () => {
    expect(isRetryableFailedTurn(downloading, { code: 'model-not-ready' })).toBe(true);
    expect(isRetryableFailedTurn(nothingInstalled, { code: 'model-not-ready' })).toBe(false);
    expect(isRetryableFailedTurn('engine is downloading', { code: 'engine-not-ready' })).toBe(true);
  });
});

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

// Home's folder invitation follows finished work, but must not land on top
// of a result the person is watching arrive.
describe('hadWrapUpAtLoad', () => {
  const asked = message({ at: '2026-09-01T10:00:00.000Z' });
  const wrapUp = message({
    role: 'assistant',
    synthetic: 'task-wrapup',
    at: '2026-09-01T10:10:00.000Z',
  });

  it('reads the newest message of the first load', () => {
    expect(newestMessageAt([asked, wrapUp])).toBe('2026-09-01T10:10:00.000Z');
    expect(newestMessageAt([wrapUp, asked])).toBe('2026-09-01T10:10:00.000Z');
    expect(newestMessageAt([])).toBe('');
  });

  it('counts a wrap-up the thread opened with', () => {
    expect(hadWrapUpAtLoad([asked, wrapUp], newestMessageAt([asked, wrapUp]))).toBe(true);
  });

  it('does not count one that landed during the visit', () => {
    expect(hadWrapUpAtLoad([asked, wrapUp], newestMessageAt([asked]))).toBe(false);
    // An empty thread at load, then the first request and its result.
    expect(hadWrapUpAtLoad([asked, wrapUp], newestMessageAt([]))).toBe(false);
  });

  it('counts one on an older page, which was there all along', () => {
    const earlier = message({
      role: 'assistant',
      synthetic: 'task-wrapup',
      at: '2026-08-30T09:00:00.000Z',
    });
    expect(hadWrapUpAtLoad([earlier, asked], newestMessageAt([asked]))).toBe(true);
  });

  it('holds until the first load answers', () => {
    expect(hadWrapUpAtLoad([asked, wrapUp], null)).toBe(false);
  });
});

describe('turnFailureShownElsewhere', () => {
  const engine =
    "On-device engine (llama-server, cuda) is downloading. It'll be ready shortly — try again in a moment.";
  const aborted = {
    synthetic: 'turn-aborted' as const,
    content: '',
    warnings: [engine],
    projectId: 'p1',
  };

  // A first message said the engine was downloading three times over.
  it('leaves the failure to the live slot while it shows it', () => {
    expect(turnFailureShownElsewhere(aborted, { liveError: engine, cardAcknowledged: false })).toBe(
      'live',
    );
    // A record with words of its own is still drawn.
    expect(
      turnFailureShownElsewhere(
        { ...aborted, content: 'Half a reply' },
        { liveError: engine, cardAcknowledged: false },
      ),
    ).toBeNull();
  });

  it('keeps only the placeholder while the session card tells it, until acknowledged', () => {
    const record = { ...aborted, sessionLastTurnError: engine };
    expect(turnFailureShownElsewhere(record, { cardAcknowledged: false })).toBe('card');
    expect(turnFailureShownElsewhere(record, { cardAcknowledged: true })).toBeNull();
    expect(
      turnFailureShownElsewhere({ ...record, synthetic: undefined }, { cardAcknowledged: false }),
    ).toBeNull();
  });
});
