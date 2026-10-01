import type { ProviderName } from '../schemas/gezel.js';
import { type MobileProviderId, MobileProviderIdSchema } from '../schemas/mobile-provider.js';
import type {
  ProviderQueueActiveItem,
  ProviderQueuePendingItem,
  ProviderQueueState,
  QueueStatusResponse,
} from '../schemas/queue-status.js';
import { UpdateQueuedMessageRequestSchema } from '../schemas/session.js';
import { json } from './http/json.js';
import type { ProviderQueue } from './provider-queue.js';
import type { SessionSendQueue } from './session-send-queue.js';

/**
 * What the phone's queue routes read. They touch memory only, so the host
 * answers them outside its admission lock: stopping queued work must work
 * even while a save is pending.
 */
export interface PortableQueueHost {
  engine: ProviderQueue;
  sendQueue: Pick<SessionSendQueue<unknown>, 'list' | 'listSession' | 'update' | 'cancel'>;
  providerOf(sessionId: string): ProviderName | undefined;
  /** The install's chat provider; engine work without a provider tag belongs to it. */
  defaultProvider(): Promise<MobileProviderId>;
  /** Crew handoffs created but not yet started, by recipient. */
  pendingHandoffs(): Array<{ gezelId: string; projectId: string }>;
  changed(): void;
}

function count(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

/**
 * The phone's `/api/queues`, in the daemon's wire shape. One engine queue
 * serves every provider; entries carry the provider they target, and a view
 * is reported for the configured provider plus any other that has work.
 */
async function queueStatus(host: PortableQueueHost): Promise<QueueStatusResponse> {
  const fallback = await host.defaultProvider();
  const described = host.engine.describe();
  const ownerOf = (item: { provider?: string }): MobileProviderId => {
    const parsed = MobileProviderIdSchema.safeParse(item.provider);
    return parsed.success ? parsed.data : fallback;
  };
  const owners = new Set<MobileProviderId>([fallback]);
  for (const item of [...described.active, ...described.pending]) owners.add(ownerOf(item));
  const activeOwner = described.active[0] ? ownerOf(described.active[0]) : undefined;
  const providers: QueueStatusResponse['providers'] = {};
  for (const provider of owners) {
    const active: ProviderQueueActiveItem[] = described.active.filter(
      (item) => ownerOf(item) === provider,
    );
    const pending: ProviderQueuePendingItem[] = described.pending.filter(
      (item) => ownerOf(item) === provider,
    );
    const owns = activeOwner === provider;
    const view: ProviderQueueState = {
      running: active.length,
      runningInteractive: owns ? described.runningInteractive : 0,
      runningBackground: owns ? described.runningBackground : 0,
      queuedInteractive: pending.filter((item) => item.lane === 'interactive').length,
      queuedBackground: pending.filter((item) => item.lane === 'background').length,
      ambientHeld: 0,
      concurrency: 1,
      interactiveConcurrency: 1,
      backgroundConcurrency: 1,
      maxConcurrency: 1,
      active,
      pending,
    };
    providers[provider] = view;
  }
  const byGezel: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  const handoffs = host.pendingHandoffs();
  for (const handoff of handoffs) {
    count(byGezel, handoff.gezelId);
    count(byProject, handoff.projectId);
  }
  return {
    providers,
    taskRunner: {
      pendingCount: handoffs.length,
      pendingByGezel: byGezel,
      pendingByProject: byProject,
      dispatchable: { count: handoffs.length, byGezel: { ...byGezel } },
      scheduled: { count: 0, byGezel: {} },
    },
    sessions: host.sendQueue.list((sessionId) => host.providerOf(sessionId)),
    cache: [],
    at: new Date().toISOString(),
  };
}

/** Engine-queue item controls: 404 for a provider the phone does not run. */
async function providerQueueItem(
  host: PortableQueueHost,
  request: Request,
  providerParam: string,
  idParam: string,
  move: boolean,
): Promise<Response> {
  const provider = MobileProviderIdSchema.safeParse(providerParam);
  if (!provider.success) return json({ error: `unknown provider: ${providerParam}` }, 404);
  const id = Number.parseInt(idParam, 10);
  if (!Number.isFinite(id)) return json({ error: 'id must be a number' }, 400);
  const entry = host.engine.describe().pending.find((item) => item.id === id);
  const fallback = await host.defaultProvider();
  const owner = MobileProviderIdSchema.safeParse(entry?.provider);
  const matches = !!entry && (owner.success ? owner.data : fallback) === provider.data;
  if (!move) {
    const cancelled = matches && host.engine.cancelPending(id);
    if (cancelled) host.changed();
    return json({ cancelled });
  }
  const body = (await request.json().catch(() => ({}))) as { direction?: unknown };
  if (body.direction !== 'up' && body.direction !== 'down')
    return json({ error: "direction must be 'up' or 'down'" }, 400);
  const moved = matches && host.engine.movePending(id, body.direction);
  if (moved) host.changed();
  return json({ moved });
}

/** Returns null for any request these routes do not own. */
export async function handlePortableQueueRoute(
  host: PortableQueueHost,
  request: Request,
  url: URL,
): Promise<Response | null> {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const [resource, id, action, child, subaction] = parts;
  const method = request.method;
  if (resource === 'queues') {
    if (!id && method === 'GET') return json(await queueStatus(host));
    if (id && action && !child && method === 'DELETE')
      return providerQueueItem(host, request, id, action, false);
    if (id && action && child === 'move' && !subaction && method === 'POST')
      return providerQueueItem(host, request, id, action, true);
    return null;
  }
  if (resource !== 'sessions' || !id || action !== 'queue' || subaction) return null;
  if (!child && method === 'GET')
    return json({ sessionId: id, entries: host.sendQueue.listSession(id) });
  if (child && method === 'PATCH') {
    const body = UpdateQueuedMessageRequestSchema.parse(await request.json());
    const entry = host.sendQueue.update(id, child, body.message);
    if (!entry)
      return json({ error: 'queued message not found (already started or removed)' }, 404);
    return json({ updated: true, entry });
  }
  if (child && method === 'DELETE') {
    const cancelled = host.sendQueue.cancel(id, child);
    if (cancelled) host.changed();
    return json({ cancelled });
  }
  return null;
}
