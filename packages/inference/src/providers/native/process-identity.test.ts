import { describe, expect, it } from 'vitest';
import { readProcessIdentities } from './process-identity.js';

describe('OS process birth stamps', () => {
  it('reads a stable birth stamp for this process', async () => {
    const first = await readProcessIdentities([process.pid]);
    expect(first.get(process.pid)).toBeTruthy();
    expect((await readProcessIdentities([process.pid])).get(process.pid)).toBe(
      first.get(process.pid),
    );
  });
  it('keeps live process rows when another PID is absent', async () => {
    expect((await readProcessIdentities([process.pid, 2147483647])).get(process.pid)).toBeTruthy();
  });
  it('ignores invalid process IDs', async () => {
    expect(await readProcessIdentities([-1, 0, Number.NaN, 1.2])).toEqual(new Map());
  });
});
