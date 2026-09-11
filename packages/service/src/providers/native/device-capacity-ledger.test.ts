import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCapacityCommand } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceCapacityLedger, type DeviceCapacitySample } from './device-capacity-ledger.js';

const GIB = 1024 ** 3;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(overrides: Partial<DeviceCapacitySample> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gezel-capacity-'));
  dirs.push(directory);
  const live = new Set([1, 2, 3, 101, 102]);
  const sample = {
    budgetBytes: 112 * GIB,
    gpuBudgetBytes: 96 * GIB,
    serializeLoads: false,
    ...overrides,
  };
  const make = () =>
    new DeviceCapacityLedger({
      directory,
      sample: async () => sample,
      alive: (pid) => live.has(pid),
    });
  return { ledger: make(), make, sample, live };
}
const request = (
  bytes: number,
  exclusive = false,
  ownerPid = 1,
): NativeCapacityCommand & { action: 'acquire' } => ({
  action: 'acquire',
  id: randomUUID(),
  ownerPid,
  label: 'test model',
  bytes: bytes * GIB,
  gpuBytes: bytes * GIB,
  exclusive,
  priority: 'interactive',
});

describe('device memory admission', () => {
  it('blocks the DS4 83.1 GiB + 15.5 GiB competing-daemon case before allocation', async () => {
    const { ledger, make } = await fixture();
    const ds4 = request(83.1);
    const other = request(15.5, false, 2);
    expect((await ledger.execute(ds4)).state).toBe('granted');
    expect((await make().execute(other)).state).toBe('waiting');
    expect((await ledger.execute({ action: 'status', id: ds4.id })).releaseRequested).toBe(true);
    await ledger.execute({ action: 'release', id: ds4.id });
    expect((await make().execute(other)).state).toBe('granted');
  });

  it('makes full residency exclusive even when a larger machine budget would fit both', async () => {
    const { ledger } = await fixture({ budgetBytes: 240 * GIB, gpuBudgetBytes: 192 * GIB });
    await ledger.execute(request(96, true));
    expect((await ledger.execute(request(3))).state).toBe('waiting');
  });

  it('allows concurrent resident engines when their complete working sets fit', async () => {
    const { ledger } = await fixture();
    const results = await Promise.all([
      ledger.execute(request(20)),
      ledger.execute(request(30)),
      ledger.execute(request(40)),
    ]);
    expect(results.map((r) => r.state)).toEqual(['granted', 'granted', 'granted']);
  });

  it('serializes physical loads but releases that constraint at readiness', async () => {
    const { ledger } = await fixture({ serializeLoads: true });
    const first = request(20);
    const second = request(20);
    await ledger.execute(first);
    expect((await ledger.execute(second)).state).toBe('waiting');
    expect((await ledger.execute({ action: 'status', id: first.id })).releaseRequested).toBe(false);
    await ledger.execute({ action: 'ready', id: first.id });
    expect((await ledger.execute(second)).state).toBe('granted');
  });

  it('does not let small newcomers indefinitely bypass an older large request', async () => {
    const { ledger } = await fixture();
    const resident = request(70);
    const large = request(50);
    const small = request(2);
    await ledger.execute(resident);
    expect((await ledger.execute(large)).state).toBe('waiting');
    expect((await ledger.execute(small)).state).toBe('waiting');
    await ledger.execute({ action: 'release', id: resident.id });
    expect((await ledger.execute(small)).state).toBe('waiting');
    expect((await ledger.execute(large)).state).toBe('granted');
    expect((await ledger.execute(small)).state).toBe('granted');
  });

  it('observes foreign memory consumption on unified hosts', async () => {
    const { ledger, sample } = await fixture({ availableBytes: 10 * GIB });
    const claim = request(20);
    expect((await ledger.execute(claim)).state).toBe('waiting');
    sample.availableBytes = 30 * GIB;
    expect((await ledger.execute(claim)).state).toBe('granted');
  });

  it('prioritizes interactive work but bounds how often background work is bypassed', async () => {
    const { ledger } = await fixture();
    const resident = request(90);
    const background = { ...request(20), priority: 'background' as const };
    await ledger.execute(resident);
    expect((await ledger.execute(background)).state).toBe('waiting');
    for (let i = 0; i < 4; i++) {
      const interactive = request(5);
      expect((await ledger.execute(interactive)).state).toBe('granted');
      await ledger.execute({ action: 'release', id: interactive.id });
    }
    const newcomer = request(5);
    expect((await ledger.execute(newcomer)).state).toBe('waiting');
    await ledger.execute({ action: 'release', id: resident.id });
    expect((await ledger.execute(newcomer)).state).toBe('waiting');
    expect((await ledger.execute(background)).state).toBe('granted');
    expect((await ledger.execute(newcomer)).state).toBe('granted');
  });

  it('counts not-yet-allocated loading reservations against the live sample', async () => {
    const { ledger } = await fixture({ availableBytes: 30 * GIB });
    await ledger.execute(request(20));
    expect((await ledger.execute(request(20))).state).toBe('waiting');
  });

  it('keeps an orphan child reserved across coordinator restart until the child exits', async () => {
    const { ledger, make, live } = await fixture();
    const claim = request(90);
    await ledger.execute(claim);
    await ledger.execute({ action: 'bind', id: claim.id, childPid: 101 });
    await ledger.execute({ action: 'ready', id: claim.id });
    live.delete(1);
    const next = request(20, false, 2);
    expect((await make().execute(next)).state).toBe('waiting');
    live.delete(101);
    expect((await make().execute(next)).state).toBe('granted');
  });

  it('cleans up dead queued owners and cancels pending claims without holding up the queue', async () => {
    const { ledger, live } = await fixture();
    const held = request(90, false, 3);
    const first = request(20);
    const next = request(20, false, 2);
    await ledger.execute(held);
    await ledger.execute(first);
    await ledger.execute(next);
    live.delete(1);
    await ledger.execute({ action: 'release', id: held.id });
    expect((await ledger.execute(next)).state).toBe('granted');
    await ledger.execute({ action: 'release', id: next.id });
    expect((await ledger.execute({ action: 'status', id: next.id })).state).toBe('released');
  });

  it('rejects a model that can never fit instead of blocking the queue forever', async () => {
    const { ledger } = await fixture();
    await expect(ledger.execute(request(200))).rejects.toMatchObject({ code: 'capacity-denied' });
    expect((await ledger.execute(request(20))).state).toBe('granted');
  });
});

