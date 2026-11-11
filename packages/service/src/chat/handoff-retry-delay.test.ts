import {
  CapacityDeniedError,
  EngineBusyError,
} from '@bendyline/gezel-inference/internal/providers/native/capacity-broker';
import { describe, expect, it } from 'vitest';
import { handoffRetryDelayMs, isEngineRefusal } from './handoff-retry-delay.js';

const DENIED =
  'Not enough graphics memory to load qwen3.5-9b-q4 (about 6.3 GB on the card). The graphics card has 2.2 GB free of 31.9 GB.';

describe('handoffRetryDelayMs', () => {
  it('waits longer before each retry of a turn the engine refused', () => {
    const refusal = new CapacityDeniedError(DENIED);
    expect(handoffRetryDelayMs(refusal, 1)).toBe(2_000);
    expect(handoffRetryDelayMs(refusal, 2)).toBe(8_000);
    expect(
      handoffRetryDelayMs(new EngineBusyError('llama-cpp:a:0 did not drain within 30s'), 1),
    ).toBe(2_000);
  });

  it('recognizes a refusal that lost its code on the way up', () => {
    expect(isEngineRefusal(new Error(DENIED))).toBe(true);
    expect(handoffRetryDelayMs(new Error(DENIED), 1)).toBe(2_000);
  });

  it('retries a turn that ran and failed without waiting', () => {
    const ran = new Error('[llama.cpp] aborting — `read_file` answered "not found" 5 times');
    expect(isEngineRefusal(ran)).toBe(false);
    expect(handoffRetryDelayMs(ran, 1)).toBe(0);
  });

  it('does not wait on a model that needs an engine restart', () => {
    const resident = new CapacityDeniedError('qwen is running with too small a window', {
      reason: 'resident-below-minimum',
    });
    expect(handoffRetryDelayMs(resident, 1)).toBe(0);
  });
});
