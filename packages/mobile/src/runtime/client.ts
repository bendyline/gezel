import {
  MOBILE_MAX_CONTEXT_CHARS,
  MOBILE_MAX_INPUT_CHARS,
  MOBILE_MAX_MESSAGES,
  MOBILE_MAX_MESSAGE_CHARS,
  MOBILE_MAX_SESSIONS,
  type MobileMessage,
  type MobileProvider,
  type MobileProviderId,
  MobileProviderIdSchema,
  MobileProviderListSchema,
  type MobileSnapshot,
  type MobileState,
} from '@bendyline/gezel/schemas';
import type { MobileClient, MobileInferenceMessage, MobileRuntimeOptions } from './contracts.js';
import {
  copyState,
  initialState,
  newSession,
  parseState,
  recoverInterrupted,
  serializeState,
} from './store.js';

interface ActiveTurn {
  requestId: string;
  providerId: MobileProviderId;
  sessionId: string;
  text: string;
  started: boolean;
  stopping: boolean;
  released: boolean;
  maxResponseChars: number;
  terminal?: {
    status: 'complete' | 'interrupted' | 'error';
    error?: string;
    stopReason?: MobileMessage['stopReason'];
  };
  messages: MobileInferenceMessage[];
  done: Promise<MobileSnapshot>;
  resolve(snapshot: MobileSnapshot): void;
  reject(error: Error): void;
}

function messageFor(error: unknown): string {
  return (error instanceof Error ? error.message : 'The response could not be completed.').slice(
    0,
    1_000,
  );
}

class ForegroundMobileClient implements MobileClient {
  private state?: MobileState;
  private loading?: Promise<void>;
  private mutations: Promise<void> = Promise.resolve();
  private active?: ActiveTurn;
  private persistenceError: string | null = null;
  private cancellationError: string | null = null;
  private listeners = new Set<(snapshot: MobileSnapshot) => void>();

  constructor(private readonly options: MobileRuntimeOptions) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async ready(): Promise<void> {
    if (this.state) return;
    if (!this.loading) {
      this.loading = (async () => {
        const raw = await this.options.storage.load();
        const state = raw === null ? initialState(this.options) : parseState(raw);
        const recovered = recoverInterrupted(state);
        const migrated = raw !== null && JSON.parse(raw).selectedProviderId === undefined;
        if (raw === null || recovered || migrated)
          await this.options.storage.save(serializeState(state));
        this.state = state;
      })().finally(() => {
        this.loading = undefined;
      });
    }
    await this.loading;
  }

  private current(): MobileSnapshot {
    if (!this.state) throw new Error('Mobile conversations have not loaded.');
    const state = copyState(this.state);
    const turn = this.active;
    if (turn) {
      const message = state.sessions
        .find((session) => session.id === turn.sessionId)
        ?.messages.find((entry) => entry.id === turn.requestId);
      if (message) {
        message.content = turn.text;
        if (turn.terminal) Object.assign(message, turn.terminal);
      }
    }
    return {
      state,
      activeRequestId: turn?.requestId ?? null,
      persistenceError: this.persistenceError,
      cancellationError: this.cancellationError,
    };
  }

  private publish(): void {
    for (const listener of this.listeners) {
      // A view listener cannot change the store or interrupt a durable commit.
      try {
        listener(this.current());
      } catch {}
    }
  }

  private async commit(state: MobileState): Promise<void> {
    try {
      await this.options.storage.save(serializeState(state));
      this.state = state;
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = `Could not save this conversation: ${messageFor(error)}`.slice(
        0,
        1_000,
      );
      this.publish();
      throw new Error(this.persistenceError);
    }
  }

  private requireIdle(): void {
    if (this.active)
      throw new Error('Stop the current response before starting another conversation or message.');
  }

  private nextId(state: MobileState): string {
    const id = this.options.createId();
    if (
      state.sessions.some(
        (session) => session.id === id || session.messages.some((message) => message.id === id),
      )
    ) {
      throw new Error('The generated conversation identifier is already in use.');
    }
    return id;
  }

  async snapshot(): Promise<MobileSnapshot> {
    await this.ready();
    return this.current();
  }

  async providers(): Promise<MobileProvider[]> {
    return MobileProviderListSchema.parse(await this.options.inference.providers());
  }

  private async requireProvider(providerId: MobileProviderId): Promise<MobileProvider> {
    MobileProviderIdSchema.parse(providerId);
    const provider = (await this.providers()).find((entry) => entry.id === providerId);
    if (!provider || provider.availability !== 'available') {
      throw new Error(provider?.reason || 'The selected on-device provider is unavailable.');
    }
    return provider;
  }

  setProvider(providerId: MobileProviderId): Promise<MobileSnapshot> {
    return this.enqueue(async () => {
      await this.ready();
      this.requireIdle();
      await this.requireProvider(providerId);
      const next = copyState(this.state!);
      next.selectedProviderId = providerId;
      await this.commit(next);
      this.publish();
      return this.current();
    });
  }

