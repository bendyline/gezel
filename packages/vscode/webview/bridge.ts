/**
 * Webview-side bridge. Runs inside the VS Code webview's sandboxed
 * page BEFORE the chat React bundle (`chat.global.js`) loads. Two
 * responsibilities:
 *
 *   1. Install a postMessage-RPC `fetch` impl on `window.__GEZEL__.fetch`
 *      so the gezel `GezelClient` (constructed when the bundle imports
 *      `api.ts`) routes every daemon call through the extension host.
 *      The webview can't accept the daemon's per-launch self-signed
 *      cert directly; the extension host owns a TLS-trusting undici
 *      via `connection.fetch`. See packages/vscode/src/webview-rpc.ts.
 *
 *   2. Translate connection-state messages from the host into a
 *      `gezel:boot` event the React bundle awaits before rendering
 *      EmbeddedChat. The bundle reads `window.__GEZEL__.projectId` /
 *      `.gezelId` synchronously when the event fires.
 *
 * Editor-action commands (open-file, reveal-in-explorer, open-external)
 * stay on this bridge — they're host-side concerns and don't belong in
 * the React tree.
 */

// Make this file a module so the `declare global` augmentation
// below is allowed. The IIFE bundle this compiles into runs in the
// webview's global scope — no actual export reaches the runtime.
export {};

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};

interface ConnectionReady {
  type: 'connection-ready';
  baseUrl: string;
  projectId: string | null;
  gezelId: string | null;
  workingDir: string | null;
  mode: string;
}

interface ConnectionError {
  type: 'connection-error';
  message: string;
  retryable: boolean;
}

interface ProjectChanged {
  type: 'project-changed';
  projectId: string | null;
  workingDir: string | null;
}

interface GezelChanged {
  type: 'gezel-changed';
  gezelId: string;
  gezelName: string;
}

interface FetchResponseStart {
  type: 'fetch-response-start';
  id: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

interface FetchResponseChunk {
  type: 'fetch-response-chunk';
  id: string;
  bytes: number[];
}

interface FetchResponseEnd {
  type: 'fetch-response-end';
  id: string;
  error: string | null;
}

type HostMessage =
  | ConnectionReady
  | ConnectionError
  | ProjectChanged
  | GezelChanged
  | FetchResponseStart
  | FetchResponseChunk
  | FetchResponseEnd;

interface InFlight {
  /** Resolver for the head Response Promise. */
  resolveResponse: (res: Response) => void;
  rejectResponse: (err: Error) => void;
  /**
   * Controller for the response body's ReadableStream. Chunks arrive
   * after `fetch-response-start` and are enqueued; `fetch-response-end`
   * closes (or errors) the controller.
   */
  bodyController: ReadableStreamDefaultController<Uint8Array> | null;
  /**
   * AbortController bound to the caller's signal. Tearing this down
   * fires `fetch-abort` to the host.
   */
  signal: AbortSignal | null;
  /** Listener registered on `signal` — removed when the request settles. */
  signalListener: (() => void) | null;
}

const vscodeApi = acquireVsCodeApi();
const inFlight = new Map<string, InFlight>();
let nextRequestId = 0;
let latestConnection: ConnectionReady | null = null;

declare global {
  interface Window {
    __GEZEL__?: {
      token: string;
      baseUrl: string;
      fetch: typeof fetch;
      projectId?: string;
      gezelId?: string;
      mode?: string;
      openWorkspaceFile?: (path: string, line?: number) => void;
    };
  }
}

// Synchronously expose the contract so api.ts in the chat bundle
// picks up `fetch` at module init. The token intentionally remains an empty
// placeholder: the host owns and injects the real credential. Only baseUrl
// and project/gezel state are populated on `connection-ready`.
window.__GEZEL__ = {
  token: '',
  baseUrl: '',
  fetch: webviewFetch,
  openWorkspaceFile: (path, line) => {
    vscodeApi.postMessage({
      type: 'open-file',
      path,
      ...(line !== undefined ? { line } : {}),
    });
  },
};

window.addEventListener('message', (event) => {
  const msg = event.data as HostMessage | undefined;
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'connection-ready':
      latestConnection = msg;
      applyConnection(msg);
      break;
    case 'connection-error':
      // Failure surfaces inside the React tree (`<EmbeddedChat>`'s
      // useEffect throws on api.getProject failure). We don't need a
      // bridge-level status UI; just log it for diagnostics.
      vscodeApi.postMessage({
        type: 'log',
        level: 'warn',
        message: `connection-error: ${msg.message}`,
      });
      break;
    case 'project-changed':
      if (latestConnection) {
        latestConnection = {
          ...latestConnection,
          projectId: msg.projectId,
          workingDir: msg.workingDir,
        };
        applyConnection(latestConnection);
      }
      break;
    case 'gezel-changed':
      if (latestConnection) {
        latestConnection = { ...latestConnection, gezelId: msg.gezelId };
        applyConnection(latestConnection);
      }
      break;
    case 'fetch-response-start':
      handleResponseStart(msg);
      break;
    case 'fetch-response-chunk':
      handleResponseChunk(msg);
      break;
    case 'fetch-response-end':
      handleResponseEnd(msg);
      break;
  }
});

