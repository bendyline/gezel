import { describe, expect, it } from 'vitest';
import { leadingSystemMessages, standaloneTurnMessages } from './standalone-turn.js';

describe('standalone turn messages', () => {
  const transcript = [
    { role: 'system', content: 'instructions' },
    { role: 'system', content: 'volatile band' },
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: 'now' },
    { role: 'tool', content: 'result' },
  ];
  it('keeps every leading system message and the turn from its start', () => {
    expect(leadingSystemMessages(transcript)).toBe(2);
    expect(standaloneTurnMessages(transcript, 4).map((m) => m.content)).toEqual([
      'instructions',
      'volatile band',
      'now',
      'result',
    ]);
  });
  it('never repeats a system message the turn start points into', () => {
    expect(standaloneTurnMessages(transcript, 0).map((m) => m.content)).toEqual([
      'instructions',
      'volatile band',
      'old',
      'old reply',
      'now',
      'result',
    ]);
  });
});
