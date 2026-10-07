import type { Logger } from '../log.js';
import type { FileTurnIntent } from '../schemas/file-turn-intent.js';
import type { ChatEvent, ChatMessage, ProviderName } from '../schemas/gezel.js';
import type { SessionQueueState } from '../schemas/queue-status.js';
import type { QueuedMessage, SendToSessionRequest, TurnMessageOrigin } from '../schemas/session.js';
import type { Lane } from './provider-queue.js';

/**
 * Per-session FIFO of messages that arrived while their conversation was
 * already mid-turn. It serializes one conversation; the provider queue
 * then arbitrates between conversations on one engine. The daemon's
 * ChatManager and the phone runtime both own one, so queued chat, nudge
 * and interrupt behave the same on every host.
 *
 * Entries flagged `nudge` (the composer's mid-turn "Nudge") stay separate
 * while queued — individually editable and discardable — then contiguous
 * same-bucket nudges merge into ONE turn at drain time. Coalescable sends
 * (follow-up notifications) merge into the tail at enqueue time instead.
 *
 * In-memory only: unstarted entries do not survive a restart.
 */

export type SessionQueueEvent = Extract<ChatEvent, { type: 'queue_enqueued' | 'queue_removed' }>;

export interface QueuedSendOptions {
  /** Resolved by the host before admission; coalescing compares it. */
  messageOrigin: TurnMessageOrigin;
  from?: NonNullable<ChatMessage['from']>;
  /**
   * Merge into the tail IF the tail is also coalescable, from the same
   * sender, of the same origin, and neither side is a nudge or carries a
   * file-turn intent. Batches trivial follow-up notifications into one turn.
   */
  coalescable?: boolean;
  lane?: Lane;
  /** Truly-deferrable housekeeping; see `EnqueueRequest.ambient`. */
  ambient?: boolean;
  continuationMaxTokens?: number;
  fileTurnIntent?: FileTurnIntent;
  /** Persist and deliver to the model but never render a transcript bubble. */
  hidden?: boolean;
  /** Answer from the instructions and this message alone (a state-carrying seed). */
  standalone?: boolean;
  /** The turn's first request must call this tool (a reaction's declared `turn`). */
  requiredTool?: string;
  nudge?: boolean;
  /** The prompt draft this send was written in, if any. */
  draftId?: string;
  turnIntent?: NonNullable<SendToSessionRequest['turnIntent']>;
}

export type QueuedRunOptions<O extends QueuedSendOptions> = Omit<O, 'coalescable'>;

export type SessionSendAdmission<R, O extends QueuedSendOptions> =
  | {
      queued: true;
      result: Promise<R>;
      queueId: string;
      /** True when this send joined the tail entry instead of adding one. */
      merged: boolean;
      depth: number;
      /** Callers now waiting on the entry that carries this send. */
      waiters: number;
    }
  | { queued: false; runOptions: O };

export interface SessionSendQueueOptions {
  publish: (sessionId: string, event: SessionQueueEvent) => void;
  now?: () => number;
  newId?: () => string;
  log?: Pick<Logger, 'debug'>;
}

interface Waiter<R> {
  resolve: (value: R) => void;
  reject: (err: Error) => void;
}

interface Entry<R, O extends QueuedSendOptions> {
  id: string;
  text: string;
  enqueuedAt: number;
  opts: O;
  waiters: Waiter<R>[];
}

const ENTRY_PREVIEW_CHARS = 160;
const NEXT_PREVIEW_CHARS = 120;

function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

/**
 * User-initiated sends (no `from`) share a bucket, and so do sends from
 * one sender gezel. A user follow-up never merges into a gezel→gezel
 * handoff or vice versa, even when both opted into coalescing.
 */
function sameFromBucket(
  a: NonNullable<ChatMessage['from']> | undefined,
  b: NonNullable<ChatMessage['from']> | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.gezelId === b.gezelId;
}

