import type { WebviewFetchAbort, WebviewFetchRequest } from './bridge.js';
import type { ChatViewProvider } from './chat-view.js';
import type { Connection } from './daemon.js';
import type { Logger } from './log.js';

/**
 * Host-side fetch RPC. The webview can't trust the daemon's
 * self-signed cert (no `setCertificateVerifyProc` hook), so every
 * daemon call from the chat bundle round-trips through here. We:
 *
 *   1. Normalize the (possibly relative) URL against `connection.baseUrl`.
 *      The api singleton in packages/ui sees an empty baseUrl at module
 *      init — by design, see webview-main.tsx — so requests look like
 *      `/api/projects/...` rather than absolute URLs.
 *   2. Override the Authorization header with `Bearer ${connection.token}`.
 *      The client-side header is built with an empty token (same reason
 *      as baseUrl) and would be rejected by the daemon as-is.
 *   3. Call `connection.fetch` — the TLS-trusting undici instance built
 *      at daemon.ts:90.
 *   4. Pump the response body back as `fetch-response-chunk` messages so
 *      SSE streams flow through the same channel as one-shot JSON.
 *
 * Per-request `AbortController` is tracked by id; `fetch-abort` from
 * the webview tears the upstream down (and the `connection.fetch`
 * call rejects with AbortError, which we forward as the error in
 * `fetch-response-end`).
 */
export class WebviewRpc {
  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly view: ChatViewProvider,
    private readonly getConnection: () => Connection | null,
    private readonly logger: Logger,
  ) {}

  async handleRequest(msg: WebviewFetchRequest): Promise<void> {
    const conn = this.getConnection();
    if (!conn) {
      this.view.post({
        type: 'fetch-response-start',
        id: msg.id,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'content-type': 'text/plain' },
      });
      this.view.post({
        type: 'fetch-response-end',
        id: msg.id,
        error: 'gezel daemon not connected',
      });
      return;
    }

    const ctrl = new AbortController();
    this.inFlight.set(msg.id, ctrl);

    try {
      const absoluteUrl = this.resolveUrl(msg.url, conn.baseUrl);
      const headers: Record<string, string> = { ...msg.headers };
      headers.authorization = `Bearer ${conn.token}`;

      const res = await conn.fetch(absoluteUrl, {
        method: msg.method,
        headers,
        body: msg.body ?? undefined,
        signal: ctrl.signal,
        // Never let a daemon response forward its bearer credential to a
        // second origin. API callers can handle an explicit 3xx response.
        redirect: 'manual',
      });

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        responseHeaders[k.toLowerCase()] = v;
      });

      this.view.post({
        type: 'fetch-response-start',
        id: msg.id,
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });

      if (!res.body) {
        this.view.post({ type: 'fetch-response-end', id: msg.id, error: null });
        return;
      }

      const reader = res.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            // Number[] survives structured clone across the VS Code
            // webview boundary. Typed-array transferable wouldn't help
            // here — the webview API serializes either way — so we
            // stick with a portable representation.
            this.view.post({
              type: 'fetch-response-chunk',
              id: msg.id,
              bytes: Array.from(value),
            });
          }
        }
        this.view.post({ type: 'fetch-response-end', id: msg.id, error: null });
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (ctrl.signal.aborted) {
        // Caller-initiated abort. End the stream silently so the
        // webview's AbortController.abort() doesn't surface a
        // confusing error in the timeline.
        this.view.post({ type: 'fetch-response-end', id: msg.id, error: 'AbortError' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`webview fetch ${msg.id} (${msg.method} ${msg.url}) failed: ${message}`);
        // If no start was emitted yet (network refused, TLS handshake
        // failed) the webview still needs *something* to resolve the
        // pending Promise. Emit a synthetic 502.
        this.view.post({
          type: 'fetch-response-start',
          id: msg.id,
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/plain' },
        });
        this.view.post({ type: 'fetch-response-end', id: msg.id, error: message });
      }
    } finally {
      this.inFlight.delete(msg.id);
    }
  }

  handleAbort(msg: WebviewFetchAbort): void {
    const ctrl = this.inFlight.get(msg.id);
    if (ctrl) ctrl.abort();
  }

  /**
   * Resolve the webview's URL against the connection's base. The
   * webview ships either:
   *   - a relative path (`/api/projects/...`) — normalize against base
   *   - an absolute URL pointing at the daemon — accept only when its
   *     origin exactly matches the active daemon (the
   *     desktop SPA does this when `window.location.origin` is the
   *     daemon, but the embedded bundle never produces this shape)
   *
   * Anything else (cross-origin URLs, file:, javascript:) is rejected here
   * before the host attaches its bearer credential.
   */
  private resolveUrl(input: string, base: string): string {
    const baseUrl = new URL(base);
    const target = /^https?:\/\//i.test(input)
      ? new URL(input)
      : new URL(input.startsWith('/') ? input : `/${input}`, baseUrl);
    if (target.origin !== baseUrl.origin || target.username || target.password) {
      throw new Error('webview fetch rejected a cross-origin daemon request');
    }
    return target.toString();
  }
}
