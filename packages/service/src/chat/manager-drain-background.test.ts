import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * Shutdown waits for fire-and-forget background work, and that wait has to be
 * bounded. A first run creates the Meester and kicks off its about.md + icon
 * one-shots; when the configured provider cannot answer, those sit on their
 * own multi-minute budget. Unbounded, `service.stop()` blocks behind them and
 * — since neither the Electron quit coordinator nor an embedded caller sets a
 * deadline — quitting the app hangs. It surfaced as an intermittent 60s
 * teardown timeout in `security-compliance.spec.ts`.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function makeManager() {
  const home = await mkdtemp(join(tmpdir(), 'gezel-drain-'));
  const store = new Store({ home });
  await store.ensureLayout();
  const manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
  });
  return manager;
}

describe('ChatManager.drainBackground', () => {
  it('returns once tracked work settles', async () => {
    const manager = await makeManager();
    let done = false;
    manager.trackBackground(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          done = true;
          resolve();
        }, 20),
      ),
    );

    await manager.drainBackground(5_000);
    expect(done).toBe(true);
  });

  it('gives up on work that never settles instead of hanging', async () => {
    const manager = await makeManager();
    // A doomed one-shot: registered, never resolves.
    manager.trackBackground(new Promise<void>(() => {}));

    const started = Date.now();
    await manager.drainBackground(150);
    const waited = Date.now() - started;

    // Bounded by the deadline, not by the promise.
    expect(waited).toBeLessThan(2_000);
    expect(waited).toBeGreaterThanOrEqual(100);
  });

  it('does not let a rejected task escape as an unhandled rejection', async () => {
    const manager = await makeManager();
    manager.trackBackground(Promise.reject(new Error('background write failed')));
    await expect(manager.drainBackground(1_000)).resolves.toBeUndefined();
  });
});