/** Truthy-only run options, matching what a direct send would carry. */
function runOptionsOf<O extends QueuedSendOptions>(opts: O): QueuedRunOptions<O> {
  const { coalescable: _coalescable, ...rest } = opts;
  const out: Record<string, unknown> = { ...rest };
  for (const key of [
    'from',
    'turnIntent',
    'lane',
    'continuationMaxTokens',
    'fileTurnIntent',
    'draftId',
    'requiredTool',
  ] as const) {
    if (!out[key]) delete out[key];
  }
  for (const key of ['ambient', 'hidden', 'nudge', 'standalone'] as const) {
    if (out[key] !== true) delete out[key];
  }
  return out as QueuedRunOptions<O>;
}

export class SessionSendQueue<R, O extends QueuedSendOptions = QueuedSendOptions> {
  private readonly lists = new Map<string, Entry<R, O>[]>();
  private readonly publish: SessionSendQueueOptions['publish'];
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: Pick<Logger, 'debug'> | undefined;

  constructor(opts: SessionSendQueueOptions) {
    this.publish = opts.publish;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
    this.log = opts.log;
  }

  /**
   * Queue `text` when the session is busy or already has queued entries —
   * FIFO is preserved by checking the queue before the direct path, so a
   * late send never races the head. Otherwise the caller runs it now.
   *
   * A nudge that never queued is a normal send: the returned run options
   * drop its nudge flag, so the persisted message doesn't claim mid-turn
   * delivery. Its origin is left as the host resolved it.
   *
   * Synchronous by contract: the entry is in the queue before this returns.
   */
  admit(sessionId: string, busy: boolean, text: string, opts: O): SessionSendAdmission<R, O> {
    const list = this.lists.get(sessionId);
    if (!busy && (!list || list.length === 0)) {
      return { queued: false, runOptions: opts.nudge ? { ...opts, nudge: false } : opts };
    }
    let resolve!: (value: R) => void;
    let reject!: (err: Error) => void;
    const result = new Promise<R>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const q = list ?? [];
    const tail = q.length > 0 ? q[q.length - 1] : undefined;
    const canMerge =
      opts.fileTurnIntent === undefined &&
      tail?.opts.fileTurnIntent === undefined &&
      opts.coalescable === true &&
      opts.nudge !== true &&
      tail?.opts.coalescable === true &&
      tail.opts.nudge !== true &&
      tail.opts.messageOrigin === opts.messageOrigin &&
      sameFromBucket(tail.opts.from, opts.from);

    if (canMerge && tail) {
      // Every sender that merged resolves with the same final reply. The
      // merged turn is hidden only if BOTH parts were: a visible message
      // coalesced onto a hidden seed must still surface.
      tail.text = `${tail.text}\n\n${text}`;
      tail.opts.hidden = tail.opts.hidden === true && opts.hidden === true;
      // The latest seed carries the latest state, so it decides whether a
      // call is due.
      tail.opts.requiredTool = opts.requiredTool;
      tail.waiters.push({ resolve, reject });
      // Same queueId, so the UI upserts its ghost bubble.
      this.publishEnqueued(sessionId, tail);
      return {
        queued: true,
        result,
        queueId: tail.id,
        merged: true,
        depth: q.length,
        waiters: tail.waiters.length,
      };
    }

    const entry: Entry<R, O> = {
      id: this.newId(),
      text,
      enqueuedAt: this.now(),
      opts: { ...opts },
      waiters: [{ resolve, reject }],
    };
    q.push(entry);
    this.lists.set(sessionId, q);
    this.log?.debug(
      `queue#${sessionId.slice(0, 8)} ENQUEUED entry=${entry.id.slice(0, 8)} ` +
        `depth=${q.length} reason=${busy ? 'inflight' : 'queue-non-empty'}`,
    );
    this.publishEnqueued(sessionId, entry);
    return { queued: true, result, queueId: entry.id, merged: false, depth: q.length, waiters: 1 };
  }

