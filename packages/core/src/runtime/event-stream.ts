import type { ChatEventBus } from './chat-events.js';
import { encodeText } from './files.js';

/** The `/events/chat*` server-sent event streams, one event-bus subscription per request. */
export function portableEventStream(
  eventBus: ChatEventBus,
  url: URL,
  signal: AbortSignal,
): Response {
  let stop = (_close = true) => {};
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      let closed = false;
      const send = (value: string) => {
        if (!closed) controller.enqueue(encodeText(value));
      };
      const sendEvent = (event: unknown) => send(`data: ${JSON.stringify(event)}\n\n`);
      const unsubscribe =
        url.pathname === '/events/chat'
          ? eventBus.subscribe(url.searchParams.get('session') ?? '', sendEvent)
          : url.pathname === '/events/chat/project'
            ? eventBus.subscribeProject(url.searchParams.get('project') ?? '', sendEvent)
            : url.pathname === '/events/chat/gezel'
              ? eventBus.subscribeGezel(url.searchParams.get('gezel') ?? '', sendEvent)
              : eventBus.subscribeAll(sendEvent);
      const ping = setInterval(() => send(': heartbeat\n\n'), 2000);
      const abort = () => stop();
      stop = (close = true) => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        signal.removeEventListener('abort', abort);
        if (close) controller.close();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) stop();
      else send(': connected\n\n');
    },
    cancel: () => stop(false),
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}
