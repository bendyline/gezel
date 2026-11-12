import type { ChatEventEnvelope } from '@bendyline/gezel';
import { markReadsStale, setRead } from './api-reads.js';
import type { ReadScope } from './reads.js';

/**
 * Something changed what the daemon would answer. Every read in the scopes is
 * marked stale: reads a mounted view is watching ask again now, the rest ask
 * when next wanted. Kept answers keep painting until the new ones arrive.
 */
export function dataChanged(scopes: ReadScope | readonly ReadScope[] | 'all' = 'all'): void {
  markReadsStale(typeof scopes === 'string' && scopes !== 'all' ? [scopes] : scopes, {
    refetch: true,
  });
}

/** The stream events that change a read, and the scopes they change. Deltas and pulses change none. */
const STREAM_EVENT_SCOPES: Partial<Record<ChatEventEnvelope['event']['type'], ReadScope[]>> = {
  user_message_pending: ['live'],
  user_message: ['live'],
  complete: ['live'],
  done: ['live'],
  error: ['live'],
  cancelled: ['live'],
  queue_enqueued: ['live'],
  queue_removed: ['live'],
  task_event: ['live'],
  question_asked: ['live'],
  question_answered: ['live'],
};

export function streamEventChangedData(type: ChatEventEnvelope['event']['type']): void {
  const scopes = STREAM_EVENT_SCOPES[type];
  if (scopes) dataChanged(scopes);
}

/**
 * Writes that change nothing a shared read returns. Each used to empty the
 * cache: warming fires on every chat open, and a draft autosaves about once a
 * second while the person types, so the views around a composer refetched
 * constantly.
 */
const NON_DATA_WRITES = [
  /\/api\/system\/perf\/client$/,
  /\/api\/models\/test$/,
  /\/api\/cache\/warm$/,
  /\/api\/projects\/[^/]+\/prompt-drafts(?:\/|$)/,
  /\/api\/projects\/[^/]+\/preview-capability$/,
];

/**
 * Mark reads stale on both sides of a write, failed writes included (a failed
 * write may still have landed). Before the write nothing is read again, so a
 * view does not race the write it is waiting on; after it, watched reads ask
 * again.
 */
export function withReadInvalidation(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const url = String(input instanceof Request ? input.url : input);
    const path = url.split('?', 1)[0]!;
    const changesData =
      method !== 'GET' &&
      method !== 'HEAD' &&
      !NON_DATA_WRITES.some((pattern) => pattern.test(path));
    if (changesData) markReadsStale('all', { refetch: false });
    try {
      return await fetchImpl(input, init);
    } finally {
      if (changesData) markReadsStale('all', { refetch: true });
    }
  };
}

/**
 * Window events that announce a product change. They predate the cache and
 * still fire from many surfaces; each now marks reads stale. A config change
 * carries the saved values, so the config read shows them at once.
 */
const PRODUCT_CHANGE_EVENTS = [
  'gezel:config-updated',
  'gezel:project-created',
  'gezel:project-updated',
  'gezel:project-deleted',
  'gezel:gezel-updated',
  'gezel:gezel-deleted',
] as const;

const SCOPES_BESIDE_CONFIG: ReadScope[] = ['roster', 'projects', 'live', 'home', 'engines'];

function onProductChange(event: Event): void {
  const detail = (event as CustomEvent).detail;
  if (event.type !== 'gezel:config-updated' || !detail || typeof detail !== 'object') {
    dataChanged('all');
    return;
  }
  // The event carries what was just saved, so it is the config read's answer.
  // Reading config again would race it; a config read still in flight was
  // started after the write and lands the same values.
  setRead(
    'getConfig',
    [],
    (previous) =>
      ({
        ...(previous ?? {}),
        ...(detail as Partial<NonNullable<typeof previous>>),
      }) as NonNullable<typeof previous>,
  );
  dataChanged(SCOPES_BESIDE_CONFIG);
}

let watching = false;

/** Listen for the product-change window events. Idempotent. */
export function watchProductChangeEvents(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  for (const type of PRODUCT_CHANGE_EVENTS) window.addEventListener(type, onProductChange);
}
