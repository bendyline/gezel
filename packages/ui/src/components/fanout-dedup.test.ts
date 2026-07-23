import { describe, expect, it } from 'vitest';
import {
  FANOUT_DEDUP_WINDOW_MS,
  type FanoutDedupMessage,
  dedupeFanoutUserMessages,
} from './fanout-dedup.js';

function msg(
  at: string,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
): FanoutDedupMessage {
  return { at, sessionId, role, content };
}

describe('dedupeFanoutUserMessages', () => {
  it('drops a cross-session user duplicate inside the fan-out window', () => {
    // The exact shape from a reported @-mention duplicate: same user
    // prompt persisted into Leo's and Linnea's sessions within ~1ms,
    // followed by each gezel's response.
    const rows = [
      msg('2026-05-03T00:00:00.000Z', 'leo-sess', 'user', '@Linnea finish the game?'),
      msg('2026-05-03T00:00:00.001Z', 'linnea-sess', 'user', '@Linnea finish the game?'),
      msg('2026-05-03T00:00:10.000Z', 'leo-sess', 'assistant', 'on it'),
      msg('2026-05-03T00:00:20.000Z', 'linnea-sess', 'assistant', "I'll build it"),
    ];
    const out = dedupeFanoutUserMessages(rows);
    expect(out.map((r) => `${r.sessionId}:${r.role}`)).toEqual([
      'leo-sess:user',
      'leo-sess:assistant',
      'linnea-sess:assistant',
    ]);
  });

  it('keeps a same-session user repeat (real user intent, not fan-out)', () => {
    // User legitimately sends the same text twice in the same chat —
    // accidental double-send or a confirm. Both bubbles stay visible
    // so the user can see their own action.
    const rows = [
      msg('2026-05-03T00:00:00.000Z', 'leo-sess', 'user', 'hi'),
      msg('2026-05-03T00:00:01.000Z', 'leo-sess', 'user', 'hi'),
    ];
    expect(dedupeFanoutUserMessages(rows)).toHaveLength(2);
  });

  it('keeps a cross-session user repeat outside the fan-out window', () => {
    // Same content, different session, but separated by more than the
    // window — that's not fan-out, that's the user genuinely re-asking
    // the same thing in a different chat later.
    const rows = [
      msg('2026-05-03T00:00:00.000Z', 'leo-sess', 'user', 'hi'),
      msg(
        new Date(Date.parse('2026-05-03T00:00:00.000Z') + FANOUT_DEDUP_WINDOW_MS + 1).toISOString(),
        'linnea-sess',
        'user',
        'hi',
      ),
    ];
    expect(dedupeFanoutUserMessages(rows)).toHaveLength(2);
  });

  it('never drops assistant messages even with matching content', () => {
    // Two gezels happen to reply with identical text — keep both.
    // Assistant messages don't have a fan-out problem to solve.
    const rows = [
      msg('2026-05-03T00:00:10.000Z', 'leo-sess', 'assistant', 'done'),
      msg('2026-05-03T00:00:10.001Z', 'linnea-sess', 'assistant', 'done'),
    ];
    expect(dedupeFanoutUserMessages(rows)).toHaveLength(2);
  });

  it('handles a 3-way @-mention fan-out (mention two specialists at once)', () => {
    const rows = [
      msg('2026-05-03T00:00:00.000Z', 'leo-sess', 'user', '@Linnea @Kai go'),
      msg('2026-05-03T00:00:00.001Z', 'linnea-sess', 'user', '@Linnea @Kai go'),
      msg('2026-05-03T00:00:00.002Z', 'kai-sess', 'user', '@Linnea @Kai go'),
    ];
    const out = dedupeFanoutUserMessages(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.sessionId).toBe('leo-sess');
  });

  it('uses trimmed content for the equality check', () => {
    // The service might persist with trailing newline normalization
    // differing across sessions. A trim-equality match still folds
    // them as fan-out.
    const rows = [
      msg('2026-05-03T00:00:00.000Z', 'leo-sess', 'user', 'finish the game'),
      msg('2026-05-03T00:00:00.001Z', 'linnea-sess', 'user', '  finish the game  \n'),
    ];
    expect(dedupeFanoutUserMessages(rows)).toHaveLength(1);
  });

  it('empty input returns empty output', () => {
    expect(dedupeFanoutUserMessages([])).toEqual([]);
  });
});
