import type { SSEStreamingApi } from 'hono/streaming';
import type {
  ChatInstallEventBase,
  ChatModelInstallRegistry,
} from '../../models/install-registry.js';

/**
 * Subscribe to a chat-model install registry for `id` and stream its events
 * as SSE. Shared by the llama-cpp / ds4 / mlx install routes. Unsubscribes on
 * client disconnect WITHOUT cancelling the install — that's the whole point
 * of the registry design; cancel is the explicit `DELETE` route. The stream
 * terminates after the terminal event so the client loop exits cleanly.
 */
export async function subscribeToInstallSse<E extends ChatInstallEventBase, O>(
  registry: ChatModelInstallRegistry<E, O>,
  id: string,
  stream: SSEStreamingApi,
): Promise<void> {
  let done = false;
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const unsubscribe = registry.subscribe(id, (event) => {
    if (done) return;
    // A failed write means the socket is gone, which onAbort will also
    // fire — no need to surface it here.
    const write = stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    if (event.type === 'done' || event.type === 'error') {
      done = true;
      // Flush the terminal frame before resolving — resolving lets the
      // handler return and Hono close the response; without the await the
      // terminal bytes can be dropped and the UI's progress bar sticks.
      void write.then(() => resolve());
    }
  });
  if (!unsubscribe) {
    // Install vanished between start and subscribe (finished-entry GC won
    // the race) — treat as a clean terminal so the client moves on.
    return;
  }
  stream.onAbort(() => {
    if (done) return;
    done = true;
    resolve();
  });
  await promise;
  unsubscribe();
}