  subscribe(listener: (snapshot: MobileSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  newConversation(): Promise<MobileSnapshot> {
    return this.enqueue(async () => {
      await this.ready();
      this.requireIdle();
      const next = copyState(this.state!);
      if (next.sessions.length >= MOBILE_MAX_SESSIONS)
        throw new Error(
          'The mobile conversation limit has been reached. Existing conversations remain saved.',
        );
      const session = newSession({ now: this.options.now, createId: () => this.nextId(next) });
      next.sessions.push(session);
      next.activeSessionId = session.id;
      await this.commit(next);
      this.publish();
      return this.current();
    });
  }

  selectConversation(sessionId: string): Promise<MobileSnapshot> {
    return this.enqueue(async () => {
      await this.ready();
      this.requireIdle();
      const next = copyState(this.state!);
      if (!next.sessions.some((session) => session.id === sessionId))
        throw new Error('This conversation could not be found.');
      next.activeSessionId = sessionId;
      await this.commit(next);
      this.publish();
      return this.current();
    });
  }

  renameConversation(sessionId: string, title: string): Promise<MobileSnapshot> {
    return this.enqueue(async () => {
      await this.ready();
      this.requireIdle();
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 100)
        throw new Error('Use a conversation name between 1 and 100 characters.');
      const next = copyState(this.state!);
      const session = next.sessions.find((entry) => entry.id === sessionId);
      if (!session) throw new Error('This conversation could not be found.');
      session.title = title.trim();
      await this.commit(next);
      this.publish();
      return this.current();
    });
  }

  deleteConversation(sessionId: string): Promise<MobileSnapshot> {
    return this.enqueue(async () => {
      await this.ready();
      this.requireIdle();
      const next = copyState(this.state!);
      if (!next.sessions.some((session) => session.id === sessionId))
        throw new Error('This conversation could not be found.');
      const replacement =
        next.sessions.length === 1
          ? newSession({ now: this.options.now, createId: () => this.nextId(next) })
          : undefined;
      next.sessions = replacement
        ? [replacement]
        : next.sessions.filter((session) => session.id !== sessionId);
      if (next.activeSessionId === sessionId) {
        next.activeSessionId = next.sessions
          .slice()
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]!.id;
      }
      await this.commit(next);
      this.publish();
      return this.current();
    });
  }

  async send(text: string): Promise<MobileSnapshot> {
    const turn = await this.enqueue(async () => {
      await this.ready();
      this.requireIdle();
      if (typeof text !== 'string' || text.trim().length === 0)
        throw new Error('Write a message first.');
      if (text.length > MOBILE_MAX_INPUT_CHARS)
        throw new Error('This message is too long for the mobile preview.');
      const next = copyState(this.state!);
      const session = next.sessions.find((entry) => entry.id === next.activeSessionId)!;
      if (session.messages.length + 2 > MOBILE_MAX_MESSAGES)
        throw new Error('This conversation is full. Start a new conversation to continue.');
      const provider = await this.requireProvider(next.selectedProviderId);
      const history: MobileInferenceMessage[] = [];
      // Include whole usable pairs. A failed reply must not leave an orphan user turn
      // that strict native chat templates cannot accept on the next request.
      for (let index = 0; index < session.messages.length; index += 2) {
        const user = session.messages[index]!;
        const assistant = session.messages[index + 1]!;
        if (!['complete', 'interrupted'].includes(assistant.status) || !assistant.content.trim())
          continue;
        history.push(
          { role: 'user', content: user.content },
          { role: 'assistant', content: assistant.content },
        );
      }
      const messages: MobileInferenceMessage[] = [
        { role: 'system', content: next.gezel.about },
        ...history,
        { role: 'user', content: text },
      ];
      // These are allocation guards, not a tokenizer. Each native provider enforces its
      // exact context/output token limits before inference.
      const maxContextChars = Math.min(
        MOBILE_MAX_CONTEXT_CHARS,
        (provider.contextTokens - provider.maxOutputTokens) * 4,
      );
      if (messages.reduce((sum, message) => sum + message.content.length, 0) > maxContextChars) {
        throw new Error(
          'This conversation is too long for the mobile model. Start a new conversation to continue.',
        );
      }
      const at = this.options.now();
      session.messages.push({
        id: this.nextId(next),
        role: 'user',
        content: text,
        at,
        status: 'complete',
      });
      const requestId = this.nextId(next);
      session.messages.push({
        id: requestId,
        role: 'assistant',
        content: '',
        at,
        status: 'streaming',
        providerId: provider.id,
      });
      session.lastActivityAt = at;
      if (session.messages.length === 2 && session.title === 'New conversation')
        session.title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
      await this.commit(next);
      let resolve!: ActiveTurn['resolve'];
      let reject!: ActiveTurn['reject'];
      const done = new Promise<MobileSnapshot>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const active: ActiveTurn = {
        requestId,
        providerId: provider.id,
        sessionId: session.id,
        text: '',
        started: false,
        stopping: false,
        released: false,
        maxResponseChars: Math.min(MOBILE_MAX_MESSAGE_CHARS, provider.maxOutputTokens * 8),
        messages,
        done,
        resolve,
        reject,
      };
      this.active = active;
      this.cancellationError = null;
      this.publish();
      return active;
    });
    if (this.active === turn && !turn.stopping) void this.generate(turn);
    return turn.done;
  }

