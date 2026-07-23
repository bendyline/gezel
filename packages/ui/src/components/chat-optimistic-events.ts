export interface OptimisticUserMessage {
  sessionId: string;
  gezelId: string;
  projectId: string;
  content: string;
  at: string;
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
