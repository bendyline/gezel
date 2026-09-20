import type { MobileProvider, MobileSnapshot } from '@bendyline/gezel/schemas';
import { createMobileClient } from './runtime/index.js';
import type { ClientCommand, FromWorker, HostCommand, ToWorker } from './worker-protocol.js';

const scope = globalThis as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};
let nextId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const streams = new Map<string, (event: { requestId: string; delta: string }) => void>();

function hostCall<T>(command: HostCommand): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    scope.postMessage({ kind: 'hostRequest', id, command });
  });
}

const client = createMobileClient({
  storage: {
    load: () => hostCall<string | null>({ method: 'load' }),
    save: (data) => hostCall<void>({ method: 'save', data }),
  },
  inference: {
    providers: () => hostCall<MobileProvider[]>({ method: 'providers' }),
    async generate(request, onDelta) {
      streams.set(request.requestId, onDelta);
      try {
        return await hostCall<{ text: string; stopReason: 'stop' | 'length' | 'cancelled' }>({
          method: 'generate',
          request,
        });
      } finally {
        streams.delete(request.requestId);
      }
    },
    cancel: (requestId) => hostCall<void>({ method: 'cancel', requestId }),
  },
  createId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
});
client.subscribe((snapshot) => scope.postMessage({ kind: 'snapshot', snapshot }));

function dispatch(command: ClientCommand): Promise<MobileSnapshot | MobileProvider[]> {
  switch (command.method) {
    case 'send':
      return client.send(command.text);
    case 'setProvider':
      return client.setProvider(command.providerId);
    case 'selectConversation':
      return client.selectConversation(command.sessionId);
    case 'deleteConversation':
      return client.deleteConversation(command.sessionId);
    case 'renameConversation':
      return client.renameConversation(command.sessionId, command.title);
    default:
      return client[command.method]();
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.kind === 'hostReply') {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error !== undefined) call.reject(new Error(message.error));
    else call.resolve(message.value);
  } else if (message.kind === 'delta') {
    streams.get(message.requestId)?.(message);
  } else {
    void dispatch(message.command).then(
      (value) => scope.postMessage({ kind: 'reply', id: message.id, value }),
      (error: unknown) =>
        scope.postMessage({
          kind: 'reply',
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }
};
