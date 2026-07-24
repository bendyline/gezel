import type { ChatEventEnvelope } from '@bendyline/gezel';
import {
  type SseStreamOptions,
  streamAllChatEvents,
  streamProjectChatEvents,
} from '@bendyline/gezel-client';

type ChatEventSource = (opts: SseStreamOptions) => AsyncGenerator<ChatEventEnvelope>;

interface Subscriber {
  queue: ChatEventEnvelope[];
  done: boolean;
  error?: unknown;
  wake?: () => void;
}

interface SharedStream {
  key: string;
  controller: AbortController;
  subscribers: Set<Subscriber>;
  started: boolean;
  /**
   * Per-session envelope cache for late joiners. The service's event bus
   * replays an in-flight turn's history only when a *new HTTP connection*
   * subscribes — but this fan-out deliberately keeps one upstream alive for
   * the app's lifetime (App-level status surfaces never unmount). A chat
   * timeline that unmounts on a tab switch and re-subscribes here would
   * otherwise get only future events: the accumulated thinking/partial text
   * of any in-flight turn silently vanishes. Mirror the bus's semantics
   * client-side: cache session-scoped envelopes as they flow, coalesce
   * adjacent deltas, drop transient pulses, clear a session on `done`, and
   * hand the cache to every new subscriber before live delivery starts.
   */
  replay: Map<string, ChatEventEnvelope[]>;
}

/** Mirror of the service bus's per-session history cap. */
const REPLAY_CAP = 500;

function recordForReplay(shared: SharedStream, envelope: ChatEventEnvelope): void {
  if (!envelope.sessionId) return;
  const { event } = envelope;
  if (event.type === 'heartbeat' || event.type === 'wire_pulse') return;
  if (event.type === 'done') {
    shared.replay.delete(envelope.sessionId);
    return;
  }
  let cached = shared.replay.get(envelope.sessionId);
  if (!cached) {
    cached = [];
    shared.replay.set(envelope.sessionId, cached);
  }
  if (event.type === 'delta' || event.type === 'reasoning_delta') {
    const tail = cached[cached.length - 1];
    if (tail?.event.type === event.type) {
      cached[cached.length - 1] = {
        ...tail,
        event: { type: event.type, content: tail.event.content + event.content },
      };
      return;
    }
  }
  cached.push(envelope);
  if (cached.length > REPLAY_CAP) cached.splice(0, cached.length - REPLAY_CAP);
}

/**
 * A renderer can have several surfaces interested in the global chat feed at
 * once (header status, needs-input, workshop, timeline, and so on). Opening an
 * HTTP/1.1 SSE connection for every surface exhausts Chromium's per-origin
 * connection pool and can strand ordinary API requests behind those streams.
 *
 * Keep one upstream connection per endpoint/auth pair and fan its envelopes
 * out in memory. Individual consumers still own their AbortSignal; the
 * upstream is aborted only after its final consumer leaves.
 */
const sharedStreams = new Map<string, SharedStream>();

function streamKey(opts: SseStreamOptions): string {
  const headers = Object.entries(opts.headers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name.toLowerCase()}:${value}`)
    .join('\n');
  return `${opts.method ?? 'GET'}\n${opts.url}\n${headers}`;
}

function wake(subscriber: Subscriber): void {
  const resolve = subscriber.wake;
  subscriber.wake = undefined;
  resolve?.();
}

function stopSubscriber(shared: SharedStream, subscriber: Subscriber): void {
  if (!shared.subscribers.delete(subscriber)) return;
  subscriber.queue.length = 0;
  subscriber.done = true;
  wake(subscriber);

  if (shared.subscribers.size === 0) {
    if (sharedStreams.get(shared.key) === shared) sharedStreams.delete(shared.key);
    shared.controller.abort();
  }
}

function startSharedStream(
  shared: SharedStream,
  opts: SseStreamOptions,
  source: ChatEventSource,
): void {
  if (shared.started) return;
  shared.started = true;

  const { signal: _subscriberSignal, ...upstreamOpts } = opts;
  void (async () => {
    try {
      for await (const envelope of source({
        ...upstreamOpts,
        signal: shared.controller.signal,
      })) {
        recordForReplay(shared, envelope);
        for (const subscriber of shared.subscribers) {
          subscriber.queue.push(envelope);
          wake(subscriber);
        }
      }
    } catch (error) {
      if (!shared.controller.signal.aborted) {
        for (const subscriber of shared.subscribers) {
          subscriber.error = error;
          wake(subscriber);
        }
      }
    } finally {
      if (sharedStreams.get(shared.key) === shared) sharedStreams.delete(shared.key);
      for (const subscriber of shared.subscribers) {
        subscriber.done = true;
        wake(subscriber);
      }
    }
  })();
}

async function* subscribeShared(
  opts: SseStreamOptions,
  source: ChatEventSource,
): AsyncGenerator<ChatEventEnvelope> {
  if (opts.signal?.aborted) return;

  const key = streamKey(opts);
  let shared = sharedStreams.get(key);
  if (!shared) {
    shared = {
      key,
      controller: new AbortController(),
      subscribers: new Set(),
      started: false,
      replay: new Map(),
    };
    sharedStreams.set(key, shared);
  }

  // Seed the queue from the replay cache BEFORE joining the live set — the
  // two steps share one synchronous block, so the pump loop can't deliver
  // an envelope in between (which would duplicate it: once via the cache,
  // once live).
  const subscriber: Subscriber = { queue: [], done: false };
  for (const cached of shared.replay.values()) subscriber.queue.push(...cached);
  shared.subscribers.add(subscriber);
  const abort = () => stopSubscriber(shared, subscriber);
  opts.signal?.addEventListener('abort', abort, { once: true });
  startSharedStream(shared, opts, source);

  try {
    for (;;) {
      const envelope = subscriber.queue.shift();
      if (envelope) {
        yield envelope;
        continue;
      }
      if (subscriber.error !== undefined) throw subscriber.error;
      if (subscriber.done) return;
      await new Promise<void>((resolve) => {
        subscriber.wake = resolve;
      });
    }
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    stopSubscriber(shared, subscriber);
  }
}

export function streamSharedAllChatEvents(
  opts: SseStreamOptions,
): AsyncGenerator<ChatEventEnvelope> {
  return subscribeShared(opts, streamAllChatEvents);
}

export function streamSharedProjectChatEvents(
  opts: SseStreamOptions,
): AsyncGenerator<ChatEventEnvelope> {
  return subscribeShared(opts, streamProjectChatEvents);
}