vscodeApi.postMessage({ type: 'webview-ready' });

function applyConnection(msg: ConnectionReady): void {
  const g = window.__GEZEL__;
  if (!g) return;
  g.baseUrl = msg.baseUrl;
  g.projectId = msg.projectId ?? '';
  g.gezelId = msg.gezelId ?? '';
  g.mode = msg.mode;
  // Tell the chat bundle to (re-)mount EmbeddedChat with the new
  // project. The bundle's WebviewChatRoot subscribes to this event
  // and reads the updated __GEZEL__ on each fire.
  window.dispatchEvent(new Event('gezel:boot'));
}

function webviewFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const id = `req-${++nextRequestId}`;
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = flattenHeaders(init?.headers, input);
  const body = serializeBody(init?.body);

  // The body Promise's resolution carries the response head; the body
  // ReadableStream consumes chunks via its controller's enqueue.
  const responsePromise = new Promise<Response>((resolve, reject) => {
    inFlight.set(id, {
      resolveResponse: resolve,
      rejectResponse: reject,
      bodyController: null,
      signal: init?.signal ?? null,
      signalListener: null,
    });
  });

  // Wire signal abort → fetch-abort message.
  if (init?.signal) {
    const slot = inFlight.get(id);
    if (slot) {
      const listener = () => {
        vscodeApi.postMessage({ type: 'fetch-abort', id });
      };
      slot.signalListener = listener;
      // If the signal is already aborted, fire immediately. Don't
      // bother posting fetch-request — host would just receive an
      // orphan abort.
      if (init.signal.aborted) {
        slot.rejectResponse(new DOMException('Aborted', 'AbortError'));
        inFlight.delete(id);
        return responsePromise;
      }
      init.signal.addEventListener('abort', listener);
    }
  }

  vscodeApi.postMessage({
    type: 'fetch-request',
    id,
    url,
    method,
    headers,
    body,
  });

  return responsePromise;
}

function handleResponseStart(msg: FetchResponseStart): void {
  const slot = inFlight.get(msg.id);
  if (!slot) return;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      slot.bodyController = controller;
    },
    cancel() {
      // The Response body consumer cancelled (e.g. ChatTimelineView
      // bailed out of an SSE loop). Mirror the cancellation upstream
      // so the host stops pumping.
      vscodeApi.postMessage({ type: 'fetch-abort', id: msg.id });
    },
  });
  const responseHeaders = new Headers();
  for (const [k, v] of Object.entries(msg.headers)) responseHeaders.set(k, v);
  const response = new Response(stream, {
    status: msg.status,
    statusText: msg.statusText,
    headers: responseHeaders,
  });
  slot.resolveResponse(response);
}

function handleResponseChunk(msg: FetchResponseChunk): void {
  const slot = inFlight.get(msg.id);
  if (!slot?.bodyController) return;
  const u8 = new Uint8Array(msg.bytes);
  try {
    slot.bodyController.enqueue(u8);
  } catch {
    // Stream already closed by a previous cancel/error — drop quietly.
  }
}

function handleResponseEnd(msg: FetchResponseEnd): void {
  const slot = inFlight.get(msg.id);
  if (!slot) return;
  cleanupSignal(slot);
  if (slot.bodyController) {
    try {
      if (msg.error) {
        slot.bodyController.error(new Error(msg.error));
      } else {
        slot.bodyController.close();
      }
    } catch {
      /* already closed */
    }
  } else if (msg.error) {
    // Error before start was emitted — reject the head Promise so
    // the caller's `await fetch(...)` throws instead of hanging.
    slot.rejectResponse(
      msg.error === 'AbortError' ? new DOMException('Aborted', 'AbortError') : new Error(msg.error),
    );
  }
  inFlight.delete(msg.id);
}

function cleanupSignal(slot: InFlight): void {
  if (slot.signal && slot.signalListener) {
    slot.signal.removeEventListener('abort', slot.signalListener);
    slot.signal = null;
    slot.signalListener = null;
  }
}

function flattenHeaders(
  hi: HeadersInit | undefined,
  input: RequestInfo | URL,
): Record<string, string> {
  const out: Record<string, string> = {};
  // If the caller passed a Request object as input, fold its headers
  // in first (RequestInit.headers wins on collision).
  if (typeof input !== 'string' && !(input instanceof URL)) {
    input.headers.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  }
  if (!hi) return out;
  if (hi instanceof Headers) {
    hi.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(hi)) {
    for (const [k, v] of hi) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(hi)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function serializeBody(body: BodyInit | null | undefined): string | null {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  // GezelClient's `request()` only ever serializes JSON bodies, so we
  // don't ship blob/stream support yet. If a caller passes one,
  // surface as a clear error rather than silently truncating.
  throw new Error('webview fetch only supports string bodies (JSON.stringify upstream)');
}
