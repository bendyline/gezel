import type { TerminalEventEnvelope, TerminalMessageEvent } from '@bendyline/gezel';

type Listener = (envelope: TerminalEventEnvelope) => void;

const REPLAY_WINDOW_MS = 60_000;
const MAX_REPLAY_MESSAGES = 100;

interface RecentMessage {
  publishedAt: number;
  envelope: TerminalMessageEvent;
}

/**
 * Per-project pub/sub for terminal events. The envelope is a
 * discriminated union (`kind: 'message' | 'workingDirChanged'`)
 * defined in core's schemas — both variants flow through the same
 * project listener; consumers narrow by `kind`.
 *
 * Lifetime: bus is created in `service.ts` alongside `chatEvents` and
 * lives for the life of the process. Subscriptions return an
 * unsubscribe handle. Persisted message events keep a short replay window
 * so a project timeline that is still opening its SSE connection cannot
 * miss a command submitted from the already-mounted composer. Consumers
 * dedupe replay against their initial disk snapshot by message id.
 */
export class TerminalEventBus {
  private readonly projectListeners = new Map<string, Set<Listener>>();
  private readonly recentMessages = new Map<string, RecentMessage[]>();

  publish(envelope: TerminalEventEnvelope): void {
    if (envelope.kind === 'message') {
      const publishedAt = Date.now();
      const cutoff = publishedAt - REPLAY_WINDOW_MS;
      const recent = (this.recentMessages.get(envelope.projectId) ?? []).filter(
        (entry) => entry.publishedAt >= cutoff,
      );
      recent.push({ publishedAt, envelope });
      if (recent.length > MAX_REPLAY_MESSAGES) {
        recent.splice(0, recent.length - MAX_REPLAY_MESSAGES);
      }
      this.recentMessages.set(envelope.projectId, recent);
    }

    const set = this.projectListeners.get(envelope.projectId);
    if (!set) return;
    for (const listener of set) listener(envelope);
  }

  subscribeProject(projectId: string, listener: Listener): () => void {
    let set = this.projectListeners.get(projectId);
    if (!set) {
      set = new Set();
      this.projectListeners.set(projectId, set);
    }
    set.add(listener);

    const cutoff = Date.now() - REPLAY_WINDOW_MS;
    const recent = (this.recentMessages.get(projectId) ?? []).filter(
      (entry) => entry.publishedAt >= cutoff,
    );
    if (recent.length > 0) {
      this.recentMessages.set(projectId, recent);
      for (const entry of recent) listener(entry.envelope);
    } else {
      this.recentMessages.delete(projectId);
    }

    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.projectListeners.delete(projectId);
    };
  }
}

export type { TerminalEventEnvelope };
