import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type AcquireEvalDeviceLockOptions,
  EVAL_DEVICE_LOCK_BYPASS_ENV,
  EvalDeviceLockBusyError,
  type EvalDeviceLockLease,
  type EvalDeviceLockOwner,
  acquireEvalDeviceLockIfNeeded,
  acquireEvalDeviceLock as acquireEvalDeviceLockWithDefaults,
  evalNeedsDeviceLock,
} from './eval-device-lock.ts';

const roots: string[] = [];

function acquireEvalDeviceLock(options: AcquireEvalDeviceLockOptions = {}): EvalDeviceLockLease {
  return acquireEvalDeviceLockWithDefaults({ sleepGuard: false, ...options });
}

function tempLockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'gezel-eval-lock-test-'));
  roots.push(root);
  return join(root, 'device.lock');
}

function writeOwner(lockPath: string, owner: EvalDeviceLockOwner): void {
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(owner));
}

function owner(pid: number): EvalDeviceLockOwner {
  return {
    pid,
    startedAt: '2026-07-10T12:00:00.000Z',
    command: 'pnpm eval:all --suite core --count 1',
    ownerId: `owner-${pid}`,
    hostname: 'test-host',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('eval device lock selection', () => {
  it('reserves local chat and image engines without blocking cloud-only text evals', () => {
    expect(evalNeedsDeviceLock({ provider: 'llama-cpp' })).toBe(true);
    expect(evalNeedsDeviceLock({ provider: 'mlx' })).toBe(true);
    expect(evalNeedsDeviceLock({ provider: 'openai' })).toBe(false);
    expect(
      evalNeedsDeviceLock({
        provider: 'openai',
        scenarios: [{ defaultImageModelId: 'sdxl-lightning-4step' }],
      }),
    ).toBe(true);
    expect(evalNeedsDeviceLock({ provider: 'openai', imageModelId: 'sdxl-base-1.0' })).toBe(true);
  });

  it('does not create a lock for a cloud-only invocation', () => {
    const lockPath = tempLockPath();
    expect(
      acquireEvalDeviceLockIfNeeded({
        provider: 'anthropic',
        options: { lockPath },
      }),
    ).toBeNull();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('eval device lock ownership', () => {
  it('writes diagnostic owner metadata and removes it on release', () => {
    const lockPath = tempLockPath();
    const lease = acquireEvalDeviceLock({
      lockPath,
      pid: 1234,
      command: 'test command',
      now: () => new Date('2026-07-10T12:34:56.000Z'),
    });

    const metadata = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    expect(metadata).toMatchObject({
      pid: 1234,
      command: 'test command',
      startedAt: '2026-07-10T12:34:56.000Z',
    });
    expect(metadata.ownerId).toEqual(expect.any(String));

    lease.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('is reference-counted and reentrant within one process', () => {
    const lockPath = tempLockPath();
    const outer = acquireEvalDeviceLock({ lockPath, command: 'outer' });
    const inner = acquireEvalDeviceLock({ lockPath, command: 'inner' });

    inner.release();
    expect(existsSync(lockPath)).toBe(true);
    outer.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails fast with live-owner diagnostics and preserves the lock', () => {
    const lockPath = tempLockPath();
    writeOwner(lockPath, owner(4444));

    expect(() =>
      acquireEvalDeviceLock({ lockPath, isProcessAlive: (pid) => pid === 4444 }),
    ).toThrowError(EvalDeviceLockBusyError);
    expect(existsSync(lockPath)).toBe(true);
    expect(() => acquireEvalDeviceLock({ lockPath, isProcessAlive: () => true })).toThrow(
      /pid 4444.*pnpm eval:all/s,
    );
  });

  it('atomically reclaims a lock only after proving its owner pid is dead', () => {
    const lockPath = tempLockPath();
    const staleOwner = owner(5555);
    writeOwner(lockPath, staleOwner);

    const lease = acquireEvalDeviceLock({
      lockPath,
      pid: 6666,
      command: 'replacement',
      isProcessAlive: (pid) => {
        expect(pid).toBe(5555);
        return false;
      },
    });
    const replacement = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    expect(replacement).toMatchObject({ pid: 6666, command: 'replacement' });

    // A second process may have inspected the old owner before the first
    // recovery. Its delayed rename targets the deterministic tombstone and
    // must fail without moving the live replacement lock.
    const tombstone = join(dirname(lockPath), `.${basename(lockPath)}.stale-${staleOwner.ownerId}`);
    expect(existsSync(tombstone)).toBe(true);
    expect(() => renameSync(lockPath, tombstone)).toThrow();
    expect(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({
      pid: 6666,
    });
    lease.release();
  });

  it('does not delete a lock whose owner cannot be proven dead', () => {
    const lockPath = tempLockPath();
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), '{not-json');

    expect(() => acquireEvalDeviceLock({ lockPath, isProcessAlive: () => false })).toThrow(
      /metadata is missing or malformed/,
    );
    expect(existsSync(lockPath)).toBe(true);
  });

  it('cleans up synchronously from the process exit hook', () => {
    const lockPath = tempLockPath();
    const events = new EventEmitter();
    acquireEvalDeviceLock({ lockPath, processEvents: events });

    events.emit('exit');
    expect(existsSync(lockPath)).toBe(false);

    // The in-process ownership registry is cleared too (useful to embedders
    // and proves cleanup is not only a filesystem side effect).
    const replacement = acquireEvalDeviceLock({ lockPath, processEvents: events });
    replacement.release();
  });

  it('never removes a replacement lock it no longer owns', () => {
    const lockPath = tempLockPath();
    const lease = acquireEvalDeviceLock({ lockPath });
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(owner(9999)));

    lease.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('honors the explicit unsafe concurrency escape hatch', () => {
    const lockPath = tempLockPath();
    const lease = acquireEvalDeviceLock({
      lockPath,
      env: { [EVAL_DEVICE_LOCK_BYPASS_ENV]: '1' },
    });

    expect(lease.acquired).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });
});
