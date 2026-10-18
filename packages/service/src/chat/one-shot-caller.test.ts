import { ProviderQueue } from '@bendyline/gezel-inference/internal/providers/queue';
import { describe, expect, it } from 'vitest';
import { sessionHoldsQueueSlot } from './one-shot-caller.js';

describe('sessionHoldsQueueSlot', () => {
  it('sees the caller holding the only slot of a one-slot engine', async () => {
    const queue = new ProviderQueue({ concurrency: 1 });
    const release = await queue.acquire({ lane: 'interactive', sessionId: 'meester' });
    expect(sessionHoldsQueueSlot(queue, 'meester')).toBe(true);
    expect(sessionHoldsQueueSlot(queue, 'someone-else')).toBe(false);
    release();
    expect(sessionHoldsQueueSlot(queue, 'meester')).toBe(false);
  });

  it('never bypasses without a queue or a caller', () => {
    expect(sessionHoldsQueueSlot(undefined, 'meester')).toBe(false);
    expect(sessionHoldsQueueSlot(new ProviderQueue({ concurrency: 1 }), undefined)).toBe(false);
  });
});
