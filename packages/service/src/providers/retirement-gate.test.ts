import { describe, expect, it } from 'vitest';
import { ProviderRetirementGate, trackProviderOperations } from './retirement-gate.js';

describe('ProviderRetirementGate', () => {
  it('drains admitted work and rejects work started after retirement begins', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = {
      async generate(): Promise<string> {
        await blocked;
        return 'done';
      },
    };
    const gate = new ProviderRetirementGate();
    const tracked = trackProviderOperations(provider, gate, new Set(['generate']));

    const admitted = tracked.generate();
    gate.beginRetirement();
    let drained = false;
    const drain = gate.waitForIdle().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(drained).toBe(false);
    await expect(tracked.generate()).rejects.toThrow(/retired/);

    release();
    await expect(admitted).resolves.toBe('done');
    await drain;
    expect(drained).toBe(true);
  });
});