  /**
   * Put `text` at the queue FRONT, for interrupt: the host cancels the
   * running turn next, and the aborted turn's drain can only pick this up
   * first. Never a nudge, so queued nudges behind it run as their own
   * merged turn afterwards.
   */
  enqueueFront(
    sessionId: string,
    text: string,
    opts: O,
  ): { result: Promise<R>; queueId: string; depth: number } {
    let resolve!: (value: R) => void;
    let reject!: (err: Error) => void;
    const result = new Promise<R>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const q = this.lists.get(sessionId) ?? [];
    const entry: Entry<R, O> = {
      id: this.newId(),
      text,
      enqueuedAt: this.now(),
      opts: { ...opts, nudge: false, coalescable: false },
      waiters: [{ resolve, reject }],
    };
    q.unshift(entry);
    this.lists.set(sessionId, q);
    this.log?.debug(
      `queue#${sessionId.slice(0, 8)} INTERRUPT entry=${entry.id.slice(0, 8)} depth=${q.length}`,
    );
    this.publishEnqueued(sessionId, entry);
    return { result, queueId: entry.id, depth: q.length };
  }

  /**
   * Shift the next entry and hand it to `run`, settling every waiter with
   * its outcome. Contiguous same-bucket nudges collapse into ONE turn,
   * joined the way enqueue-time coalescing joins; a non-nudge entry or a
   * bucket change breaks the run. Absorbed entries report
   * `queue_removed('started')` before the head that carries them.
   *
   * `run` is called synchronously, before this returns: hosts claim the
   * session's in-flight slot in `run`'s synchronous prologue, and interrupt
   * relies on that to dispatch exactly once. Returns false when the queue
   * was empty.
   */
  dispatchNext(
    sessionId: string,
    run: (text: string, opts: QueuedRunOptions<O>) => Promise<R>,
  ): boolean {
    const tag = sessionId.slice(0, 8);
    const q = this.lists.get(sessionId);
    if (!q || q.length === 0) {
      this.lists.delete(sessionId);
      this.log?.debug(`drain#${tag} empty`);
      return false;
    }
    const next = q.shift();
    if (!next) return false;
    if (next.opts.nudge === true) {
      while (q.length > 0) {
        const peek = q[0]!;
        if (
          peek.opts.nudge !== true ||
          (peek.opts.hidden === true) !== (next.opts.hidden === true) ||
          peek.opts.messageOrigin !== next.opts.messageOrigin ||
          next.opts.fileTurnIntent !== undefined ||
          peek.opts.fileTurnIntent !== undefined ||
          !sameFromBucket(peek.opts.from, next.opts.from)
        ) {
          break;
        }
        q.shift();
        next.text = `${next.text}\n\n${peek.text}`;
        next.waiters.push(...peek.waiters);
        this.publishRemoved(sessionId, peek.id, 'started');
      }
    }
    this.log?.debug(
      `drain#${tag} dispatch entry=${next.id.slice(0, 8)} ` +
        `remaining=${q.length} waiters=${next.waiters.length}${next.opts.nudge === true ? ' nudge' : ''}`,
    );
    if (q.length === 0) this.lists.delete(sessionId);
    // The ghost bubble is about to become a real user message.
    this.publishRemoved(sessionId, next.id, 'started');
    // Merged nudges keep the FIRST entry's options, including its draft:
    // the run is that draft's turn, and later nudges are appended text.
    void run(next.text, runOptionsOf(next.opts))
      .then((value) => {
        for (const w of next.waiters) {
          try {
            w.resolve(value);
          } catch {
            /* ignore per-waiter resolve failures */
          }
        }
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const w of next.waiters) {
          try {
            w.reject(error);
          } catch {
            /* ignore */
          }
        }
      });
    return true;
  }

  /**
   * Drop one entry. Its callers reject with "queued message canceled by
   * user". False when the id is gone (already started or discarded).
   */
  cancel(sessionId: string, queueId: string): boolean {
    const q = this.lists.get(sessionId);
    if (!q || q.length === 0) return false;
    const i = q.findIndex((e) => e.id === queueId);
    if (i === -1) return false;
    const [entry] = q.splice(i, 1);
    if (q.length === 0) this.lists.delete(sessionId);
    if (!entry) return false;
    const err = new Error('queued message canceled by user');
    for (const w of entry.waiters) {
      try {
        w.reject(err);
      } catch {
        /* ignore */
      }
    }
    this.publishRemoved(sessionId, entry.id, 'canceled');
    return true;
  }

  /**
   * Replace an entry's text in place. Position and `enqueuedAt` are kept,
   * so the ghost bubble's "waited Ns" doesn't reset, and the update is
   * re-published under the same queueId. Null when the id is gone.
   */
  update(sessionId: string, queueId: string, text: string): QueuedMessage | null {
    const q = this.lists.get(sessionId);
    if (!q || q.length === 0) return null;
    const entry = q.find((e) => e.id === queueId);
    if (!entry) return null;
    entry.text = text;
    this.publishEnqueued(sessionId, entry);
    return this.snapshotOf(entry);
  }

  /**
   * Drop every queued entry for `sessionId`, rejecting each caller with
   * `err`. The list is removed before any caller hears about it. Returns
   * how many entries were dropped.
   */
  rejectSession(sessionId: string, err: Error): number {
    const q = this.lists.get(sessionId);
    if (!q || q.length === 0) return 0;
    this.lists.delete(sessionId);
    for (const entry of q) {
      for (const w of entry.waiters) {
        try {
          w.reject(err);
        } catch {
          /* ignore — best-effort cleanup */
        }
      }
      this.publishRemoved(sessionId, entry.id, 'rejected');
    }
    return q.length;
  }

  depth(sessionId: string): number {
    return this.lists.get(sessionId)?.length ?? 0;
  }

  totalDepth(): number {
    let total = 0;
    for (const q of this.lists.values()) total += q.length;
    return total;
  }

  /** A snapshot, safe to iterate while entries are rejected or drained. */
  sessionIds(): string[] {
    return Array.from(this.lists.keys());
  }

  /** Full text of one session's queue, for `GET /api/sessions/:id/queue`. */
  listSession(sessionId: string): QueuedMessage[] {
    const q = this.lists.get(sessionId);
    if (!q || q.length === 0) return [];
    return q.map((e) => this.snapshotOf(e));
  }

  /** Cross-session previews for the `sessions` block of `/api/queues`. */
  list(providerOf?: (sessionId: string) => ProviderName | undefined): SessionQueueState[] {
    const out: SessionQueueState[] = [];
    for (const [sessionId, q] of this.lists) {
      if (q.length === 0) continue;
      const providerName = providerOf?.(sessionId);
      out.push({
        sessionId,
        ...(providerName ? { providerName } : {}),
        depth: q.length,
        nextPreview: preview(q[0]!.text, NEXT_PREVIEW_CHARS),
        entries: q.map((e) => ({
          queueId: e.id,
          preview: preview(e.text, ENTRY_PREVIEW_CHARS),
          enqueuedAt: new Date(e.enqueuedAt).toISOString(),
          ...(e.opts.nudge === true ? { nudge: true } : {}),
        })),
      });
    }
    return out;
  }

  private snapshotOf(entry: Entry<R, O>): QueuedMessage {
    return {
      queueId: entry.id,
      text: entry.text,
      preview: preview(entry.text, ENTRY_PREVIEW_CHARS),
      enqueuedAt: new Date(entry.enqueuedAt).toISOString(),
      nudge: entry.opts.nudge === true,
    };
  }

  private publishEnqueued(sessionId: string, entry: Entry<R, O>): void {
    this.publish(sessionId, {
      type: 'queue_enqueued',
      queueId: entry.id,
      preview: preview(entry.text, ENTRY_PREVIEW_CHARS),
      enqueuedAt: new Date(entry.enqueuedAt).toISOString(),
      ...(entry.opts.nudge === true ? { nudge: true } : {}),
    });
  }

  private publishRemoved(
    sessionId: string,
    queueId: string,
    reason: 'started' | 'canceled' | 'rejected',
  ): void {
    this.publish(sessionId, { type: 'queue_removed', queueId, reason });
  }
}
