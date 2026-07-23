import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import {
  HtmlPreviewFrame,
  type HtmlPreviewLogEntry,
  type HtmlPreviewSource,
  type PageScriptErrorDetails,
} from './HtmlPreviewFrame.js';
import { useCompactLayout } from './useCompactLayout.js';

/**
 * Toolbar width (CSS pixels) below which the trailing action buttons
 * (reload / open / maximize / close) collapse into a single "⋯"
 * overflow menu, leaving the title + file picker room to breathe.
 * Below this the four 26px buttons + their gaps crowd the picker into
 * uselessness; above it they all fit inline comfortably. Independent
 * of {@link COMPACT_LAYOUT_THRESHOLD_PX} — that one governs the whole
 * project view; this one is local to this strip.
 */
const OUTPUT_TOOLBAR_COMPACT_PX = 360;

/** A selectable output target — the pinned type page or a workspace HTML file. */
interface OutputTarget {
  /** Stable id (`<source>::<path>`) for the picker + selection tracking. */
  id: string;
  source: HtmlPreviewSource;
  path: string;
  label: string;
}

/** A single toolbar action — rendered inline as an icon button, or as an
 *  icon+label row inside the overflow menu when the strip is narrow. */
interface OutputAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  ariaLabel: string;
}

/* Toolbar action icons. All share one 16×16 viewBox, stroke width, and
   cap/join so they read at a single consistent size — the earlier Unicode
   glyphs (⟳ ↗ ⤢ ×) each rendered at a different intrinsic size. */
const ICON_SVG_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

const ReloadIcon = () => (
  <svg {...ICON_SVG_PROPS} aria-hidden="true">
    <path d="M12.5 8a4.5 4.5 0 1 1-1.32-3.18" />
    <path d="M12.8 2.6v2.6h-2.6" />
  </svg>
);

const OpenExternalIcon = () => (
  <svg {...ICON_SVG_PROPS} aria-hidden="true">
    <path d="M8 3.5H4.2A0.7 0.7 0 0 0 3.5 4.2V11.8A0.7 0.7 0 0 0 4.2 12.5H11.8A0.7 0.7 0 0 0 12.5 11.8V8" />
    <path d="M9.5 3.5H12.5V6.5" />
    <path d="M12.5 3.5 8 8" />
  </svg>
);

const ExpandIcon = () => (
  <svg {...ICON_SVG_PROPS} aria-hidden="true">
    <path d="M9.5 3.5H12.5V6.5" />
    <path d="M12.5 3.5 9 7" />
    <path d="M6.5 12.5H3.5V9.5" />
    <path d="M3.5 12.5 7 9" />
  </svg>
);

const CollapseIcon = () => (
  <svg {...ICON_SVG_PROPS} aria-hidden="true">
    <path d="M12.5 6.5H9.5V3.5" />
    <path d="M9.5 6.5 12.8 3.2" />
    <path d="M3.5 9.5H6.5V12.5" />
    <path d="M6.5 9.5 3.2 12.8" />
  </svg>
);

const CloseIcon = () => (
  <svg {...ICON_SVG_PROPS} aria-hidden="true">
    <path d="M4 4 12 12" />
    <path d="M12 4 4 12" />
  </svg>
);

/**
 * The "⋯" overflow menu the toolbar collapses into when narrow. Opens a
 * dropdown of the same actions as labelled rows. Closes on outside
 * click, Escape, or selecting an item.
 */
