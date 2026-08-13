import type {
  InvokePageToolResponse,
  PageReadRequest,
  PreviewLogEntry,
  ScriptRun,
} from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useEffectiveTheme } from '../theme.js';

export type HtmlPreviewSource = 'artifacts' | 'workspace' | 'type';

/** Debounce window for shipping shim entries to the service. */
const REPORT_FLUSH_MS = 800;
/** Bound on service posts per mounted preview — a console.error loop must not DOS the daemon. */
const REPORT_MAX_FLUSHES = 10;

/** Flatten a shim `detail` payload into the wire entry's one-line message. */
function shimDetailToMessage(entry: HtmlPreviewLogEntry): string {
  const d = entry.detail;
  if (d.args && d.args.length > 0) return d.args.join(' ').slice(0, 2_000);
  const location = d.filename ? ` (${d.filename}:${d.lineno ?? '?'})` : '';
  return `${d.message ?? 'unknown error'}${location}`.slice(0, 2_000);
}

/**
 * One log entry forwarded from a preview page via the injected shim.
 * `kind` tracks how it was captured; `detail` is a best-effort
 * serialization of the source event (error object, rejection reason,
 * or `console.error` args).
 */
export interface HtmlPreviewLogEntry {
  kind: 'error' | 'unhandledrejection' | 'console.error';
  detail: {
    message?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
    stack?: string;
    args?: string[];
  };
  url: string;
  at: number;
}

/**
 * Debug-only detail for a failed script invoked by an interactive type
 * page. The page receives only the short error string; the first-party
 * parent can additionally load the persisted, redacted run record for a
 * useful clipboard report without widening the sandboxed page's access.
 */
export interface PageScriptErrorDetails {
  tool: string;
  response?: InvokePageToolResponse;
  run?: ScriptRun;
  detailLoadError?: string;
  transportError?: string;
}

interface HtmlPreviewFrameProps {
  projectId: string;
  path: string;
  source: HtmlPreviewSource;
  title: string;
  className?: string;
  refreshKey?: number | string;
  /** Latest capability URL, used by first-party "Open in browser" buttons. */
  onUrlReady?: (url: string | null) => void;
  /**
   * Called when the preview page bubbles up a runtime error, an
   * unhandled promise rejection, or a `console.error` call via the
   * preview route's injected log shim. The parent can accumulate and
   * render these to surface "why isn't the game working" to the user
   * without making them open devtools.
   */
  onLog?: (entry: HtmlPreviewLogEntry) => void;
  /**
   * The applied project type's declared page-invokable tool names
   * (`manifest.pages.tools`). When set, the frame relays the page's
   * `__gezelPageInvoke` postMessages to the page-invoke route — the
   * client-side allowlist here is a fast-fail; the route re-derives the
   * same list from the trusted manifest and is the real enforcement.
   * Absent = the bridge is closed (plain workspace/artifact previews).
   */
  pageTools?: string[];
  /**
   * Debug-only observer for page-invoked script failures. When supplied,
   * failed runs are hydrated from the persisted run record before being
   * reported; a later successful invoke clears the current failure.
   */
  onPageScriptError?: (details: PageScriptErrorDetails | null) => void;
  /**
   * Called when the page asks for a reload (`__gezelPageRefresh`) —
   * typically because its preview capability hit the 2 h absolute
   * expiry and polls started failing. The parent bumps `refreshKey`,
   * which re-mints a capability and reloads the frame.
   */
  onRequestRefresh?: () => void;
}

/** Bound on concurrently in-flight page invokes per frame. */
const MAX_INFLIGHT_INVOKES = 4;
/** Bound on concurrently relayed page reads (watch stats ride outside it). */
const MAX_INFLIGHT_READS = 8;
/** Advertised to the page via init.limits; mirrors the page-read route cap. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
/** Centralized watch sweep cadence. Zero registered watches = zero polling. */
const WATCH_INTERVAL_MS = 2_500;

/** Map an HTTP failure to the page-facing typed error code. */
function pageErrorCode(
  status: number | undefined,
): 'not-allowed' | 'invalid-input' | 'rate-limited' | 'unavailable' {
  if (status === 400 || status === 413 || status === 422) return 'invalid-input';
  if (status === 403 || status === 404) return 'not-allowed';
  if (status === 429) return 'rate-limited';
  return 'unavailable';
}

