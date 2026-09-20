import type { MobileProvider, MobileSnapshot } from '@bendyline/gezel/schemas';
import type { MobileHost } from './native.js';
import type { MobileClient } from './runtime/index.js';
import type { ClientCommand, FromWorker, HostCommand, ToWorker } from './worker-protocol.js';

export function createWorkerClient(host: MobileHost): MobileClient & { dispose(): void } {
  const worker = new Worker(new URL('./runtime-worker.ts', import.meta.url), { type: 'module' });
  let nextId = 0;
  let disposed = false;
  const pending = new Map<
    number,
    {
      resolve(value: MobileSnapshot | MobileProvider[]): void;
      reject(error: Error): void;
    }
  >();
  const listeners = new Set<(snapshot: MobileSnapshot) => void>();
  const activeGenerations = new Set<string>();
  const post = (message: ToWorker) => {
    if (!disposed) worker.postMessage(message);
  };
  async function dispatch(command: HostCommand): Promise<unknown> {
    switch (command.method) {
      case 'load':
        return host.storage.load();
      case 'providers':
        return host.inference.providers();
      case 'save':
        return host.storage.save(command.data);
      case 'cancel':
        return host.inference.cancel(command.requestId);
      case 'generate': {
        activeGenerations.add(command.request.requestId);
        try {
          return await host.inference.generate(command.request, (delta) => {
            post({ kind: 'delta', ...delta });
          });
        } finally {
          activeGenerations.delete(command.request.requestId);
        }
      }
    }
  }
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    if (disposed) return;
    const message = event.data;
    if (message.kind === 'hostRequest') {
      void dispatch(message.command).then(
        (value) => post({ kind: 'hostReply', id: message.id, value }),
        (error: unknown) =>
          post({
            kind: 'hostReply',
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    } else if (message.kind === 'snapshot') {
      for (const listener of listeners) {
        try {
          listener(message.snapshot);
        } catch {}
      }
    } else {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error !== undefined) call.reject(new Error(message.error));
      else if (message.value !== undefined) call.resolve(message.value);
      else call.reject(new Error('The mobile runtime returned no state'));
    }
  };
  function dispose(error = new Error('The mobile runtime has closed')) {
    if (disposed) return;
    disposed = true;
    for (const requestId of activeGenerations)
      void host.inference.cancel(requestId).catch(() => {});
    worker.terminate();
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    listeners.clear();
  }
  worker.onerror = () =>
    dispose(new Error('The mobile runtime stopped. Reopen the app to recover the conversation.'));
  function request<T extends MobileSnapshot | MobileProvider[] = MobileSnapshot>(
    command: ClientCommand,
  ): Promise<T> {
    if (disposed) return Promise.reject(new Error('The mobile runtime has closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      post({ kind: 'request', id, command });
    });
  }
  return {
    snapshot: () => request({ method: 'snapshot' }),
    providers: () => request<MobileProvider[]>({ method: 'providers' }),
    setProvider: (providerId) => request({ method: 'setProvider', providerId }),
    newConversation: () => request({ method: 'newConversation' }),
    selectConversation: (sessionId) => request({ method: 'selectConversation', sessionId }),
    renameConversation: (sessionId, title) =>
      request({ method: 'renameConversation', sessionId, title }),
    deleteConversation: (sessionId) => request({ method: 'deleteConversation', sessionId }),
    send: (text) => request({ method: 'send', text }),
    cancel: () => request({ method: 'cancel' }),
    retrySave: () => request({ method: 'retrySave' }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  };
}