describe('external memory shortfall', () => {
  it('reports a shortfall no engine is responsible for, with both numbers', async () => {
    // The gemma4-e4b case: 9.7 GB wanted, budget has room, nothing else is
    // loaded — the memory belongs to the user's other applications.
    const { ledger } = await fixture({
      budgetBytes: 11.2 * GIB,
      gpuBudgetBytes: 11.2 * GIB,
      availableBytes: 4.29 * GIB,
    });
    const reply = await ledger.execute(request(9.7));
    expect(reply.state).toBe('waiting');
    expect(reply.externalShortfall).toBe(true);
    expect(reply.requiredBytes).toBe(9.7 * GIB);
    expect(reply.availableBytes).toBe(4.29 * GIB);
    expect(reply.reason).toContain('9.7 GB');
    expect(reply.reason).toContain('4.3 GB');
  });

  it('does not claim an external shortfall while another engine holds the memory', async () => {
    const { ledger, make } = await fixture({
      budgetBytes: 24 * GIB,
      gpuBudgetBytes: 24 * GIB,
      availableBytes: 10 * GIB,
    });
    const resident = request(9);
    expect((await ledger.execute(resident)).state).toBe('granted');
    // Waiting behind a real claim is worth waiting out — that engine finishes.
    const queued = await make().execute(request(9, false, 2));
    expect(queued.state).toBe('waiting');
    expect(queued.externalShortfall).toBeUndefined();
    expect(queued.requiredBytes).toBeUndefined();
  });

  it('stays silent when the budget, not the host, is what refuses', async () => {
    // Over budget is a different refusal with different advice, and the
    // acquire path throws on it outright rather than queueing.
    const { ledger } = await fixture({
      budgetBytes: 8 * GIB,
      gpuBudgetBytes: 8 * GIB,
      availableBytes: 32 * GIB,
    });
    await expect(ledger.execute(request(9))).rejects.toThrow(/safe model capacity/);
  });

  it('clears the flag once the host frees the memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gezel-capacity-'));
    dirs.push(directory);
    let availableBytes = 4 * GIB;
    const ledger = new DeviceCapacityLedger({
      directory,
      sample: async () => ({
        budgetBytes: 16 * GIB,
        gpuBudgetBytes: 16 * GIB,
        availableBytes,
        serializeLoads: false,
      }),
      alive: () => true,
    });
    const acquire = request(9);
    expect((await ledger.execute(acquire)).externalShortfall).toBe(true);
    availableBytes = 12 * GIB;
    expect((await ledger.execute(acquire)).state).toBe('granted');
  });
});
