import { describe, expect, it } from 'vitest';
import { parseGezelModelRef, translateMessagesWithPrefix } from './translate.js';

describe('parseGezelModelRef', () => {
  it('returns the bare ref after "gezel:"', () => {
    expect(parseGezelModelRef('gezel:maya')).toBe('maya');
    expect(parseGezelModelRef('gezel:550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('trims surrounding whitespace from the ref', () => {
    expect(parseGezelModelRef(' gezel: voorman ')).toBe('voorman');
  });

  it('returns null for non-gezel model fields', () => {
    expect(parseGezelModelRef('copilot:gpt-4o')).toBeNull();
    expect(parseGezelModelRef('llama-cpp:qwen3-4b')).toBeNull();
    expect(parseGezelModelRef('gpt-4o')).toBeNull();
  });

  it('returns null for an empty ref', () => {
    expect(parseGezelModelRef('gezel:')).toBeNull();
    expect(parseGezelModelRef('gezel: ')).toBeNull();
  });
});

describe('translateMessagesWithPrefix', () => {
  it('prepends the gezel persona to a caller-supplied system message', () => {
    const result = translateMessagesWithPrefix(
      [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hi' },
      ],
      'I am Maya, frontend engineer.',
    );
    expect(result.systemMessage).toBe('I am Maya, frontend engineer.\n\n---\n\nbe concise');
    expect(result.prompt).toBe('hi');
  });

  it('uses ONLY the persona when no system messages are present', () => {
    const result = translateMessagesWithPrefix([{ role: 'user', content: 'hi' }], 'I am Maya.');
    expect(result.systemMessage).toBe('I am Maya.');
  });

  it('passes through unchanged when persona is empty', () => {
    const result = translateMessagesWithPrefix(
      [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hi' },
      ],
      '',
    );
    expect(result.systemMessage).toBe('be concise');
  });

  it('preserves prior assistant/user turns as priorMessages', () => {
    const result = translateMessagesWithPrefix(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'turn1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'turn2' },
      ],
      'persona',
    );
    expect(result.priorMessages).toHaveLength(2);
    expect(result.prompt).toBe('turn2');
  });
});
