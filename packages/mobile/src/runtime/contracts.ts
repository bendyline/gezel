import type { MobileProvider, MobileProviderId, MobileSnapshot } from '@bendyline/gezel/schemas';

/** Native adapters own the one state document and its atomic replacement. */
export interface MobileStorage {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

export interface MobileInferenceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface MobileInference {
  providers(): Promise<MobileProvider[]>;
  generate(
    request: {
      requestId: string;
      providerId: MobileProviderId;
      messages: MobileInferenceMessage[];
    },
    onDelta: (event: { requestId: string; delta: string }) => void,
  ): Promise<{ text: string; stopReason: 'stop' | 'length' | 'cancelled' }>;
  /** Resolves once this request has released the engine; never cancels a newer request. */
  cancel(requestId: string): Promise<void>;
}

export interface MobileRuntimeOptions {
  storage: MobileStorage;
  inference: MobileInference;
  createId(): string;
  now(): string;
}

/** The UI reaches this interface through its request/event transport. */
export interface MobileClient {
  snapshot(): Promise<MobileSnapshot>;
  providers(): Promise<MobileProvider[]>;
  setProvider(providerId: MobileProviderId): Promise<MobileSnapshot>;
  newConversation(): Promise<MobileSnapshot>;
  selectConversation(sessionId: string): Promise<MobileSnapshot>;
  renameConversation(sessionId: string, title: string): Promise<MobileSnapshot>;
  deleteConversation(sessionId: string): Promise<MobileSnapshot>;
  /** Resolves only after the response's terminal state is durable. */
  send(text: string): Promise<MobileSnapshot>;
  cancel(): Promise<MobileSnapshot>;
  /** Retries a terminal reply, or verifies storage recovery without applying a failed idle edit. */
  retrySave(): Promise<MobileSnapshot>;
  subscribe(listener: (snapshot: MobileSnapshot) => void): () => void;
}
