import { type WriteStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatEventEnvelope } from '@bendyline/gezel';
import { SseStreamStaleError, streamAllChatEvents } from '@bendyline/gezel-client/node';

/** The slice of GezelClient the recorder needs — structural so tests can
 * point it at a stub SSE server without building a real client. */
export interface ChatEventStreamSource {
  allEventsUrl(): string;
  authHeader(): Record<string, string>;
  getFetch(): typeof fetch;
}

/**
 * Live chat-event tap for eval trials — the capture half of the run
 * recording ("exhaust"). Subscribes to the daemon's global envelope
 * stream (`/events/chat/all`, the same subscription the Electron shell
 * runs in production) and appends every envelope to
 * `recording/chat-events.jsonl` in the run dir.
 *
 * Why this exists: sessions persist turn-atomically, so the event
 * stream is the ONLY record of a turn a timeout killed — precisely the
 * turns a debugging replay most needs — and the only home for intra-turn
 * rhythm (deltas, engine phases, questions) that never reaches disk.
 *
 * Stance: best-effort, failure-isolated. A recorder fault degrades the
 * recording (gaps are declared in the manifest), never the verdict. The
 * distiller treats this log as ENRICHMENT over the sessions +
 * history.jsonl baseline.
 */

/** Line shape of chat-events.jsonl. `rx` is the recorder's receive time —
 * envelopes carry no timestamps of their own; loopback skew is sub-ms.
 * Coalesced delta lines add `rxLast`, `count`, `chars` (and cap `text`). */
export interface RecordedChatEventLine {
  rx: string;
  rxLast?: string;
  count?: number;
  chars?: number;
  sessionId: string;
  gezelId: string;
  projectId: string;
  event: unknown;
}

export interface ChatEventRecorderStats {
  lines: number;
  coalescedDeltas: number;
  gaps: Array<{ from: string; to: string }>;
  truncated: boolean;
}

export interface ChatEventRecorderHandle {
  /** Abort the subscription, flush pending coalesce buckets, close the file. */
  stop(): Promise<ChatEventRecorderStats>;
}

