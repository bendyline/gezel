import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemToolsetInstallEvent } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemToolsetInstallRegistry } from './install-registry.js';
import type { PinnedSystemToolset } from './manifest.js';
import { readSystemTracking } from './tracking.js';

const ENTRY: PinnedSystemToolset = {
  toolsetId: '@fake/on-demand',
  displayName: 'Fake on-demand',
  kind: 'library',
  onDemand: true,
  pkg: '@fake/on-demand',
  version: '2.0.0',
  integrity: `sha512-${'D'.repeat(86)}==`,
  entry: 'dist/index.js',
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-install-registry-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A never-settling install, so a job stays in flight for the assertion. */
function hangingInstall(events: SystemToolsetInstallEvent[] = []) {
  return async function* () {
    for (const event of events) yield event;
    await new Promise(() => {});
    // Unreachable; present so the generator's return type matches.
    return { installPath: '' };
  } as unknown as ConstructorParameters<typeof SystemToolsetInstallRegistry>[0]['installImpl'];
}

/** An install that emits `events`, then succeeds. */
function scriptedInstall(events: SystemToolsetInstallEvent[], installPath = '/tmp/installed') {
  return async function* () {
    for (const event of events) yield event;
    return { installPath };
  } as unknown as ConstructorParameters<typeof SystemToolsetInstallRegistry>[0]['installImpl'];
}

/** Wait until `predicate` holds, so we don't sleep on a fixed timer. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('SystemToolsetInstallRegistry', () => {
  it('rejects an entry that is not a library', () => {
    const registry = new SystemToolsetInstallRegistry({
      home,
      installImpl: scriptedInstall([]),
    });
    expect(() => registry.ensure({ ...ENTRY, kind: 'mcp-toolset' })).toThrow(
      /only 'library' entries/,
    );
  });

  // Idempotence is what lets the user hammer the Install button, or open the
  // tab in two windows, without starting two downloads of the same tarball.
  it('attaches a second ensure() to the running job instead of starting another', async () => {
    const installImpl = vi.fn(hangingInstall());
    const registry = new SystemToolsetInstallRegistry({ home, installImpl });

    const first = registry.ensure(ENTRY);
    expect(first.alreadyRunning).toBe(false);
    await until(() => installImpl.mock.calls.length === 1, 'the install to start');

    const second = registry.ensure(ENTRY);
    expect(second.alreadyRunning).toBe(true);
    expect(installImpl).toHaveBeenCalledTimes(1);

    registry.clear();
  });

  // A late subscriber's progress bar must not be blank: the snapshot carries
  // everything that happened before it attached.
  it('replays phase, progress, and buffered log to a late subscriber', async () => {
    const registry = new SystemToolsetInstallRegistry({
      home,
      installImpl: hangingInstall([
        { type: 'phase', phase: 'downloading' },
        { type: 'progress', bytesWritten: 512, totalBytes: 2048 },
        { type: 'log', line: 'resolving...' },
      ]),
    });
    registry.ensure(ENTRY);
    await until(() => (registry.get(ENTRY.toolsetId)?.log.length ?? 0) > 0, 'the first log line');

    const seen: SystemToolsetInstallEvent[] = [];
    registry.subscribe(ENTRY.toolsetId, (e) => seen.push(e));

    expect(seen).toEqual([
      { type: 'phase', phase: 'downloading' },
      { type: 'progress', bytesWritten: 512, totalBytes: 2048 },
      { type: 'log', line: 'resolving...' },
    ]);

    registry.clear();
  });

  it('records the install in the tracking file before announcing done', async () => {
    const registry = new SystemToolsetInstallRegistry({
      home,
      installImpl: scriptedInstall([{ type: 'phase', phase: 'publishing' }], '/somewhere/package'),
    });

    const done = new Promise<SystemToolsetInstallEvent>((resolve) => {
      registry.ensure(ENTRY);
      registry.subscribe(ENTRY.toolsetId, (e) => {
        if (e.type === 'done' || e.type === 'error') resolve(e);
      });
    });

    const event = await done;
    expect(event).toEqual({
      type: 'done',
      installPath: '/somewhere/package',
      version: ENTRY.version,
    });
    // The UI resolves the SDK through this file, so a `done` that outran the
    // write would report Copilot ready a beat before it actually resolved.
    const tracking = await readSystemTracking(home);
    expect(tracking.toolsets[ENTRY.toolsetId]).toMatchObject({
      toolsetId: ENTRY.toolsetId,
      version: ENTRY.version,
      integrity: ENTRY.integrity,
    });
  });

  it('surfaces an install failure as a terminal error event', async () => {
    const registry = new SystemToolsetInstallRegistry({
      home,
      installImpl: (() => {
        throw new Error('registry unreachable');
      }) as unknown as ConstructorParameters<typeof SystemToolsetInstallRegistry>[0]['installImpl'],
    });

    const settled = new Promise<SystemToolsetInstallEvent>((resolve) => {
      registry.ensure(ENTRY);
      registry.subscribe(ENTRY.toolsetId, (e) => {
        if (e.type === 'error') resolve(e);
      });
    });

    expect(await settled).toEqual({ type: 'error', error: 'registry unreachable' });
    expect(await readSystemTracking(home)).toMatchObject({ toolsets: {} });
  });

  it('cancel() aborts an in-flight install and refuses a finished one', async () => {
    const registry = new SystemToolsetInstallRegistry({
      home,
      installImpl: ((_home: string, _entry: PinnedSystemToolset, opts: { signal?: AbortSignal }) =>
        (async function* () {
          // `cancel()` can land before the generator is even created — the
          // registry does an async tracking read first — so an
          // already-aborted signal has to be handled up front, not only
          // through the listener. The real installer's `fetchBounded` and
          // `runPnpm` both check `aborted` the same way.
          await new Promise<void>((_resolve, reject) => {
            if (opts.signal?.aborted) {
              reject(new Error('aborted'));
              return;
            }
            opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
          return { installPath: '' };
        })()) as unknown as ConstructorParameters<
        typeof SystemToolsetInstallRegistry
      >[0]['installImpl'],
    });

    const settled = new Promise<SystemToolsetInstallEvent>((resolve) => {
      registry.ensure(ENTRY);
      registry.subscribe(ENTRY.toolsetId, (e) => {
        if (e.type === 'error') resolve(e);
      });
    });

    expect(registry.cancel(ENTRY.toolsetId)).toBe(true);
    expect(await settled).toEqual({ type: 'error', error: 'install was cancelled' });
    expect(registry.cancel(ENTRY.toolsetId)).toBe(false);
  });

  it('keeps broadcasting after a listener throws', async () => {
    const registry = new SystemToolsetInstallRegistry({
      home,
      installImpl: scriptedInstall([{ type: 'phase', phase: 'downloading' }]),
    });

    const seen: SystemToolsetInstallEvent[] = [];
    const settled = new Promise<void>((resolve) => {
      registry.ensure(ENTRY);
      registry.subscribe(ENTRY.toolsetId, () => {
        throw new Error('bad listener');
      });
      registry.subscribe(ENTRY.toolsetId, (e) => {
        seen.push(e);
        if (e.type === 'done') resolve();
      });
    });

    await settled;
    expect(seen.some((e) => e.type === 'done')).toBe(true);
  });
});
