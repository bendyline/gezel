import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCapacityCommand } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceCapacityLedger } from './device-capacity-ledger.js';
import { ProcessIdentityCache, VERIFIED_IDENTITY_TTL_MS } from './process-identity.js';

const GIB = 1024 ** 3;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gezel-capacity-'));
  dirs.push(directory);
  const live = new Set([1, 2, 3, 101]);
  const births = new Map([...live].map((pid) => [pid, `birth-${pid}`]));
  let clock = 0;
  // Stands in for `ps` / PowerShell: every call is a process launch.
  const read = vi.fn(async (pids: readonly number[]) => {
    const found = new Map<number, string>();
    for (const pid of pids) if (births.has(pid)) found.set(pid, births.get(pid)!);
    return found;
  });
  // Each coordinator keeps its own cache, as a separate daemon process would.
  const coordinator = () =>
    new DeviceCapacityLedger({
      directory,
      sample: async () => ({
        budgetBytes: 112 * GIB,
        gpuBudgetBytes: 96 * GIB,
        serializeLoads: false,
      }),
      alive: (pid) => live.has(pid),
      identityCache: new ProcessIdentityCache({
        read,
        alive: (pid) => live.has(pid),
        now: () => clock,
      }),
    });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { ledger: coordinator(), coordinator, births, read, advance };
}

const request = (gib: number, ownerPid = 1): NativeCapacityCommand & { action: 'acquire' } => ({
  action: 'acquire',
  id: randomUUID(),
  ownerPid,
  label: 'test model',
  bytes: gib * GIB,
  gpuBytes: gib * GIB,
  exclusive: false,
  priority: 'interactive',
});

async function runningEngine(ledger: DeviceCapacityLedger, gib: number, childPid: number) {
  const claim = request(gib);
  expect((await ledger.execute(claim)).state).toBe('granted');
  await ledger.execute({ action: 'bind', id: claim.id, childPid });
  await ledger.execute({ action: 'ready', id: claim.id });
  return claim;
}

describe('birth-stamp reads in the capacity ledger', () => {
  it('reads no stamps for the check before each engine request while nothing waits', async () => {
    const { ledger, read, advance } = await fixture();
    const engine = await runningEngine(ledger, 40, 101);
    read.mockClear();
    for (let i = 0; i < 50; i++) {
      // Hours of requests and 15-second pressure probes, long past any cached stamp.
      advance(VERIFIED_IDENTITY_TTL_MS);
      expect((await ledger.execute({ action: 'status', id: engine.id })).state).toBe('granted');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('reuses verified stamps while a request polls for memory, then reads them in one batch', async () => {
    const { ledger, read, advance } = await fixture();
    const engine = await runningEngine(ledger, 90, 101);
    const waiter = request(40, 2);
    expect((await ledger.execute(waiter)).state).toBe('waiting');
    read.mockClear();
    for (let elapsed = 500; elapsed < VERIFIED_IDENTITY_TTL_MS; elapsed += 500) {
      advance(500);
      expect((await ledger.execute(waiter)).state).toBe('waiting');
      expect((await ledger.execute({ action: 'status', id: engine.id })).state).toBe('granted');
    }
    expect(read).not.toHaveBeenCalled();
    advance(500);
    await ledger.execute(waiter);
    expect(read).toHaveBeenCalledTimes(1);
    expect([...read.mock.calls[0]![0]].sort((a, b) => a - b)).toEqual([2, 101]);
  });

  it('still frees a dead engine whose PID a new process took', async () => {
    const { ledger, births, advance } = await fixture();
    const engine = await runningEngine(ledger, 90, 101);
    const waiter = request(40, 2);
    expect((await ledger.execute(waiter)).state).toBe('waiting');
    // The engine died and its PID was reused between two liveness checks.
    births.set(101, 'birth-of-a-stranger');
    expect((await ledger.execute(waiter)).state).toBe('waiting');
    advance(VERIFIED_IDENTITY_TTL_MS);
    expect((await ledger.execute(waiter)).state).toBe('granted');
    expect((await ledger.execute({ action: 'status', id: engine.id })).state).toBe('released');
  });

  it('never frees an engine another coordinator recorded at a PID this one has cached', async () => {
    const { ledger, coordinator, births } = await fixture();
    const first = await runningEngine(ledger, 90, 101);
    await ledger.execute({ action: 'release', id: first.id });
    // The other daemon's new engine now holds PID 101; this coordinator still
    // holds the old stamp, well inside its time to live.
    births.set(101, 'birth-of-the-new-engine');
    const other = coordinator();
    const second = await runningEngine(other, 90, 101);
    expect((await ledger.execute(request(40, 2))).state).toBe('waiting');
    expect((await other.execute({ action: 'status', id: second.id })).state).toBe('granted');
  });
});
