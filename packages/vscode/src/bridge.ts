/**
 * Strongly-typed postMessage protocol between the VSCode extension host
 * and the chat webview. The webview is a sandboxed browser context — it
 * cannot directly trust the daemon's per-launch self-signed cert (no
 * `session.setCertificateVerifyProc` equivalent), but the extension
 * host owns a TLS-trusting `fetch` via undici. So the webview routes
 * EVERY daemon call through `fetch-request` and the host proxies on its
 * behalf. This same channel carries the long-lived SSE streams that
 * drive ChatTimelineView — chunked `fetch-response-chunk` messages
 * reconstruct a `Response.body` ReadableStream on the webview side.
 *
 * Project / gezel / connection state flows through the dedicated
 * connection-*, project-changed, and gezel-changed messages; editor
 * actions (open-external, open-file, reveal-in-explorer) go the other
 * way.
 */

export interface ConnectionReady {
  type: 'connection-ready';
  baseUrl: string;
  projectId: string | null;
  gezelId: string | null;
  workingDir: string | null;
  /** How the host got the daemon. Surface in error UIs only. */
  mode: 'configured' | 'legacy-full' | 'adopted' | 'spawned';
}

export interface ProjectChanged {
  type: 'project-changed';
  projectId: string | null;
  workingDir: string | null;
}

export interface GezelChanged {
  type: 'gezel-changed';
  gezelId: string;
  gezelName: string;
}

export interface ConnectionError {
  type: 'connection-error';
  message: string;
  retryable: boolean;
}

export interface HostLog {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * `fetch-response-start` — host has begun streaming a response to the
 * webview's `fetch-request`. Carries status + headers; the body follows
 * as a sequence of `fetch-response-chunk` messages terminated by
 * `fetch-response-end`. `id` matches the request.
 */
export interface FetchResponseStart {
  type: 'fetch-response-start';
  id: string;
  status: number;
  statusText: string;
  /** Lowercase header names per HTTP/2 convention; values are joined. */
  headers: Record<string, string>;
}

/**
 * `fetch-response-chunk` — a slice of the response body. `bytes` is
 * the byte sequence as a regular number[] so it survives structured
 * clone across the postMessage boundary (VS Code webview doesn't
 * transfer ArrayBuffers zero-copy; we serialize either way). Chunks
 * arrive in order; the webview reassembles them into the Response
 * body's ReadableStream.
 */
export interface FetchResponseChunk {
  type: 'fetch-response-chunk';
  id: string;
  bytes: number[];
}

/**
 * `fetch-response-end` — terminator. `error` non-null when the host
 * couldn't reach the daemon or the stream broke mid-flight; the
 * webview surfaces it as a `fetch` rejection / readable-stream error.
 */
export interface FetchResponseEnd {
  type: 'fetch-response-end';
  id: string;
  error: string | null;
}

export type HostMessage =
  | ConnectionReady
  | ProjectChanged
  | GezelChanged
  | ConnectionError
  | HostLog
  | FetchResponseStart
  | FetchResponseChunk
  | FetchResponseEnd;

export interface WebviewReady {
  type: 'webview-ready';
}

export interface RequestSwitchGezel {
  type: 'request-switch-gezel';
}

export interface RequestSwitchFolder {
  type: 'request-switch-folder';
}

export interface OpenExternal {
  type: 'open-external';
  url: string;
}

export interface OpenFile {
  type: 'open-file';
  path: string;
  line?: number;
}

export interface RevealInExplorer {
  type: 'reveal-in-explorer';
  path: string;
}

export interface WebviewLog {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * `fetch-request` — proxy fetch on the webview's behalf. `url` may be
 * relative (the api singleton sees an empty `baseUrl` at module init
 * because connection-ready hasn't fired yet — see
 * packages/ui/src/embedded/webview-main.tsx); the host normalizes
 * against `connection.baseUrl`. The host ALSO overrides the
 * Authorization header with `Bearer ${connection.token}`. The real token
 * never crosses into the webview. Streaming responses
 * (SSE) work via the same `fetch-response-*` flow; the body chunks
 * just keep arriving until the webview aborts via `fetch-abort` or
 * the upstream closes.
 */
export interface WebviewFetchRequest {
  type: 'fetch-request';
  id: string;
  url: string;
  method: string;
  /** Lowercase header names; values are single strings (no multi). */
  headers: Record<string, string>;
  /** UTF-8 body for JSON / text. Binary bodies aren't supported yet — flag site if needed. */
  body: string | null;
}

export interface WebviewFetchAbort {
  type: 'fetch-abort';
  id: string;
}

export type WebviewMessage =
  | WebviewReady
  | RequestSwitchGezel
  | RequestSwitchFolder
  | OpenExternal
  | OpenFile
  | RevealInExplorer
  | WebviewLog
  | WebviewFetchRequest
  | WebviewFetchAbort;

/**
 * Validate an unknown message coming off `webview.onDidReceiveMessage`.
 * Returns the typed message if valid, or null. We don't throw because a
 * malformed message shouldn't take down the host — log and ignore.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return null;
  switch (msg.type) {
    case 'webview-ready':
      return { type: 'webview-ready' };
    case 'request-switch-gezel':
      return { type: 'request-switch-gezel' };
    case 'request-switch-folder':
      return { type: 'request-switch-folder' };
    case 'open-external':
      if (typeof msg.url !== 'string') return null;
      return { type: 'open-external', url: msg.url };
    case 'open-file':
      if (typeof msg.path !== 'string') return null;
      return {
        type: 'open-file',
        path: msg.path,
        line: typeof msg.line === 'number' ? msg.line : undefined,
      };
    case 'reveal-in-explorer':
      if (typeof msg.path !== 'string') return null;
      return { type: 'reveal-in-explorer', path: msg.path };
    case 'log':
      if (
        (msg.level === 'info' || msg.level === 'warn' || msg.level === 'error') &&
        typeof msg.message === 'string'
      ) {
        return { type: 'log', level: msg.level, message: msg.message };
      }
      return null;
    case 'fetch-request':
      if (
        typeof msg.id === 'string' &&
        typeof msg.url === 'string' &&
        typeof msg.method === 'string' &&
        msg.headers !== null &&
        typeof msg.headers === 'object' &&
        (msg.body === null || typeof msg.body === 'string')
      ) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(msg.headers as Record<string, unknown>)) {
          if (typeof v === 'string') headers[k.toLowerCase()] = v;
        }
        return {
          type: 'fetch-request',
          id: msg.id,
          url: msg.url,
          method: msg.method,
          headers,
          body: (msg.body as string | null) ?? null,
        };
      }
      return null;
    case 'fetch-abort':
      if (typeof msg.id === 'string') return { type: 'fetch-abort', id: msg.id };
      return null;
    default:
      return null;
  }
}