  private async finish(turn: ActiveTurn): Promise<MobileSnapshot> {
    return this.enqueue(async () => {
      if (this.active !== turn) return this.current();
      if (!turn.released || !turn.terminal) throw new Error('The model has not stopped yet.');
      turn.stopping = true;
      const next = copyState(this.state!);
      const session = next.sessions.find((entry) => entry.id === turn.sessionId)!;
      const message = session.messages.find((entry) => entry.id === turn.requestId)!;
      Object.assign(message, { content: turn.text, ...turn.terminal });
      session.lastActivityAt = this.options.now();
      try {
        await this.commit(next);
      } catch (error) {
        turn.reject(error instanceof Error ? error : new Error(messageFor(error)));
        throw error;
      }
      this.active = undefined;
      this.cancellationError = null;
      this.publish();
      const snapshot = this.current();
      turn.resolve(snapshot);
      return snapshot;
    });
  }

  private async generate(turn: ActiveTurn): Promise<void> {
    turn.started = true;
    try {
      const result = await this.options.inference.generate(
        { requestId: turn.requestId, providerId: turn.providerId, messages: turn.messages },
        (event) => {
          if (this.active !== turn || turn.stopping || event.requestId !== turn.requestId) return;
          if (
            typeof event.delta !== 'string' ||
            turn.text.length + event.delta.length > turn.maxResponseChars
          ) {
            turn.stopping = true;
            turn.terminal = {
              status: 'error',
              error: 'The model response exceeded the supported size.',
            };
            void this.stop(turn).catch(() => {});
            return;
          }
          turn.text += event.delta;
          this.publish();
        },
      );
      this.markReleased(turn);
      if (this.active !== turn) return;
      if (turn.terminal) {
        await this.finish(turn);
        return;
      }
      if (
        !result ||
        typeof result.text !== 'string' ||
        result.text.length > turn.maxResponseChars ||
        !['stop', 'length', 'cancelled'].includes(result.stopReason)
      )
        throw new Error('The model returned an invalid response.');
      if (result.stopReason !== 'cancelled' && result.text.trim().length === 0) {
        throw new Error('The model finished without a reply. Please try again.');
      }
      turn.text = result.text;
      turn.stopping = true;
      turn.terminal = {
        status: result.stopReason === 'cancelled' ? 'interrupted' : 'complete',
        stopReason: result.stopReason,
      };
      await this.finish(turn);
    } catch (error) {
      this.markReleased(turn);
      if (this.active !== turn) return;
      // A failed save already preserves the exact terminal response for retrySave.
      if (turn.terminal && this.persistenceError) return;
      turn.stopping = true;
      turn.terminal ??= { status: 'error', error: messageFor(error) };
      await this.finish(turn).catch(() => {});
    }
  }

  private markReleased(turn: ActiveTurn): void {
    turn.released = true;
    if (this.active === turn) this.cancellationError = null;
  }

  private async stop(turn: ActiveTurn): Promise<MobileSnapshot> {
    if (!turn.started) this.markReleased(turn);
    if (!turn.released) {
      try {
        await this.options.inference.cancel(turn.requestId);
        this.markReleased(turn);
      } catch (error) {
        if (!turn.released && this.active === turn) {
          this.cancellationError =
            `The model has not confirmed it stopped. Retry stopping it: ${messageFor(error)}`.slice(
              0,
              1_000,
            );
          this.publish();
          throw new Error(this.cancellationError);
        }
      }
    }
    return this.finish(turn);
  }

  async cancel(): Promise<MobileSnapshot> {
    const turn = await this.enqueue(async () => {
      await this.ready();
      if (this.active) {
        this.active.stopping = true;
        this.active.terminal ??= { status: 'interrupted', stopReason: 'cancelled' };
      }
      return this.active;
    });
    if (!turn) return this.current();
    return this.stop(turn);
  }

  async retrySave(): Promise<MobileSnapshot> {
    const turn = await this.enqueue(async () => {
      await this.ready();
      if (this.active) return this.active;
      // Failed idle mutations were never applied. Re-save the durable state to confirm
      // storage recovery; the caller can safely retry its original action or draft.
      await this.commit(copyState(this.state!));
      this.publish();
      return undefined;
    });
    if (!turn) return this.current();
    if (!turn.released || !turn.terminal)
      throw new Error('Stop the model before retrying the save.');
    return this.finish(turn);
  }
}

export function createMobileClient(options: MobileRuntimeOptions): MobileClient {
  return new ForegroundMobileClient(options);
}
