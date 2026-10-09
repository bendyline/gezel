import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../schemas/gezel.js';
import {
  historyExchanges,
  latestExchanges,
  portableConversationHistory,
} from './conversation-history.js';

const at = '2026-10-06T12:00:00.000Z';
function move(index: number): ChatMessage[] {
  return [
    { id: `u${index}`, role: 'user', content: `[Checkers page]: move ${index}`, at, hidden: true },
    {
      id: `a${index}`,
      role: 'assistant',
      content: `Table talk ${index}.`,
      at,
      toolCalls: [
        {
          name: 'make_move',
          at,
          durationMs: 12,
          argsFull: '{"from":"b6","to":"a5"}',
          success: true,
          resultText: `board after move ${index}: ${'x'.repeat(200)}`,
        },
      ],
    },
  ];
}

describe('conversation history for a small model', () => {
  it('offers a lean form of older turns, keeping the results the latest turn acts on', () => {
    const history = portableConversationHistory([...move(1), ...move(2), ...move(3)]);
    expect(history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(history[1]!.content).toContain('board after move 1');
    expect(history[1]!.leanContent).toContain('Table talk 1.');
    expect(history[1]!.leanContent).toContain('"resultOmitted":true');
    expect(history[1]!.leanContent).not.toContain('board after move 1');
    expect(history[5]!.leanContent).toBeUndefined();
    expect(history[5]!.content).toContain('board after move 3');
  });

  it('keeps the newest exchanges whole', () => {
    const history = portableConversationHistory([...move(1), ...move(2), ...move(3)]);
    expect(historyExchanges(history)).toBe(3);
    const kept = latestExchanges(history, 2);
    expect(kept.map((message) => message.content.split('\n')[0])).toEqual([
      '[Checkers page]: move 2',
      'Table talk 2.',
      '[Checkers page]: move 3',
      'Table talk 3.',
    ]);
    expect(latestExchanges(history, 0)).toEqual([]);
    expect(latestExchanges(history, 9)).toHaveLength(6);
  });
});