function OutputToolbarOverflow({ actions }: { actions: OutputAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="project-output-menu" ref={ref}>
      <button
        type="button"
        className="project-output-btn"
        onClick={() => setOpen((o) => !o)}
        title="More actions"
        aria-label="More output actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && (
        <div className="project-output-menu-dropdown" role="menu">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitem"
              className="project-output-menu-item"
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
              disabled={a.disabled}
              title={a.title}
            >
              <span className="project-output-menu-item-glyph" aria-hidden="true">
                {a.icon}
              </span>
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Persistent project output pane — a sandboxed live preview of the
 * project's workspace so the running app (a game, a site, …) stays
 * visible irrespective of which project tab is active. Mounts on the
 * left of the project body; its visibility is toggled from the tab row
 * in {@link ProjectsView}.
 *
 * The toolbar is intentionally a thin "launch target" strip. Today it
 * holds an HTML-file picker + a refresh button, but it's the seam where
 * richer launch targets will plug in later (a VS Code `launch.json`
 * config, an npm `dev` server, …) — for HTML-based projects the picker
 * is the natural first target. The default target isn't a blind
 * `index.html` grab: {@link pickAutoplayTarget} scans every workspace
 * HTML file and ranks them, so a beefy real page wins over a skeleton
 * `index.html` a model left behind (a common LLM-prototype failure mode).
 *
 * Maximize (the toolbar button or F5) expands the pane to fill the
 * whole window by toggling a `position: fixed` class on the SAME
 * `<aside>` — the iframe is never moved in the React tree, so the
 * running app keeps its state across maximize/restore (no reload). Its
 * z-index sits above the app chrome but below dialogs/selects so the
 * file picker still opens on top while maximized. Esc or F5 restores
 * it. F5 isn't bound to reload in our Electron shell (it uses
 * Cmd/Ctrl+R), so claiming it here is safe — we still `preventDefault`
 * as belt-and-suspenders.
 */
export function ProjectOutputPane({
  projectId,
  htmlFiles,
  typePage,
  onClose,
  onDebugFrame,
}: {
  projectId: string;
  /** Workspace HTML files (relative paths) from the parent's latest listing. */
  htmlFiles: string[];
  /**
   * When the project has an applied custom project type that pins an Output
   * page (its dashboard), this is that page — served read-only from the
   * type's catalog `pages/` tree. When set it becomes the default target,
   * shown ahead of workspace files. See docs/project-types.md.
   */
  typePage?: { entry: string; label: string; pageTools?: string[] };
  /** Hide the pane entirely (flips the tab-row toggle off). */
  onClose: () => void;
  /**
   * Receive a captured "debug frame" — a markdown blob embedding a
   * screenshot of the running preview plus a browser-state report
   * (JS errors / console output since load). The parent drops it into
   * the project-chat composer (and reveals the chat) so the user can
   * review and send it, mirroring the preview-error "complain" flow.
   * When omitted, the capture button is hidden.
   */
  onDebugFrame?: (markdown: string) => void;
}) {
  const [pickedPath, setPickedPath] = useState('');
  const [autoTarget, setAutoTarget] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [debugMode, setDebugMode] = useState(false);
  const [scriptError, setScriptError] = useState<PageScriptErrorDetails | null>(null);
  const [scriptErrorCopyState, setScriptErrorCopyState] = useState<'idle' | 'copied' | 'error'>(
    'idle',
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Runtime logs forwarded from the preview iframe's injected shim, kept
  // so a debug-frame capture can report "what the browser saw" alongside
  // the screenshot. Reset whenever the previewed file or refresh changes.
  const logsRef = useRef<HtmlPreviewLogEntry[]>([]);
  // Wraps the iframe; its bounding box is the region we hand to
  // capturePage. The iframe fills this box (see .project-output-iframe).
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Observe the toolbar's width so the action buttons collapse into a
  // "⋯" overflow menu once the strip gets too narrow for them inline.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const compactToolbar = useCompactLayout(toolbarRef, OUTPUT_TOOLBAR_COMPACT_PX);

  // Script diagnostics are an explicitly debug-only surface. Fetch the
  // install config here instead of sending debug state into the sandboxed
  // preview page; normal mode neither hydrates run records nor renders the
  // clipboard action.
  useEffect(() => {
    let cancelled = false;
    void api
      .getConfig()
      .then((config) => {
        if (!cancelled) setDebugMode(config.debugMode === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-run detection only when the *set* of HTML paths actually changes
  // by value — the parent hands us a fresh array on every refresh (e.g.
  // switching to the Workspace tab re-lists files), and we don't want
  // that churn to re-fetch or stomp the user's manual pick.
  const htmlKey = useMemo(() => [...htmlFiles].sort().join('\n'), [htmlFiles]);

  // Autoplay-target detection: scan + rank the workspace HTML files and
  // adopt the winner as the default. Async (it stats + sniffs file
  // contents), so we surface a brief "Detecting…" state rather than
  // flash a stub first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: htmlKey is the value-stable trigger for htmlFiles.
  useEffect(() => {
    let cancelled = false;
    if (htmlFiles.length === 0) {
      setAutoTarget('');
      setDetecting(false);
      return;
    }
    setDetecting(true);
    void (async () => {
      const best = await pickAutoplayTarget(projectId, htmlFiles);
      if (cancelled) return;
      setAutoTarget(best);
      setDetecting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, htmlKey]);

  // Unified target list: the pinned project-type page (when present) first,
  // then the workspace HTML files. Each target carries its own preview
  // `source` so the frame reads from the right tree.
  const targets = useMemo<OutputTarget[]>(() => {
    const list: OutputTarget[] = [];
    if (typePage) {
      list.push({
        id: `type::${typePage.entry}`,
        source: 'type',
        path: typePage.entry,
        label: typePage.label,
      });
    }
    for (const p of htmlFiles) {
      list.push({
        id: `workspace::${p}`,
        source: 'workspace',
        path: p,
        label: formatOutputLabel(p),
      });
    }
    return list;
  }, [typePage, htmlFiles]);

  // The user's explicit pick wins while it's still in the list; otherwise the
  // pinned type page, else the auto-ranked workspace file, else nothing.
  const defaultTarget =
    (typePage ? targets[0] : undefined) ??
    (autoTarget
      ? targets.find((t) => t.source === 'workspace' && t.path === autoTarget)
      : undefined) ??
    targets.find((t) => t.source === 'workspace');
  const selectedTarget = targets.find((t) => t.id === pickedPath) ?? defaultTarget ?? null;

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // F5 toggles maximize; Esc exits it. preventDefault on F5 keeps the
  // Electron renderer from hard-reloading the whole app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        setMaximized((m) => !m);
      } else if (e.key === 'Escape' && maximized) {
        e.preventDefault();
        setMaximized(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  const openInBrowser = useCallback(() => {
    if (!selectedTarget || !previewUrl) return;
    // Electron's setWindowOpenHandler routes this to the system browser.
    window.open(previewUrl, '_blank', 'noopener,noreferrer');
  }, [selectedTarget, previewUrl]);

  // Accumulate preview runtime logs for the debug-frame report. Stable
  // identity so HtmlPreviewFrame's message listener isn't re-bound each
  // render. Discard once the report would grow unwieldy — a debug frame
  // is a snapshot, not a full session log.
  const appendLog = useCallback((entry: HtmlPreviewLogEntry) => {
    const next = [...logsRef.current, entry];
    logsRef.current = next.length > 200 ? next.slice(-200) : next;
  }, []);
  // A new page (or reload) starts a fresh browser state, so the prior
  // page's errors shouldn't bleed into its debug frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearing on target/refresh change is the intent.
  useEffect(() => {
    logsRef.current = [];
    setCaptureError('');
    setScriptError(null);
    setScriptErrorCopyState('idle');
  }, [selectedTarget?.id, refreshKey]);

  useEffect(() => {
    if (!debugMode) {
      setScriptError(null);
      setScriptErrorCopyState('idle');
    }
  }, [debugMode]);

  const handlePageScriptError = useCallback((details: PageScriptErrorDetails | null) => {
    setScriptError(details);
    setScriptErrorCopyState('idle');
  }, []);

  const copyScriptError = useCallback(async () => {
    if (!scriptError) return;
    try {
      await navigator.clipboard.writeText(formatPageScriptErrorDetails(scriptError));
      setScriptErrorCopyState('copied');
    } catch {
      setScriptErrorCopyState('error');
    }
  }, [scriptError]);

  // Capture a "debug frame": screenshot the live preview + summarize the
  // browser state, then hand the markdown to the parent to seed the chat.
  // The preview iframe runs null-origin, so we can't rasterize it in the
  // renderer; we go through the Electron shell's capturePageRegion over
  // the iframe's bounding box instead. The screenshot uploads as a
  // project attachment and embeds as a markdown image — the same path a
  // pasted image takes — so it renders inline in the composer and chat.
  const captureDebugFrame = useCallback(async () => {
    if (!selectedTarget || capturing) return;
    const capture = window.__GEZEL__?.capturePageRegion;
    if (!capture) {
      setCaptureError('Screenshots need the desktop app.');
      return;
    }
    const rectEl = bodyRef.current;
    if (!rectEl) return;
    setCapturing(true);
    setCaptureError('');
    try {
      const box = rectEl.getBoundingClientRect();
      const shot = await capture({
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
      });
      if (!shot.ok) throw new Error(shot.error);
      // Decode the capture's `data:` URL to a Blob directly rather than
      // `fetch()`-ing it: the renderer CSP is `connect-src 'self'`, which
      // rejects a `fetch('data:…')` with an opaque "Failed to fetch".
      const blob = dataUrlToBlob(shot.dataUrl);
      const { relativePath } = await api.uploadProjectAttachment(projectId, blob, 'image/png');
      const markdown = formatDebugFrame(selectedTarget.path, relativePath, logsRef.current);
      onDebugFrame?.(markdown);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  }, [projectId, selectedTarget, capturing, onDebugFrame]);

  // The trailing actions, declared as data so the same set renders both
  // inline (wide) and as overflow-menu rows (narrow). Close is omitted
  // while maximized — Esc/F5 restore instead.
  const actions: OutputAction[] = [
    {
      key: 'reload',
      label: 'Reload',
      icon: <ReloadIcon />,
      onClick: refresh,
      disabled: !selectedTarget,
      title: 'Reload the preview',
      ariaLabel: 'Reload the preview',
    },
    {
      key: 'open',
      label: 'Open in browser',
      icon: <OpenExternalIcon />,
      onClick: openInBrowser,
      disabled: !selectedTarget || !previewUrl,
      title: 'Open in your default browser',
      ariaLabel: 'Open in your default browser',
    },
    {
      key: 'maximize',
      label: maximized ? 'Restore' : 'Maximize',
      icon: maximized ? <CollapseIcon /> : <ExpandIcon />,
      onClick: () => setMaximized((m) => !m),
      title: maximized ? 'Restore (F5)' : 'Maximize (F5)',
      ariaLabel: maximized ? 'Restore output pane' : 'Maximize output pane',
    },
  ];
  if (!maximized) {
    actions.push({
      key: 'close',
      label: 'Hide output',
      icon: <CloseIcon />,
      onClick: onClose,
      title: 'Hide output pane',
      ariaLabel: 'Hide output pane',
    });
  }

  const toolbar = (
    <div className="project-output-toolbar" ref={toolbarRef}>
      {targets.length > 0 && (
        <Select.Root value={selectedTarget?.id} onValueChange={(id) => setPickedPath(id)}>
          <Select.Trigger className="project-output-picker">
            <Select.Value placeholder={detecting ? 'Detecting…' : 'Select a target…'} />
          </Select.Trigger>
          <Select.Content>
            {targets.map((t) => (
              <Select.Item key={t.id} value={t.id} textValue={t.label}>
                {t.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      )}
      <span className="project-output-toolbar-spacer" />
      {compactToolbar ? (
        <OutputToolbarOverflow actions={actions} />
      ) : (
        actions.map((a) => (
          <button
            key={a.key}
            type="button"
            className="project-output-btn"
            onClick={a.onClick}
            disabled={a.disabled}
            title={a.title}
            aria-label={a.ariaLabel}
          >
            {a.icon}
          </button>
        ))
      )}
    </div>
  );

  const body = selectedTarget ? (
    <HtmlPreviewFrame
      projectId={projectId}
      path={selectedTarget.path}
      source={selectedTarget.source}
      title={selectedTarget.label}
      className="project-output-iframe"
      refreshKey={refreshKey}
      onLog={appendLog}
      onUrlReady={setPreviewUrl}
      // The page-invoke bridge opens only for the pinned type page — plain
      // workspace/artifact previews have no declared tool surface.
      {...(selectedTarget.source === 'type' && typePage?.pageTools?.length
        ? { pageTools: typePage.pageTools }
        : {})}
      {...(debugMode ? { onPageScriptError: handlePageScriptError } : {})}
      onRequestRefresh={refresh}
    />
  ) : detecting ? (
    <div className="project-output-empty">
      <p className="muted small">Detecting output target…</p>
    </div>
  ) : (
    <div className="project-output-empty">
      <p className="muted small">
        No previewable HTML in this workspace yet. When a gezel writes an <code>index.html</code>,
        it'll show up here.
      </p>
    </div>
  );

  // The bottom "debug tools" strip. Right-aligned so the controls sit
  // against the chat that abuts the pane on the right, making it cheap to
  // drop a debug frame in. It holds the screenshot-to-chat button plus
  // debug-only script-error details when a page invoke fails.
  const debugBar =
    onDebugFrame || (debugMode && scriptError) ? (
      <div className="project-output-debugbar">
        {captureError && (
          <span className="project-output-debugbar-error small" role="alert">
            {captureError}
          </span>
        )}
        {debugMode && scriptError && (
          <output className="project-output-script-error-label small">
            {scriptError.response?.error ?? scriptError.transportError ?? 'Script failed'}
          </output>
        )}
        <span className="project-output-toolbar-spacer" />
        {debugMode && scriptError && (
          <button
            type="button"
            className="project-output-script-error-copy"
            onClick={() => void copyScriptError()}
            title="Copy the full script run, including logs and call trace"
            aria-label="Copy full script error details"
          >
            {scriptErrorCopyState === 'copied'
              ? 'Copied'
              : scriptErrorCopyState === 'error'
                ? 'Copy failed'
                : 'Copy details'}
          </button>
        )}
        {onDebugFrame && (
          <button
            type="button"
            className="project-output-btn"
            onClick={captureDebugFrame}
            disabled={!selectedTarget || capturing}
            title="Send a screenshot + browser state to the chat"
            aria-label="Send a debug frame to the chat"
          >
            {capturing ? '…' : '📷'}
          </button>
        )}
      </div>
    ) : null;

  // Same element in both states — only the class changes — so the
  // iframe is never unmounted and the running app keeps its state.
  return (
    <aside className={`project-output-pane${maximized ? ' project-output-pane-maximized' : ''}`}>
      {toolbar}
      <div ref={bodyRef} className="project-output-pane-body">
        {body}
      </div>
      {debugBar}
    </aside>
  );
}

/**
 * Clipboard-friendly debug report for a page-triggered script failure.
 * The full persisted run is deliberately included as JSON: this is a
 * developer surface, and preserving every field is more useful than a
 * prettier summary that silently drops the one clue a failure needs.
 */
export function formatPageScriptErrorDetails(details: PageScriptErrorDetails): string {
  const lines = ['# Gezel page script error', '', `Tool: ${details.tool}`];
  if (details.response) {
    lines.push(`Run ID: ${details.response.runId}`);
    lines.push(`Status: ${details.response.status}`);
    if (details.response.error) lines.push(`Error: ${details.response.error}`);
    lines.push('', '## Page invoke response', '', '```json');
    lines.push(JSON.stringify(details.response, null, 2));
    lines.push('```');
  }
  if (details.run) {
    lines.push('', '## Full script run', '', '```json');
    lines.push(JSON.stringify(details.run, null, 2));
    lines.push('```');
  }
  if (details.transportError) {
    lines.push('', `Transport error: ${details.transportError}`);
  }
  if (details.detailLoadError) {
    lines.push('', `Full run could not be loaded: ${details.detailLoadError}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Human-friendly label for an output file path shown in the picker. Drops
 * the `.html`/`.htm` extension (noise for non-technical users) and renders
 * an `index` page — the web's implicit default document — as the plainer
 * "(Default Page)". The directory prefix is preserved, so `foo/index.html`
 * reads `foo/(Default Page)`. The underlying `value` stays the real path.
 */
export function formatOutputLabel(path: string): string {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = path.slice(slash + 1).replace(/\.html?$/i, '');
  return dir + (base.toLowerCase() === 'index' ? '(Default Page)' : base);
}

/**
 * Decode a `data:<mime>;base64,<payload>` URL (as produced by Electron's
 * `nativeImage.toDataURL()`) into a Blob. We can't `fetch()` the data URL
 * in the renderer — its CSP is `connect-src 'self'`, which blocks `data:`
 * fetches — so we base64-decode it by hand instead.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const mime = header.match(/data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Build the markdown for a debug frame: a short prose lead, the embedded
 * screenshot (as a project-attachment image ref, so it renders inline in
 * the composer + chat), and — only when there's something to report — a
 * browser-state section listing any runtime errors / console output
 * captured since the page loaded. Phrased as a
 * user report so the gezel reads it as "here's what I'm seeing," not a
 * raw log dump. Mirrors the preview-error complaint format.
 */
export function formatDebugFrame(
  path: string,
  screenshotPath: string,
  logs: HtmlPreviewLogEntry[],
): string {
  const lines: string[] = [];
  lines.push(`![Screenshot of workspace file ${path}](${screenshotPath})`);
  if (logs.length > 0) {
    lines.push('');
    lines.push(`**Browser state:** ${logs.length} console event(s) captured since load:`);
    lines.push('');
    for (const entry of logs.slice(-50)) {
      lines.push(`- ${formatDebugLogLine(entry)}`);
    }
  }
  return lines.join('\n');
}

/** One compact bullet for a captured preview log entry. */
function formatDebugLogLine(entry: HtmlPreviewLogEntry): string {
  const message =
    entry.kind === 'console.error'
      ? (entry.detail.args ?? []).join(' ')
      : (entry.detail.message ?? '(unknown error)');
  const loc = [
    entry.detail.filename,
    entry.detail.lineno ? String(entry.detail.lineno) : null,
    entry.detail.colno ? String(entry.detail.colno) : null,
  ]
    .filter(Boolean)
    .join(':');
  return `**${entry.kind}:** ${message}${loc ? ` _(${loc})_` : ''}`;
}

/** A scanned HTML candidate plus the signals the ranker scores on. */
export interface HtmlCandidate {
  path: string;
  /** Byte size (from stat, falling back to fetched content length). */
  size: number;
  /** Last-modified epoch ms, or 0 when unknown. */
  mtimeMs: number;
  /** True when the file reads as a model-left skeleton, not a real page. */
  placeholder: boolean;
}

// Cap how many files we stat + sniff so a workspace with hundreds of
// HTML files (a docs site, say) can't fan out unbounded. The cap is far
// above any plausible "which one is the app" set.
const MAX_DETECT_CANDIDATES = 24;

/**
 * Output autoplay-target detection. Given the workspace's HTML files,
 * pick the one most likely to be "the app you want to see running."
 * Ranks by, in order of weight: not-a-placeholder ≫ more bytes > newer
 * > named index.html. The size + recency signals come from a cheap
 * `stat`; placeholder detection sniffs the file body. Returns '' only
 * when there are no candidates.
 */
async function pickAutoplayTarget(projectId: string, htmlFiles: string[]): Promise<string> {
  if (htmlFiles.length === 0) return '';
  if (htmlFiles.length === 1) return htmlFiles[0] ?? '';
  const candidates = htmlFiles.slice(0, MAX_DETECT_CANDIDATES);
  const metas = await Promise.all(
    candidates.map(async (path): Promise<HtmlCandidate> => {
      const [stat, content] = await Promise.all([
        api.statProjectWorkspacePath(projectId, path).catch(() => null),
        api
          .readProjectWorkspaceFile(projectId, path)
          .then((r) => r.content)
          .catch(() => ''),
      ]);
      return {
        path,
        size: stat?.size ?? content.length,
        mtimeMs: stat?.mtime ? Date.parse(stat.mtime) : 0,
        placeholder: looksLikePlaceholder(content),
      };
    }),
  );
  return rankCandidates(metas) || (htmlFiles[0] ?? '');
}

/** Pick the highest-scoring candidate. Weights normalize size/recency
 *  across the set so the comparison is relative, not absolute. */
export function rankCandidates(metas: HtmlCandidate[]): string {
  if (metas.length === 0) return '';
  const maxSize = Math.max(1, ...metas.map((m) => m.size));
  const mtimes = metas.map((m) => m.mtimeMs).filter((t) => t > 0);
  const newest = mtimes.length ? Math.max(...mtimes) : 0;
  const oldest = mtimes.length ? Math.min(...mtimes) : 0;
  const span = newest - oldest;
  let best = metas[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const m of metas) {
    const normSize = m.size / maxSize; // 0..1
    const normRecency = span > 0 ? (m.mtimeMs - oldest) / span : 0; // 0..1
    const indexBonus = /(^|\/)index\.html?$/i.test(m.path) ? 1 : 0;
    // Non-placeholder dominates; among equals, bigger then newer then
    // the index.html convention as a final tiebreak.
    const score = (m.placeholder ? 0 : 1000) + normSize * 100 + normRecency * 40 + indexBonus * 10;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best?.path ?? '';
}

// Skeleton-comment phrases models leave behind in stubbed-out files.
const PLACEHOLDER_MARKERS = [
  'logic here',
  'code here',
  'goes here',
  'your code',
  'add your',
  'fill in',
  'coming soon',
  'placeholder',
  'todo',
  'fixme',
];

/**
 * Heuristic: does this HTML read as a model-left skeleton rather than a
 * real page? Two signals:
 *
 *   - A `<script>` whose body, with comments stripped, is essentially
 *     empty — a "// game logic here" stub. Flagged at any size.
 *   - A skeleton marker phrase in a *small* file. The size gate keeps a
 *     beefy real page that merely contains the word "todo" from being
 *     demoted; genuine placeholders are tiny.
 *
 * Deliberately conservative — a false "placeholder" is costly (it drops
 * the file below true stubs), so we only flag the small + obvious cases
 * and let the byte-size signal carry the rest.
 */
export function looksLikePlaceholder(content: string): boolean {
  if (!content.trim()) return true;
  const scripts = [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1] ?? '',
  );
  const hasScript = scripts.length > 0;
  const code = scripts
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim();
  if (hasScript && code.length < 40) return true;
  const lower = content.toLowerCase();
  const hasMarker = PLACEHOLDER_MARKERS.some((m) => lower.includes(m));
  return hasMarker && content.length < 2000;
}
