import { type GezelConfig, SECURITY_PRESETS } from '@bendyline/gezel';
import type { ProjectConnectorBinding, ProjectDetail } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import type { SystemIdleState } from '../system/idle-state.js';
import type { BindingSyncResult } from './manager.js';
import { connectorSyncSource } from './product-wiring.js';
import { ConnectorSyncManager } from './sync-manager.js';

const MINUTE = 60_000;
const SYNC_INTERVAL = 5 * MINUTE;
const FAILURE_BACKOFF = 5 * MINUTE;

type Health = 'ok' | 'fails' | 'hangs';

interface FakeBinding {
  id: string;
  health: Health;
  disabled?: boolean;
  lastSyncedAt?: string;
  /** The type's own interval (`syncIntervalMinutes`), in ms. */
  intervalMs?: number;
  /** Its last pass could not reach the service. */
  waiting?: boolean;
}

/**
 * The parts of ConnectorManager the loop reaches through the production
 * source: eligibility, failure backoff, and a pass that records success the
 * way the real one does (lastSyncedAt only on success, backoff on failure).
 */
function fakeConnectors(projects: Map<string, FakeBinding[]>) {
  const backoff = new Map<string, number>();
  const synced: string[] = [];
  const asBindings = (list: FakeBinding[]) =>
    list.map(
      (b) =>
        ({
          id: b.id,
          type: 'rss-feed',
          ...(b.disabled ? { disabled: true } : {}),
          ...(b.lastSyncedAt ? { lastSyncedAt: b.lastSyncedAt } : {}),
          ...(b.waiting ? { unreachable: { since: '2026-11-16T08:00:00Z', offline: true } } : {}),
        }) as ProjectConnectorBinding,
    );
  const connectors = {
    backgroundBindings: async (project: { id?: string; connectors?: ProjectConnectorBinding[] }) =>
      (project.connectors ?? []).filter((b) => !b.disabled),
    syncIntervalMs: async (binding: ProjectConnectorBinding) =>
      [...projects.values()].flat().find((b) => b.id === binding.id)?.intervalMs,
    backoffUntil: (id: string) => {
      const until = backoff.get(id);
      return until !== undefined && until > Date.now() ? until : undefined;
    },
    syncProject: async (project: ProjectDetail, opts?: { bindingIds?: readonly string[] }) => {
      const results: BindingSyncResult[] = [];
      for (const b of projects.get(project.id) ?? []) {
        if (b.disabled || !opts?.bindingIds?.includes(b.id)) continue;
        if (connectors.backoffUntil(b.id)) continue;
        synced.push(b.id);
        if (b.health === 'hangs') await new Promise<never>(() => {});
        if (b.health === 'fails') {
          backoff.set(b.id, Date.now() + FAILURE_BACKOFF);
          results.push({
            written: 0,
            quarantined: 0,
            skipped: 0,
            pruned: 0,
            errors: 1,
            cursor: undefined,
            error: 'boom',
          });
          continue;
        }
        b.lastSyncedAt = new Date().toISOString();
        results.push({
          written: 1,
          quarantined: 0,
          skipped: 0,
          pruned: 0,
          errors: 0,
          cursor: undefined,
        });
      }
      return results;
    },
  };
  const store = {
    readConfig: async () => ({ security: SECURITY_PRESETS.free }) as unknown as GezelConfig,
    listProjects: async () =>
      [...projects].map(([id, list]) => ({ id, connectors: asBindings(list) })),
    getProject: async (id: string) =>
      projects.has(id)
        ? ({ id, connectors: asBindings(projects.get(id)!) } as ProjectDetail)
        : null,
  } as unknown as Store;
  return { connectors, store, synced };
}

function loop(
  projects: Map<string, FakeBinding[]>,
  opts: { passBudgetMs?: number; osIdleSeconds?: number; chatActive?: () => boolean } = {},
) {
  const { connectors, store, synced } = fakeConnectors(projects);
  const { osIdleSeconds = null, chatActive = () => false, ...rest } = opts;
  const manager = new ConnectorSyncManager({
    store,
    chat: { isAnyActive: chatActive, isProjectActive: () => false } as unknown as ChatManager,
    idle: { osIdleSeconds: () => osIdleSeconds } as unknown as SystemIdleState,
    source: connectorSyncSource(connectors as never),
    syncIntervalMs: SYNC_INTERVAL,
    ...rest,
  });
  return { manager, synced };
}

/** Run `n` ticks a scheduler interval apart, as the timer would. */
async function ticks(manager: ConnectorSyncManager, n: number, stepMs = 90_000) {
  for (let i = 0; i < n; i++) {
    await manager.tick();
    vi.setSystemTime(Date.now() + stepMs);
  }
}

