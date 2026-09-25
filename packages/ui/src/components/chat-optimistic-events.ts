export interface OptimisticUserMessage {
  sessionId: string;
  gezelId: string;
  projectId: string;
  content: string;
  at: string;
  /**
   * False when no model turn follows this message — the composer launched a
   * task from it and the daemon answered with a receipt, not a reply. The
   * timeline then paints the bubble without opening a thinking slot that
   * nothing would ever close.
   */
  expectsTurn?: boolean;
}

type Listener = (message: OptimisticUserMessage) => void;

const listeners = new Set<Listener>();

export function publishOptimisticUserMessage(message: OptimisticUserMessage): void {
  for (const listener of listeners) listener(message);
}

export function subscribeOptimisticUserMessages(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