interface PageWatch {
  source: 'workspace' | 'artifacts';
  path: string;
  etag: string | null;
}

type PreviewLoadState =
  | { requestKey: string; status: 'ready'; url: string }
  | { requestKey: string; status: 'error'; error: string };

/**
 * Sandboxed HTML preview. Loads content from the service's unified
 * `/preview/:capability/:source/:projectId/*` mount so relative `<link>` /
 * `<script>` / `<img>` references resolve against sibling files on
 * the same origin. The iframe uses `sandbox="allow-scripts"` *without*
 * `allow-same-origin`, so LLM-authored HTML executes in a null origin —
 * its only channel to the app is `postMessage` (the log shim outbound,
 * and the page-invoke bridge below when `pageTools` is set); the URL
 * contains only a short-lived, project/path-scoped preview capability,
 * never the UI bearer. See
 * [preview.ts](../../../service/src/http/routes/preview.ts) for the
 * full isolation model.
 *
 * When `onLog` is supplied, the component attaches a `message`
 * listener filtered to this iframe's `contentWindow` and the
 * `__gezelPreviewLog` sentinel written by the injected shim — cross-
 * iframe noise can't leak in. Use the ref/source identity check even
 * though the sentinel is already distinctive; belt-and-suspenders.
 */
export function HtmlPreviewFrame({
  projectId,
  path,
  source,
  title,
  className,
  refreshKey,
  onLog,
  onUrlReady,
  pageTools,
  onPageScriptError,
  onRequestRefresh,
}: HtmlPreviewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const inflightInvokes = useRef<Set<string>>(new Set());
  const inflightReads = useRef<Set<string>>(new Set());
  const watches = useRef<Map<string, PageWatch>>(new Map());
  const theme = useEffectiveTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [securityPolicyRevision, setSecurityPolicyRevision] = useState(0);
  const requestKey = JSON.stringify([
    projectId,
    path,
    source,
    refreshKey ?? null,
    securityPolicyRevision,
  ]);
  const [loadState, setLoadState] = useState<PreviewLoadState | null>(null);
  // Effects run after React commits. Keying the resolved lease to the props
  // that requested it prevents that commit from briefly remounting the old,
  // still-interactive page while a refresh or target change is being minted.
  const activeLoadState = loadState?.requestKey === requestKey ? loadState : null;
  const src = activeLoadState?.status === 'ready' ? activeLoadState.url : null;
  const loadError = activeLoadState?.status === 'error' ? activeLoadState.error : null;

  useEffect(() => {
    // CSP is fixed when the document loads. Re-mint and remount whenever the
    // centralized security policy changes so enabling External services makes
    // remote dependencies available, and disabling it immediately discards a
    // previously permissive document.
    const onConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ securityPolicy?: unknown }>).detail;
      if (!detail || !Object.prototype.hasOwnProperty.call(detail, 'securityPolicy')) return;
      setSecurityPolicyRevision((revision) => revision + 1);
    };
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    return () => window.removeEventListener('gezel:config-updated', onConfigUpdated);
  }, []);

  useEffect(() => {
    let cancelled = false;
    onUrlReady?.(null);
    const request =
      source === 'workspace'
        ? api.createProjectWorkspacePreviewUrl(projectId, path)
        : source === 'type'
          ? api.createProjectTypePreviewUrl(projectId, path)
          : api.createProjectPreviewUrl(projectId, path);
    void request
      .then((lease) => {
        if (cancelled) return;
        // The in-app iframe stays on the same-origin HTTPS URL — a plain-HTTP
        // src would be blocked as mixed content. `onUrlReady` (external-browser
        // "open in browser") prefers the plain-HTTP URL when the daemon offers
        // one, so the system browser doesn't hit the self-signed-cert warning.
        setLoadState({ requestKey, status: 'ready', url: lease.url });
        onUrlReady?.(lease.browserUrl ?? lease.url);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState({
          requestKey,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, source, requestKey, onUrlReady]);

  useEffect(() => {
    // Loopback batcher: every captured entry is also reported to the
    // service (debounced), where it lands in the project's PreviewLogBuffer
    // and reaches the responsible gezel as a next-turn prelude — "the page
    // you shipped is throwing X". Runs regardless of `onLog`; the drawer
    // and the loopback are independent consumers. Best-effort: a failed
    // POST is dropped, never retried, never surfaced.
    const pending: PreviewLogEntry[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushes = 0;
    let disposed = false;
    let latestPageInvokeOutcome = 0;
    const flush = () => {
      flushTimer = null;
      if (pending.length === 0 || flushes >= REPORT_MAX_FLUSHES) return;
      flushes += 1;
      const batch = pending.splice(0, 20);
      void api.reportProjectPreviewLog(projectId, batch).catch(() => {});
    };
    const report = (entry: HtmlPreviewLogEntry) => {
      if (flushes >= REPORT_MAX_FLUSHES || pending.length >= 20) return;
      pending.push({
        kind: entry.kind,
        message: shimDetailToMessage(entry),
        path,
        source,
        at: new Date(entry.at).toISOString(),
      });
      if (!flushTimer) flushTimer = setTimeout(flush, REPORT_FLUSH_MS);
    };

    // ── Output Pane API v1 relay ─────────────────────────────────────────
    // The versioned envelope handled here coexists forever with the legacy
    // sentinels below: shipped catalog pages hard-code v0, the injected
    // window.gezel shim speaks v1. Both share the same identity check.
    const postToFrame = (payload: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage({ __gezelPage: 1, ...payload }, '*');
    };
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let sweeping = false;
    const sweepWatches = async () => {
      if (sweeping || disposed || watches.current.size === 0) return;
      sweeping = true;
      try {
        await Promise.all(
          [...watches.current.entries()].map(async ([id, w]) => {
            try {
              const res = await api.invokeProjectPageRead(projectId, {
                op: 'stat',
                source: w.source,
                path: w.path,
              });
              if (disposed || !watches.current.has(id)) return;
              if (w.etag !== null && res.etag !== w.etag) {
                postToFrame({ kind: 'change', watchId: id, path: w.path, etag: res.etag });
              }
              w.etag = res.etag;
            } catch {
              // Transient stat failures never kill a watch; the next sweep retries.
            }
          }),
        );
      } finally {
        sweeping = false;
      }
    };
    const ensurePolling = () => {
      if (pollTimer || watches.current.size === 0) return;
      pollTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden') void sweepWatches();
      }, WATCH_INTERVAL_MS);
    };
    const stopPollingIfIdle = () => {
      if (pollTimer && watches.current.size === 0) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const relayV1Invoke = (id: string, tool: string, input?: Record<string, unknown>) => {
      if (!pageTools || !pageTools.includes(tool)) {
        postToFrame({
          kind: 'result',
          id,
          ok: false,
          error: `tool '${tool}' is not page-invokable`,
          errorCode: 'not-allowed',
        });
        return;
      }
      if (inflightInvokes.current.size >= MAX_INFLIGHT_INVOKES) {
        postToFrame({
          kind: 'result',
          id,
          ok: false,
          error: 'too many concurrent invokes',
          errorCode: 'rate-limited',
        });
        return;
      }
      inflightInvokes.current.add(id);
      void api
        .invokeProjectPageTool(projectId, { tool, ...(input ? { input } : {}) })
        .then((res) => {
          const outcome = ++latestPageInvokeOutcome;
          postToFrame({
            kind: 'result',
            id,
            ok: res.status === 'ok',
            output: res.output,
            runId: res.runId,
            ...(res.error ? { error: res.error, errorCode: 'script-error' } : {}),
            ...(res.reaction ? { reaction: res.reaction } : {}),
          });
          if (res.status === 'ok') {
            if (!disposed) onPageScriptError?.(null);
            // Read-your-write: a user action usually mutates a watched file;
            // sweep immediately so the repaint lands in ~200ms, not a poll
            // interval later.
            void sweepWatches();
          } else if (onPageScriptError) {
            void api
              .getProjectScriptRun(projectId, res.runId)
              .then((run) => {
                if (!disposed && outcome === latestPageInvokeOutcome) {
                  onPageScriptError({ tool, response: res, run });
                }
              })
              .catch((err) => {
                if (disposed || outcome !== latestPageInvokeOutcome) return;
                onPageScriptError({
                  tool,
                  response: res,
                  detailLoadError: err instanceof Error ? err.message : String(err),
                });
              });
          }
        })
        .catch((err) => {
          ++latestPageInvokeOutcome;
          const status = (err as { status?: number }).status;
          const message = err instanceof Error ? err.message : String(err);
          postToFrame({
            kind: 'result',
            id,
            ok: false,
            error: message,
            errorCode: pageErrorCode(status),
          });
          if (!disposed) onPageScriptError?.({ tool, transportError: message });
        })
        .finally(() => {
          inflightInvokes.current.delete(id);
        });
    };
    const relayV1Read = (msg: {
      id: string;
      op: 'read' | 'list' | 'stat';
      source: 'workspace' | 'artifacts';
      path: string;
      as?: unknown;
      maxBytes?: unknown;
    }) => {
      if (inflightReads.current.size >= MAX_INFLIGHT_READS) {
        postToFrame({
          kind: 'read-result',
          id: msg.id,
          ok: false,
          error: 'too many concurrent reads',
          errorCode: 'rate-limited',
        });
        return;
      }
      const body: PageReadRequest = {
        op: msg.op,
        source: msg.source,
        path: msg.path,
        ...(msg.as === 'bytes' ? { as: 'bytes' as const } : {}),
        ...(typeof msg.maxBytes === 'number' ? { maxBytes: msg.maxBytes } : {}),
      };
      inflightReads.current.add(msg.id);
      void api
        .invokeProjectPageRead(projectId, body)
        .then((res) => {
          postToFrame({ kind: 'read-result', id: msg.id, ok: true, ...res });
        })
        .catch((err) => {
          const status = (err as { status?: number }).status;
          postToFrame({
            kind: 'read-result',
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            errorCode: pageErrorCode(status),
          });
        })
        .finally(() => {
          inflightReads.current.delete(msg.id);
        });
    };

    function handleV1Message(raw: Record<string, unknown>): void {
      const kind = raw.kind;
      if (kind === 'hello') {
        postToFrame({
          kind: 'init',
          api: 1,
          theme: { mode: themeRef.current },
          limits: { maxInflight: MAX_INFLIGHT_INVOKES, maxReadBytes: MAX_READ_BYTES },
        });
        return;
      }
      if (kind === 'refresh') {
        onRequestRefresh?.();
        return;
      }
      const id = raw.id;
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) return;
      if (kind === 'invoke') {
        if (typeof raw.tool !== 'string') return;
        const input =
          raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)
            ? (raw.input as Record<string, unknown>)
            : undefined;
        relayV1Invoke(id, raw.tool, input);
        return;
      }
      if (kind === 'read') {
        const op = raw.op;
        const src = raw.source;
        if (op !== 'read' && op !== 'list' && op !== 'stat') return;
        if (src !== 'workspace' && src !== 'artifacts') return;
        if (typeof raw.path !== 'string' || raw.path.length === 0) return;
        relayV1Read({ id, op, source: src, path: raw.path, as: raw.as, maxBytes: raw.maxBytes });
        return;
      }
      if (kind === 'watch') {
        const src = raw.source;
        if (src !== 'workspace' && src !== 'artifacts') return;
        if (typeof raw.path !== 'string' || raw.path.length === 0) return;
        watches.current.set(id, { source: src, path: raw.path, etag: null });
        ensurePolling();
        // Seed the etag right away so the first real change notifies fast.
        void sweepWatches();
        return;
      }
      if (kind === 'unwatch') {
        watches.current.delete(id);
        stopPollingIfIdle();
      }
    }

    function handleMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as Partial<HtmlPreviewLogEntry> & {
        __gezelPreviewLog?: boolean;
        __gezelPageInvoke?: boolean;
        __gezelPageRefresh?: boolean;
        __gezelPage?: unknown;
        id?: unknown;
        tool?: unknown;
        input?: unknown;
      };
      if (!data) return;

      if (data.__gezelPage === 1 && typeof (data as { kind?: unknown }).kind === 'string') {
        handleV1Message(data as unknown as Record<string, unknown>);
        return;
      }

      if (data.__gezelPageRefresh === true) {
        onRequestRefresh?.();
        return;
      }

      if (data.__gezelPageInvoke === true) {
        // targetOrigin must be '*': the sandboxed frame has a null origin
        // (same reason the injected log shim posts with '*').
        const postResult = (payload: Record<string, unknown>) => {
          frame.contentWindow?.postMessage({ __gezelPageResult: true, ...payload }, '*');
        };
        if (typeof data.id !== 'string' || typeof data.tool !== 'string') return;
        const id = data.id;
        const tool = data.tool;
        if (!pageTools || !pageTools.includes(tool)) {
          postResult({ id, ok: false, error: `tool '${tool}' is not page-invokable` });
          return;
        }
        if (inflightInvokes.current.size >= MAX_INFLIGHT_INVOKES) {
          postResult({ id, ok: false, error: 'too many concurrent invokes' });
          return;
        }
        const input =
          data.input && typeof data.input === 'object' && !Array.isArray(data.input)
            ? (data.input as Record<string, unknown>)
            : undefined;
        inflightInvokes.current.add(id);
        void api
          .invokeProjectPageTool(projectId, { tool, ...(input ? { input } : {}) })
          .then((res) => {
            const outcome = ++latestPageInvokeOutcome;
            postResult({
              id,
              ok: res.status === 'ok',
              output: res.output,
              ...(res.error ? { error: res.error } : {}),
              ...(res.reaction ? { reaction: res.reaction } : {}),
            });
            if (res.status === 'ok') {
              if (!disposed) onPageScriptError?.(null);
            } else if (onPageScriptError) {
              // The page-facing response intentionally stays small. Debug
              // mode asks for the persisted run separately so the copy
              // action includes logs + the full SDK call trace. ScriptRun
              // has already passed the runner's secret-redaction step.
              void api
                .getProjectScriptRun(projectId, res.runId)
                .then((run) => {
                  if (!disposed && outcome === latestPageInvokeOutcome) {
                    onPageScriptError({ tool, response: res, run });
                  }
                })
                .catch((err) => {
                  if (disposed || outcome !== latestPageInvokeOutcome) return;
                  onPageScriptError({
                    tool,
                    response: res,
                    detailLoadError: err instanceof Error ? err.message : String(err),
                  });
                });
            }
          })
          .catch((err) => {
            ++latestPageInvokeOutcome;
            const message = err instanceof Error ? err.message : String(err);
            postResult({ id, ok: false, error: message });
            if (!disposed) onPageScriptError?.({ tool, transportError: message });
          })
          .finally(() => {
            inflightInvokes.current.delete(id);
          });
        return;
      }

      if (data.__gezelPreviewLog !== true) return;
      if (!data.kind || !data.detail || !data.url || typeof data.at !== 'number') return;
      const entry: HtmlPreviewLogEntry = {
        kind: data.kind,
        detail: data.detail,
        url: data.url,
        at: data.at,
      };
      report(entry);
      onLog?.(entry);
    }
    window.addEventListener('message', handleMessage);
    return () => {
      disposed = true;
      window.removeEventListener('message', handleMessage);
      if (flushTimer) clearTimeout(flushTimer);
      if (pollTimer) clearInterval(pollTimer);
      // A remounted/renavigated page must re-register its watches — stale
      // entries would poll paths the new document never asked for.
      watches.current.clear();
      flush();
    };
  }, [onLog, projectId, path, source, pageTools, onPageScriptError, onRequestRefresh]);

  useEffect(() => {
    // Live theme push (v1 pages). Pages get the mount-time theme via their
    // init reply; this keeps an open page in step with Settings/OS switches.
    iframeRef.current?.contentWindow?.postMessage(
      { __gezelPage: 1, kind: 'theme', theme: { mode: theme } },
      '*',
    );
  }, [theme]);

  if (loadError) {
    return <div className={className}>Preview unavailable: {loadError}</div>;
  }

  return (
    <iframe
      ref={iframeRef}
      key={`${requestKey}:${src ?? 'loading'}`}
      title={title}
      {...(src ? { src } : {})}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      {...(className ? { className } : {})}
    />
  );
}
