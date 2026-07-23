import type { ChatMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { fitMessagesToBudget } from './manager.js';

const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({
  role,
  content,
  at: '2026-06-29T00:00:00.000Z',
});

describe('fitMessagesToBudget (deterministic context force-fit)', () => {
  it('is a no-op when the transcript already fits', () => {
    const messages = [msg('user', 'a'.repeat(100)), msg('assistant', 'b'.repeat(100))];
    const r = fitMessagesToBudget(messages, 10_000);
    expect(r.truncatedCount).toBe(0);
    expect(r.savedChars).toBe(0);
    expect(r.messages).toBe(messages); // same reference — untouched
  });

  it('truncates a single oversized message down to fit, preserving its role', () => {
    const messages = [msg('user', 'x'.repeat(50_000))];
    const r = fitMessagesToBudget(messages, 8_000);
    expect(r.truncatedCount).toBe(1);
    expect(r.messages[0]!.role).toBe('user'); // structure preserved
    expect(r.messages[0]!.content.length).toBeLessThanOrEqual(8_000);
    expect(r.messages[0]!.content).toContain('truncated to fit'); // marker present
    // total now within budget
    expect(r.messages.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(8_000);
  });

  it('keeps head AND tail of a truncated message (middle-out)', () => {
    const content = `HEAD_MARKER${'m'.repeat(40_000)}TAIL_MARKER`;
    const r = fitMessagesToBudget([msg('assistant', content)], 6_000);
    expect(r.messages[0]!.content.startsWith('HEAD_MARKER')).toBe(true);
    expect(r.messages[0]!.content.endsWith('TAIL_MARKER')).toBe(true);
  });

  it('truncates the largest contributors first until the total fits', () => {
    const messages = [
      msg('user', 'small'.repeat(100)), // 500 chars — under MIN_KEEP, untouched
      msg('assistant', 'big'.repeat(20_000)), // 60k
      msg('user', 'huge'.repeat(20_000)), // 80k
    ];
    const r = fitMessagesToBudget(messages, 20_000);
    expect(r.truncatedCount).toBeGreaterThanOrEqual(1);
    const total = r.messages.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(20_000);
    // the small message (≤ MIN_KEEP) is never touched
    expect(r.messages[0]!.content).toBe('small'.repeat(100));
  });

  it('never shrinks a message below the MIN_KEEP floor (best-effort when budget is tiny)', () => {
    // Budget smaller than MIN_KEEP*messages — can only reduce each to the floor.
    const messages = [msg('user', 'a'.repeat(30_000)), msg('assistant', 'b'.repeat(30_000))];
    const r = fitMessagesToBudget(messages, 1_000);
    for (const m of r.messages) {
      expect(m.content.length).toBeGreaterThanOrEqual(2_000); // FORCEFIT_MIN_KEEP_CHARS
    }
  });
});
