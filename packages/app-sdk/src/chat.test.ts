import { describe, expect, it } from 'vitest';
import { ToolRoundBreaks } from './chat.js';
import type { ChatTurnEvent } from './host-types.js';

function text(events: ChatTurnEvent[]): string {
  const breaks = new ToolRoundBreaks();
  return events
    .map((event) => breaks.apply(event))
    .map((event) => (event.type === 'delta' ? event.content : ''))
    .join('');
}

const tool: ChatTurnEvent = { type: 'tool', name: 'read_file', success: true };
const delta = (content: string): ChatTurnEvent => ({ type: 'delta', content });

describe('ToolRoundBreaks', () => {
  it('starts the text after a tool call on a new paragraph', () => {
    // npm ship audit, 2026-11: an app appending deltas showed
    // "…the move date.Lisbon office…".
    expect(
      text([
        delta('I will check the move date.'),
        tool,
        tool,
        delta('Lisbon office '),
        delta('opens in May.'),
      ]),
    ).toBe('I will check the move date.\n\nLisbon office opens in May.');
  });

  it('adds nothing before the first text or after the last', () => {
    expect(text([tool, delta('Revenue is up 12%.'), tool, { type: 'done' }])).toBe(
      'Revenue is up 12%.',
    );
  });

  it('starts over with each saved message', () => {
    expect(
      text([delta('First.'), tool, { type: 'complete', content: 'First.' }, delta('Second.')]),
    ).toBe('First.Second.');
  });
});
