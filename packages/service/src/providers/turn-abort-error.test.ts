import { describe, expect, it } from 'vitest';
import { TurnAbortError } from './turn-abort-error.js';

describe('TurnAbortError', () => {
  it('puts the model corrective on message and the user summary on userMessage', () => {
    const err = new TurnAbortError(
      '[llama.cpp] stop re-emitting the whole file',
      'The turn was stopped.',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TurnAbortError');
    expect(err.message).toBe('[llama.cpp] stop re-emitting the whole file');
    expect(err.userMessage).toBe('The turn was stopped.');
  });

  it('is catchable as an Error and discriminable via instanceof', () => {
    const thrown = (() => {
      try {
        throw new TurnAbortError('model text', 'user text');
      } catch (e) {
        return e;
      }
    })();
    expect(thrown instanceof TurnAbortError).toBe(true);
    expect(thrown instanceof TurnAbortError ? thrown.userMessage : null).toBe('user text');
  });
});
