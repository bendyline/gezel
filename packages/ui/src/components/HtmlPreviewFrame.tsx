import type { InvokePageToolResponse, PreviewLogEntry, ScriptRun } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

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
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // Reading the key is intentional: changing it remints a capability for an
    // explicit preview reload even though it is not part of the request body.
    void refreshKey;
    let cancelled = false;
    setSrc(null);
    setLoadError(null);
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
        setSrc(lease.url);
        onUrlReady?.(lease.url);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, source, refreshKey, onUrlReady]);

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

    function handleMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as Partial<HtmlPreviewLogEntry> & {
        __gezelPreviewLog?: boolean;
        __gezelPageInvoke?: boolean;
        __gezelPageRefresh?: boolean;
        id?: unknown;
        tool?: unknown;
        input?: unknown;
      };
      if (!data) return;

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
      flush();
    };
  }, [onLog, projectId, path, source, pageTools, onPageScriptError, onRequestRefresh]);

  if (loadError) {
    return <div className={className}>Preview unavailable: {loadError}</div>;
  }

  return (
    <iframe
      ref={iframeRef}
      key={`${src ?? 'loading'}:${refreshKey ?? ''}`}
      title={title}
      {...(src ? { src } : {})}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      {...(className ? { className } : {})}
    />
  );
}