const COALESCE_TYPES = new Set(['delta', 'reasoning_delta', 'tool_args_delta']);
/** Flush a coalesce bucket after this much wall clock or this much text. */
const COALESCE_WINDOW_MS = 250;
const COALESCE_MAX_CHARS = 2048;
/** Retained delta TEXT per (session, turn) — final text lives in sessions/*.json. */
const MAX_TURN_DELTA_CHARS = 64 * 1024;
/** Hard cap on the file; past it we count and gap-mark but stop writing. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000];

interface CoalesceBucket {
  sessionId: string;
  gezelId: string;
  projectId: string;
  type: string;
  toolName?: string;
  rxFirst: number;
  rxLast: number;
  chars: number;
  count: number;
  text: string;
  textCapped: boolean;
}

export function startChatEventRecorder(opts: {
  client: ChatEventStreamSource;
  runDir: string;
  log: (line: string) => void;
}): ChatEventRecorderHandle {
  const { client, runDir, log } = opts;
  const abort = new AbortController();
  const stats: ChatEventRecorderStats = {
    lines: 0,
    coalescedDeltas: 0,
    gaps: [],
    truncated: false,
  };
  const buckets = new Map<string, CoalesceBucket>();
  /** Delta chars retained per session since its last `complete`/`done`. */
  const turnDeltaChars = new Map<string, number>();
  let stream: WriteStream | null = null;
  let bytesWritten = 0;
  let lastRxIso: string | null = null;
  let flushTimer: NodeJS.Timeout | null = null;

  const writeLine = (line: RecordedChatEventLine) => {
    if (stats.truncated || !stream) return;
    const text = `${JSON.stringify(line)}\n`;
    bytesWritten += Buffer.byteLength(text);
    if (bytesWritten > MAX_FILE_BYTES) {
      stats.truncated = true;
      log(
        `[recording] chat-events.jsonl hit its ${MAX_FILE_BYTES} byte cap; further events dropped`,
      );
      return;
    }
    stream.write(text);
    stats.lines += 1;
  };

  const flushBucket = (key: string, bucket: CoalesceBucket) => {
    buckets.delete(key);
    stats.coalescedDeltas += bucket.count;
    writeLine({
      rx: new Date(bucket.rxFirst).toISOString(),
      rxLast: new Date(bucket.rxLast).toISOString(),
      count: bucket.count,
      chars: bucket.chars,
      sessionId: bucket.sessionId,
      gezelId: bucket.gezelId,
      projectId: bucket.projectId,
      event: {
        type: bucket.type,
        ...(bucket.toolName ? { name: bucket.toolName } : {}),
        content: bucket.text,
        ...(bucket.textCapped ? { contentCapped: true } : {}),
      },
    });
  };

  const flushStale = (now: number, force = false) => {
    for (const [key, bucket] of buckets) {
      if (force || now - bucket.rxFirst >= COALESCE_WINDOW_MS) flushBucket(key, bucket);
    }
  };

  const flushSession = (sessionId: string) => {
    for (const [key, bucket] of buckets) {
      if (bucket.sessionId === sessionId) flushBucket(key, bucket);
    }
  };

  const onEnvelope = (envelope: ChatEventEnvelope) => {
    const now = Date.now();
    const rx = new Date(now).toISOString();
    lastRxIso = rx;
    const event = envelope.event as { type?: string; content?: string; name?: string };
    const type = String(event.type ?? '');
    if (COALESCE_TYPES.has(type) && typeof event.content === 'string') {
      const key = `${envelope.sessionId}|${type}|${event.name ?? ''}`;
      const retained = turnDeltaChars.get(envelope.sessionId) ?? 0;
      const bucket = buckets.get(key) ?? {
        sessionId: envelope.sessionId,
        gezelId: envelope.gezelId,
        projectId: envelope.projectId,
        type,
        ...(event.name ? { toolName: event.name } : {}),
        rxFirst: now,
        rxLast: now,
        chars: 0,
        count: 0,
        text: '',
        textCapped: false,
      };
      bucket.rxLast = now;
      bucket.chars += event.content.length;
      bucket.count += 1;
      if (retained < MAX_TURN_DELTA_CHARS) {
        bucket.text += event.content.slice(0, MAX_TURN_DELTA_CHARS - retained);
        turnDeltaChars.set(envelope.sessionId, retained + event.content.length);
      } else {
        bucket.textCapped = true;
      }
      buckets.set(key, bucket);
      if (bucket.chars >= COALESCE_MAX_CHARS) flushBucket(key, bucket);
      return;
    }
    // A non-delta event flushes that session's buckets first so ordering
    // inside the file stays faithful (deltas never appear after the
    // complete they streamed toward).
    flushSession(envelope.sessionId);
    if (type === 'complete' || type === 'done') turnDeltaChars.delete(envelope.sessionId);
    writeLine({
      rx,
      sessionId: envelope.sessionId,
      gezelId: envelope.gezelId,
      projectId: envelope.projectId,
      event: envelope.event,
    });
  };

  const run = async () => {
    await mkdir(join(runDir, 'recording'), { recursive: true });
    stream = createWriteStream(join(runDir, 'recording', 'chat-events.jsonl'), { flags: 'a' });
    flushTimer = setInterval(() => flushStale(Date.now()), COALESCE_WINDOW_MS);
    // Interval must never keep a finished trial process alive.
    flushTimer.unref?.();
    let attempt = 0;
    while (!abort.signal.aborted && !stats.truncated) {
      const disconnectedAt = lastRxIso;
      try {
        for await (const envelope of streamAllChatEvents({
          url: client.allEventsUrl(),
          headers: client.authHeader(),
          fetch: client.getFetch(),
          signal: abort.signal,
        })) {
          attempt = 0;
          onEnvelope(envelope);
        }
        // Server closed the stream cleanly — treat like a drop and retry.
      } catch (err) {
        if (abort.signal.aborted) break;
        const label =
          err instanceof SseStreamStaleError
            ? 'stale'
            : err instanceof Error
              ? err.message
              : String(err);
        log(`[recording] chat-event stream dropped (${label}); reconnecting`);
      }
      if (abort.signal.aborted) break;
      const backoff = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]!;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      if (abort.signal.aborted) break;
      // Declare the hole: anything emitted between the last received
      // event and this reconnect is unrecoverable.
      stats.gaps.push({
        from: disconnectedAt ?? new Date(0).toISOString(),
        to: new Date().toISOString(),
      });
    }
  };

  const running = run().catch((err) => {
    log(
      `[recording] recorder crashed (capture degraded): ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return {
    async stop(): Promise<ChatEventRecorderStats> {
      abort.abort();
      if (flushTimer) clearInterval(flushTimer);
      await running;
      flushStale(Date.now(), true);
      if (stream) {
        const s = stream;
        await new Promise<void>((resolve) => s.end(() => resolve()));
      }
      return stats;
    },
  };
}
