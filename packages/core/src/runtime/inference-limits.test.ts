import { describe, expect, it } from 'vitest';
import { portableInputLimitError } from './inference-limits.js';

describe('portable input transport admission', () => {
  it('leaves token fit to the provider without dropping content', () => {
    const messages = [{ content: JSON.stringify({ rows: Array(4000).fill({ amount: 12 }) }) }];
    expect(messages[0]!.content.length).toBeGreaterThan(9216);
    expect(portableInputLimitError(messages)).toBeNull();
  });
  it('bounds UTF-8 bytes across all messages', () => {
    expect(portableInputLimitError([{ content: 'a'.repeat(256 * 1024) }])).toBeNull();
    expect(
      portableInputLimitError([{ content: 'é'.repeat(128 * 1024) }, { content: 'x' }]),
    ).toContain('input size');
  });
  it('retains the native message-count boundary', () => {
    const messages = Array.from({ length: 128 }, () => ({ content: 'hello' }));
    expect(portableInputLimitError(messages)).toBeNull();
    expect(portableInputLimitError([...messages, { content: 'again' }])).toContain(
      'too many messages',
    );
  });
});
