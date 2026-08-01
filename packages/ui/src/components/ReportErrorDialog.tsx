import type { SystemDiagnostics } from '@bendyline/gezel';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  type ErrorReportInput,
  URL_BUDGET_DEFAULT,
  URL_BUDGET_WIN32,
  deriveIssueTitle,
  fitIssueUrl,
  formatErrorReport,
  reportCursorOffset,
} from '../error-report.js';
import { Dialog } from '../primitives/index.js';

/**
 * Shows the user exactly what a bug report would say, lets them edit it, and
 * opens a pre-filled GitHub issue in their browser.
 *
 * The dialog fetches the machine profile itself rather than taking it as a
 * prop: one of its hosts is a class component that cannot hold an async
 * loading state, another re-renders on every streamed token and must not
 * fetch per render, and the fetch-failed fallback belongs in one place
 * rather than six.
 */
export function ReportErrorDialog({
  open,
  report,
  onClose,
}: {
  open: boolean;
  report: ErrorReportInput;
  onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const reportRef = useRef(report);
  reportRef.current = report;

  // Keyed on `open` alone, deliberately. The chat hosts re-render on every
  // streamed token with a fresh `report` object literal; re-running on that
  // identity would discard whatever the user had typed into the textarea —
  // hence the ref above rather than a dependency.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    setBusy(false);
    void (async () => {
      let diagnostics: SystemDiagnostics | null = null;
      try {
        diagnostics = await api.getSystemDiagnostics();
      } catch {
        // Reporting has to survive a dead service — that is often the bug.
      }
      if (cancelled) return;
      const next = formatErrorReport({ ...reportRef.current, diagnostics });
      setBody(next);
      setStatus('ready');
      queueMicrotask(() => {
        const at = reportCursorOffset(next);
        areaRef.current?.focus();
        areaRef.current?.setSelectionRange(at, at);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const maxUrlLength =
    window.__GEZEL__?.platform === 'win32' ? URL_BUDGET_WIN32 : URL_BUDGET_DEFAULT;
  const fitted = useMemo(
    () => fitIssueUrl({ title: deriveIssueTitle(report), body, maxUrlLength }),
    [report, body, maxUrlLength],
  );

  const submit = async () => {
    if (busy || status !== 'ready') return;
    setBusy(true);
    try {
      await navigator.clipboard?.writeText(body);
    } catch {
      // Clipboard permission denied; the URL still carries the report.
    }
    // Electron's setWindowOpenHandler routes this to shell.openExternal, so
    // it lands in the real browser. It has to be a navigation: the renderer
    // CSP is `connect-src 'self'`, so github.com is unreachable by fetch.
    window.open(fitted.url, '_blank', 'noopener,noreferrer');
    setBusy(false);
    onClose();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content
          className="gz-dialog-wide gz-dialog-report"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            style={{ display: 'contents' }}
          >
            <Dialog.Title asChild>
              <h3>Report error on GitHub</h3>
            </Dialog.Title>
            <Dialog.Description className="muted small">
              This is everything we would send. Nothing here identifies you — no logs, no file
              paths, no account details. Edit it however you like before it opens on GitHub.
            </Dialog.Description>
            <label className="gz-dialog-report-field">
              <span className="muted small">Report</span>
              <textarea
                ref={areaRef}
                value={status === 'loading' ? 'Collecting machine details…' : body}
                onChange={(e) => setBody(e.target.value)}
                readOnly={status === 'loading'}
                rows={18}
                spellCheck={false}
              />
            </label>
            {fitted.truncated && (
              <p className="muted small">
                This is longer than a link can carry, so it will be shortened. The full text is
                copied to your clipboard when you continue — paste it into the issue.
              </p>
            )}
            <Dialog.Actions>
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || status !== 'ready'}>
                {busy ? 'Opening…' : 'Create issue on GitHub'}
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
