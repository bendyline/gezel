import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * Behavioral tests for the heavy-provider memory-extraction debounce
 * + hard-cap. The cadence gate (every-N-messages) decides *when
 * extraction is due*; the debounce decides *when it actually runs*.
 *
 * These tests use fake timers to isolate the debounce/cap behavior
 * from real-time scheduling. The cadence-met case is tested in
 * manager.test.ts ("ChatManager — memory extraction isolation").
 */

const noopMemory = {
  save: async () => ({ status: 'saved' as const }),
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;

// Every test in this file does 5 real sequential sends in
// sendUntilCadenceMet before any assertion. At ~1s per turn under
// parallel-suite load, the 5s vitest default tips into timeouts
// intermittently. Bump the per-test budget for each `it` in the file.
const TEST_TIMEOUT_MS = 30_000;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-mem-debounce-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  // Heavy provider — debounce + cap apply.
  await store.writeConfig({ provider: 'ollama' });
  mock = new MockProvider({ name: 'ollama' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['ollama', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  // Fake timers for deterministic debounce assertions. Set AFTER
  // construction so the manager's any-startup setTimeouts (none today
  // but defensive) get the real timer.
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

const backgroundSends = () =>
  mock.calls.filter((c) => c.kind === 'send' && c.sendOpts?.queue?.lane === 'background');

/** Send N turns to push the message count past the every-10-messages cadence gate. */
async function sendUntilCadenceMet(sessionId: string): Promise<void> {
  // 5 sends × 2 messages (user + assistant) = 10 messages → cadence met.
  for (let i = 0; i < 5; i++) {
    mock.script(`reply-${i}`, 'NONE');
    await manager.send(sessionId, `turn ${i}`);
    await manager.drainBackground();
  }
}

describe('ChatManager — heavy-provider memory extraction debounce', () => {
  it(
    'skips extraction entirely when GEZEL_DISABLE_MEMORY_EXTRACTION is set',
    async () => {
      const previous = process.env.GEZEL_DISABLE_MEMORY_EXTRACTION;
      process.env.GEZEL_DISABLE_MEMORY_EXTRACTION = '1';
      try {
        const session = await manager.createSession({ gezelId: 'ada' });
        await sendUntilCadenceMet(session.id);
        await vi.advanceTimersByTimeAsync(15_000);
        await manager.flushPendingMemoryExtractions();
        await manager.drainBackground();
        expect(backgroundSends()).toHaveLength(0);
      } finally {
        if (previous === undefined) {
          delete process.env.GEZEL_DISABLE_MEMORY_EXTRACTION;
        } else {
          process.env.GEZEL_DISABLE_MEMORY_EXTRACTION = previous;
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not fire extraction immediately when the cadence threshold is met',
    async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      await sendUntilCadenceMet(session.id);
      // Cadence is met but debounce hasn't elapsed → extraction is
      // scheduled, not fired. The user's next message would still
      // get a free engine slot.
      expect(backgroundSends()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fires extraction once the idle window elapses',
    async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      await sendUntilCadenceMet(session.id);
      expect(backgroundSends()).toHaveLength(0);
      // Advance past the 15s debounce. `Async` variant pumps microtasks
      // so the trackBackground promise can register before we check.
      await vi.advanceTimersByTimeAsync(15_000);
      await manager.drainBackground();
      expect(backgroundSends()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancels and re-schedules when a new turn starts within the debounce window',
    async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      await sendUntilCadenceMet(session.id);
      expect(backgroundSends()).toHaveLength(0);

      // Halfway through the debounce window the user sends another
      // message — runSend cancels the pending timer at the top.
      await vi.advanceTimersByTimeAsync(7_000);
      mock.script('next reply', 'NONE');
      await manager.send(session.id, 'one more turn');
      await manager.drainBackground();

      // Advancing the rest of the original window (8s more = 15s total
      // from first schedule) must NOT fire — the cancel cleared that
      // timer and a fresh one started after the new turn ended.
      await vi.advanceTimersByTimeAsync(8_000);
      await manager.drainBackground();
      expect(backgroundSends()).toHaveLength(0);

      // Advance the rest of the new debounce window (15s from the
      // re-schedule = 7s + 15s - 8s = 14s remaining after the previous
      // advance). Round up to be safe.
      await vi.advanceTimersByTimeAsync(15_000);
      await manager.drainBackground();
      expect(backgroundSends()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hard-caps at 5 minutes — fires immediately even on a never-idle session',
    async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      await sendUntilCadenceMet(session.id);
      expect(backgroundSends()).toHaveLength(0);

      // Burn 6 minutes by sending a turn every 30 seconds. Each turn
      // cancels the prior timer; firstQueuedAt stays at the original
      // schedule moment, so by minute 5 the cap should trip.
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        mock.script(`burn-${i}`, 'NONE');
        await manager.send(session.id, `burn turn ${i}`);
        await manager.drainBackground();
      }

      // The cap-triggered fire happens inline inside scheduleHeavyExtraction
      // when post-turn re-schedule sees firstQueuedAt is too old. By now
      // at least one of the post-turn re-schedules should have crossed
      // the 5-minute threshold and fired.
      await manager.drainBackground();
      expect(backgroundSends().length).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'flushPendingMemoryExtractions fires deferred work without waiting for the timer',
    async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      await sendUntilCadenceMet(session.id);
      expect(backgroundSends()).toHaveLength(0);

      // Bypass the debounce explicitly. Useful for shutdown + tests.
      await manager.flushPendingMemoryExtractions();
      expect(backgroundSends()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shutdown flushes pending extractions so they run before teardown',
    async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      await sendUntilCadenceMet(session.id);
      expect(backgroundSends()).toHaveLength(0);

      // shutdown() calls flushDeferredExtractions internally, then we
      // await drainBackground (in afterEach) to make the resulting
      // promises resolve. Run shutdown explicitly here so we can assert
      // afterward; afterEach's shutdown becomes a no-op.
      await manager.shutdown();
      await manager.drainBackground();
      expect(backgroundSends()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'advances the live extraction cursor — cadence does not re-fire every turn once met',
    async () => {
      // Regression test for the stale-cursor bug: the post-extraction
      // cursor persist only wrote a fresh disk copy, never the live
      // record, so once the cadence was met every subsequent turn
      // re-fired a full extraction.
      const session = await manager.createSession({ gezelId: 'ada' });
      await sendUntilCadenceMet(session.id);
      await manager.flushPendingMemoryExtractions();
      await manager.drainBackground();
      expect(backgroundSends()).toHaveLength(1);

      // One more turn: 12 messages, cursor 10 → sinceLast 2 < 10 →
      // nothing scheduled, nothing fired even after a full window.
      mock.script('post-cursor reply', 'NONE');
      await manager.send(session.id, 'one more turn');
      await manager.drainBackground();
      await vi.advanceTimersByTimeAsync(15_000);
      await manager.drainBackground();
      expect(backgroundSends()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// Cloud providers should NOT be debounced — extraction is ~1s and
// doesn't compete for a single inference slot the way local engines do.
// This test runs alongside the heavy ones to lock in the contrast.
describe('ChatManager — cloud-provider memory extraction is NOT debounced', () => {
  let cloudHome: string;
  let cloudStore: Store;
  let cloudManager: ChatManager;
  let cloudMock: MockProvider;

  beforeEach(async () => {
    cloudHome = await mkdtemp(join(tmpdir(), 'gezel-mem-cloud-'));
    cloudStore = new Store({ home: cloudHome });
    await cloudStore.ensureLayout();
    await cloudStore.createGezel({ name: 'Ada', role: 'Developer' });
    await cloudStore.createProject({ name: 'Default' });
    cloudMock = new MockProvider({ name: 'copilot' });
    cloudManager = new ChatManager({
      store: cloudStore,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home: cloudHome,
      providers: [['copilot', cloudMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(cloudHome),
    });
  });

  afterEach(async () => {
    await cloudManager.drainBackground();
    await cloudManager.shutdown();
    await rm(cloudHome, { recursive: true, force: true });
  });

  it(
    'fires extraction immediately on every turn (no debounce)',
    async () => {
      const session = await cloudManager.createSession({ gezelId: 'ada' });
      cloudMock.script('reply', 'NONE');
      // No fake timers, no advance — extraction must complete via real
      // microtasks within one `drainBackground`.
      await cloudManager.send(session.id, 'hello');
      await cloudManager.drainBackground();
      const sends = cloudMock.calls.filter(
        (c) => c.kind === 'send' && c.sendOpts?.queue?.lane === 'background',
      );
      expect(sends).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'extracts only post-cursor messages — earlier turns ride along as context only',
    async () => {
      const session = await cloudManager.createSession({ gezelId: 'ada' });
      cloudMock.script('first-turn-reply', 'NONE');
      await cloudManager.send(session.id, 'first-turn-question');
      await cloudManager.drainBackground();

      cloudMock.script('second-turn-reply', 'NONE');
      await cloudManager.send(session.id, 'second-turn-question');
      await cloudManager.drainBackground();

      const sends = cloudMock.calls.filter(
        (c) => c.kind === 'send' && c.sendOpts?.queue?.lane === 'background',
      );
      expect(sends).toHaveLength(2);

      const secondPrompt = sends[1]!.prompt ?? '';
      const [contextPart, freshPart] = secondPrompt.split('New messages:');
      expect(freshPart).toContain('second-turn-question');
      expect(freshPart).not.toContain('first-turn-question');
      expect(contextPart).toContain('Earlier context');
      expect(contextPart).toContain('first-turn-question');
    },
    TEST_TIMEOUT_MS,
  );
});
