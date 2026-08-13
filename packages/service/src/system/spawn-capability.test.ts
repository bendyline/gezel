import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProbeSpawnOptions,
  SPAWN_DENIED_MESSAGE,
  probeChildProcessSpawn,
} from './spawn-capability.js';

type SpawnImpl = NonNullable<ProbeSpawnOptions['spawnImpl']>;

/** Minimal ChildProcess stand-in: the probe only listens for two events. */
function fakeChild(): EventEmitter & { unref: () => void } {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

function spawnEmitting(
  event: 'spawn' | 'error',
  err?: NodeJS.ErrnoException,
): {
  impl: SpawnImpl;
  calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }> = [];
  const impl = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = fakeChild();
    queueMicrotask(() => child.emit(event, err));
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${code}`), { code });
}

describe('probeChildProcessSpawn', () => {
  it('reports denied when the OS refuses process creation', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      const { impl } = spawnEmitting('error', errno(code));
      await expect(probeChildProcessSpawn({ platform: 'win32', spawnImpl: impl })).resolves.toBe(
        'denied',
      );
    }
  });

  it('reports ok when the child starts', async () => {
    const { impl } = spawnEmitting('spawn');
    await expect(probeChildProcessSpawn({ platform: 'win32', spawnImpl: impl })).resolves.toBe(
      'ok',
    );
  });

  // A missing or misnamed comspec is a broken probe, not a write-restricted
  // token. Calling it `denied` would point an administrator at a service
  // identity that is working fine.
  it('does not report denied for a failure that is not a permission failure', async () => {
    const { impl } = spawnEmitting('error', errno('ENOENT'));
    await expect(probeChildProcessSpawn({ platform: 'win32', spawnImpl: impl })).resolves.toBe(
      'ok',
    );
  });

  it('survives a spawn that throws synchronously', async () => {
    const impl = (() => {
      throw errno('EPERM');
    }) as unknown as SpawnImpl;
    await expect(probeChildProcessSpawn({ platform: 'win32', spawnImpl: impl })).resolves.toBe(
      'denied',
    );
  });

  // The probe has to be indistinguishable from the spawns it speaks for.
  // libuv only creates the named pipes a write-restricted token rejects when
  // stdio is piped, so an `ignore`-stdio probe would pass on precisely the
  // machines this exists to catch.
  it('pipes stdio and hides its Windows console, matching the real call sites', async () => {
    const { impl, calls } = spawnEmitting('spawn');
    await probeChildProcessSpawn({ platform: 'win32', spawnImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(calls[0]!.options.windowsHide).toBe(true);
    expect(calls[0]!.options.detached).toBeUndefined();
  });

  it('is a no-op off Windows, where the service token cannot have this shape', async () => {
    const { impl, calls } = spawnEmitting('spawn');
    for (const platform of ['darwin', 'linux'] as const) {
      await expect(probeChildProcessSpawn({ platform, spawnImpl: impl })).resolves.toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  // The remediation is the whole point of detecting this: the daemon cannot
  // change its own token, so the log line has to carry the exact fix.
  it('names the command that fixes a denied token', () => {
    expect(SPAWN_DENIED_MESSAGE).toContain('sc.exe sidtype GezelService unrestricted');
  });
});
