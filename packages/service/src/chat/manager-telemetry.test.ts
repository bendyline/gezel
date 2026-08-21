import { mkdtemp, rm } from 'node:fs/promises';
/**
 * ChatManager session-telemetry coverage. Drives a real send() through the
 * MockProvider (deltas stream, scripted tool calls fire through the live
 * MCP bridge) and asserts the per-session counters the stall logic, the
 * UI, and the eval harness read — accumulation across turns, per-turn
 * scoping, and the file-mutation classification.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type RunningService, startService } from '../service.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let svc: RunningService;
let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;

beforeEach(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-mgr-telemetry-test-'));
  svc = await startService({ home });
  store = svc.context.store;
  events = new ChatEventBus();
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => svc.port,
    getToken: () => svc.context.token,
    getCert: () => svc.cert?.certPem ?? null,
    home,
    providers: [['copilot', mock]],
    catalog: svc.context.catalog,
    secrets: svc.context.secrets,
  });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  // 'provider' pins the injected mock: without it, routing falls through to
  // the platform default (an on-device engine) and the mock is never reached.
  await store.writeConfig({ provider: 'copilot', toolFilterMode: 'never' });
}, 20_000);

afterEach(async () => {
  await manager?.shutdown();
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
});

describe('ChatManager session telemetry', () => {
  it('counts deltas, tool calls, and file mutations across a real send', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      { name: 'write_file', arguments: { path: 'notes.md', content: 'telemetry test file\n' } },
    ]);
    mock.script('Wrote the file.');
    await manager.send(session.id, 'write notes.md please');

    const snap = manager.sessionTelemetry(session.id);
    expect(snap).not.toBeNull();
    expect(snap?.gezelId).toBe('ada');
    expect(snap?.turnsStarted).toBe(1);
    expect(snap?.providerRequestsStarted).toBeGreaterThanOrEqual(1);
    expect(snap?.deltaChunks).toBe(2);
    expect(snap?.streamedContentChars).toBe('Wrote the file.'.length);
    expect(snap?.toolCalls).toBeGreaterThanOrEqual(1);
    expect(snap?.fileMutations).toBeGreaterThanOrEqual(1);
    expect(snap?.toolArgChars).toBeGreaterThan(0);
    expect(snap?.lastProgressAt).not.toBeNull();
    expect(snap?.lastMutationAt).not.toBeNull();
    expect(snap?.inflight).toBe(false);
    expect(snap?.currentTurn).toBeNull();

    // Second turn accumulates onto the same counters. Background
    // one-shot completions share the mock's response queue, so assert
    // monotonic growth rather than exact reply text.
    mock.script('Second reply.');
    await manager.send(session.id, 'thanks');
    const snap2 = manager.sessionTelemetry(session.id);
    expect(snap2?.turnsStarted).toBe(2);
    expect(snap2?.deltaChunks).toBe(4);
    expect(snap2?.streamedContentChars).toBeGreaterThan(snap?.streamedContentChars ?? 0);
  }, 30_000);

  it('lists telemetry with filters and reflects session deletion', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('Hello.');
    await manager.send(session.id, 'hi');

    const all = manager.listSessionTelemetry();
    expect(all.some((s) => s.sessionId === session.id)).toBe(true);
    expect(
      manager.listSessionTelemetry({ gezelId: 'ada' }).some((s) => s.sessionId === session.id),
    ).toBe(true);
    expect(manager.listSessionTelemetry({ gezelId: 'nobody' })).toHaveLength(0);

    await manager.deleteSession(session.id);
    expect(manager.sessionTelemetry(session.id)).toBeNull();
  }, 30_000);
});