describe('ConnectorSyncManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the production source lists only bindings the loop can sync', async () => {
    const policy = { allowConnectorData: true, allowExternalServices: true } as never;
    const { connectors } = fakeConnectors(new Map());
    const source = connectorSyncSource(connectors as never);
    expect(source.posture(policy)).toBe(true);
    const listed = await source.listBindings(
      {
        id: 'p',
        connectors: [
          { id: 'a', type: 't' },
          { id: 'b', type: 't', disabled: true },
        ],
      } as never,
      policy,
    );
    expect(listed.map((b) => b.id)).toEqual(['a']);
  });

  it('while the person works, only a connection waiting for the network catches up', async () => {
    let chatting = false;
    const { manager, synced } = loop(
      new Map([
        ['A', [{ id: 'routine', health: 'ok' }]],
        ['B', [{ id: 'landed', health: 'ok', waiting: true }]],
      ]),
      { osIdleSeconds: 5, chatActive: () => chatting },
    );
    chatting = true;
    await ticks(manager, 2);
    expect(synced).toEqual([]);
    chatting = false;
    await ticks(manager, 2);
    expect(synced).toEqual(['landed']);
  });

  it('syncs two healthy projects in turn', async () => {
    const { manager, synced } = loop(
      new Map([
        ['A', [{ id: 'a', health: 'ok' }]],
        ['B', [{ id: 'b', health: 'ok' }]],
      ]),
    );
    await ticks(manager, 2);
    expect(synced).toEqual(['a', 'b']);
  });

  it('a binding that never synced and keeps failing does not starve other projects', async () => {
    const { manager, synced } = loop(
      new Map([
        ['A', [{ id: 'broken', health: 'fails' }]],
        ['B', [{ id: 'b', health: 'ok' }]],
      ]),
    );
    // An hour of ticks: B syncs whenever it is due; A is tried only when its
    // backoff has run out.
    await ticks(manager, 40);
    const bSyncs = synced.filter((id) => id === 'b').length;
    const brokenTries = synced.filter((id) => id === 'broken').length;
    expect(bSyncs).toBeGreaterThanOrEqual(10);
    expect(brokenTries).toBeLessThanOrEqual(bSyncs + 1);
  });

  it('a project that last synced long ago but now fails does not starve the others', async () => {
    const longAgo = new Date('2026-11-01T00:00:00Z').toISOString();
    const { manager, synced } = loop(
      new Map([
        ['A', [{ id: 'stale', health: 'fails', lastSyncedAt: longAgo }]],
        ['B', [{ id: 'b', health: 'ok' }]],
      ]),
    );
    await ticks(manager, 40);
    expect(synced.filter((id) => id === 'b').length).toBeGreaterThanOrEqual(10);
  });

  it('a paused binding never makes its project due', async () => {
    const { manager, synced } = loop(
      new Map([
        ['A', [{ id: 'paused', health: 'ok', disabled: true }]],
        ['B', [{ id: 'b', health: 'ok' }]],
      ]),
    );
    await ticks(manager, 6);
    expect(synced).not.toContain('paused');
    expect(synced.filter((id) => id === 'b').length).toBeGreaterThanOrEqual(2);
  });

  it('syncs only the bindings that are due, not a healthy sibling', async () => {
    const { manager, synced } = loop(
      new Map([
        [
          'A',
          [
            { id: 'fresh', health: 'ok' },
            { id: 'broken', health: 'fails' },
          ],
        ],
      ]),
    );
    // Tick 1 syncs both; afterwards `broken` comes due every 5 minutes as its
    // backoff ends, while `fresh` is due only every 5 minutes.
    await ticks(manager, 40);
    const fresh = synced.filter((id) => id === 'fresh').length;
    expect(fresh).toBeLessThanOrEqual(Math.ceil((40 * 90_000) / SYNC_INTERVAL) + 1);
  });

  it('a type with its own interval syncs on that interval, not the loop default', async () => {
    const hour = 60 * 60_000;
    const { manager, synced } = loop(
      new Map([
        ['A', [{ id: 'paid', health: 'ok', intervalMs: hour }]],
        ['B', [{ id: 'cheap', health: 'ok' }]],
      ]),
    );
    // Two hours of ticks, 90 seconds apart.
    await ticks(manager, 80);
    expect(synced.filter((id) => id === 'paid').length).toBeLessThanOrEqual(3);
    expect(synced.filter((id) => id === 'cheap').length).toBeGreaterThanOrEqual(10);
  });

  it('a pass that hangs does not stop other projects syncing', async () => {
    vi.useRealTimers();
    const { manager, synced } = loop(
      new Map([
        ['A', [{ id: 'hung', health: 'hangs' }]],
        ['B', [{ id: 'b', health: 'ok' }]],
      ]),
      { passBudgetMs: 150 },
    );
    await manager.tick(); // A: hangs past the budget
    await manager.tick(); // B
    await manager.tick(); // A is still running, so it is not started again
    expect(synced).toEqual(['hung', 'b']);
  });
});
