import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeOpenKnowledge, queueOpenKnowledge } from './pending-open-knowledge.js';

describe('pending-open-knowledge mailbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    consumeOpenKnowledge(); // drain between tests
  });

  it('is one-shot', () => {
    queueOpenKnowledge({ catalogId: 'shop-notes', documentId: 'dovetails' });
    expect(consumeOpenKnowledge()).toEqual({ catalogId: 'shop-notes', documentId: 'dovetails' });
    expect(consumeOpenKnowledge()).toBeNull();
  });

  it('drops a stale intent past the TTL', () => {
    queueOpenKnowledge({ catalogId: 'shop-notes' });
    vi.advanceTimersByTime(11_000);
    expect(consumeOpenKnowledge()).toBeNull();
  });

  it('a later queue replaces an earlier one', () => {
    queueOpenKnowledge({ catalogId: 'a' });
    queueOpenKnowledge({ catalogId: 'b' });
    expect(consumeOpenKnowledge()).toEqual({ catalogId: 'b' });
  });
});
