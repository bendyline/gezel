import { describe, expect, it } from 'vitest';
import {
  TERMINAL_BOTTOM_GRACE_MS,
  compareTimelineRows,
  nextTerminalBottomGraceExpiry,
} from './timeline-row-order.js';

type Row = {
  kind: 'message' | 'streaming' | 'terminal' | 'terminal-streaming';
  at: string;
  id: string;
};

const baseNow = Date.parse('2026-07-29T12:10:00.000Z');

function orderedIds(rows: Row[], nowMs = baseNow): string[] {
  return [...rows].sort((a, b) => compareTimelineRows(a, b, nowMs)).map((row) => row.id);
}

describe('timeline row ordering', () => {
  it('keeps a fresh terminal command below an active chat turn', () => {
    expect(
      orderedIds([
        {
          kind: 'terminal',
          id: 'command',
          at: '2026-07-29T12:05:00.000Z',
        },
        {
          kind: 'streaming',
          id: 'pending-chat',
          at: '2026-07-29T12:09:30.000Z',
        },
      ]),
    ).toEqual(['pending-chat', 'command']);
  });

  it('keeps fresh terminal work last when a chat reply completes afterward', () => {
    expect(
      orderedIds([
        {
          kind: 'terminal',
          id: 'command',
          at: '2026-07-29T12:08:00.000Z',
        },
        {
          kind: 'message',
          id: 'later-chat-reply',
          at: '2026-07-29T12:09:30.000Z',
        },
        {
          kind: 'terminal-streaming',
          id: 'terminal-output',
          at: '2026-07-29T12:08:00.100Z',
        },
      ]),
    ).toEqual(['later-chat-reply', 'command', 'terminal-output']);
  });

  it('returns an expired terminal row to normal chronology after five minutes', () => {
    const terminalAt = baseNow - TERMINAL_BOTTOM_GRACE_MS - 1;
    expect(
      orderedIds([
        {
          kind: 'terminal',
          id: 'old-command',
          at: new Date(terminalAt).toISOString(),
        },
        {
          kind: 'streaming',
          id: 'pending-chat',
          at: '2026-07-29T12:09:30.000Z',
        },
      ]),
    ).toEqual(['old-command', 'pending-chat']);
  });

  it('reports terminal grace expiries in chronological order', () => {
    const entries = [
      { at: '2026-07-29T12:09:00.000Z' },
      { at: '2026-07-29T12:07:00.000Z' },
      { at: 'not-a-date' },
    ];

    expect(nextTerminalBottomGraceExpiry(entries, baseNow)).toBe(
      Date.parse('2026-07-29T12:12:00.000Z'),
    );
    expect(nextTerminalBottomGraceExpiry(entries, Date.parse('2026-07-29T12:12:00.001Z'))).toBe(
      Date.parse('2026-07-29T12:14:00.000Z'),
    );
  });
});
