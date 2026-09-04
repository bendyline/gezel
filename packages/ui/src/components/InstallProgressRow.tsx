import type { ReactNode } from 'react';

/**
 * One in-flight download in a manager's "Downloading…" list: title, a status
 * line, a determinate or indeterminate bar, and the one action that applies —
 * Cancel while it runs, Retry once it failed. Shared by the llama.cpp, MLX
 * and knowledge-catalog managers so a download reads the same everywhere.
 * Cancel is always offered: installs are server-owned background jobs, so
 * this row can cancel installs another window or the bootstrap started.
 */
export function InstallProgressRow({
  title,
  status,
  percent,
  tone = 'normal',
  onCancel,
  onRetry,
}: {
  title: ReactNode;
  status: string;
  /** `null` renders the indeterminate bar. */
  percent: number | null;
  tone?: 'normal' | 'warning' | 'error';
  onCancel: () => void;
  /** Shown instead of Cancel when `tone` is `error`. */
  onRetry?: () => void;
}) {
  const clamped = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className={`ollama-pull${tone === 'error' ? ' ollama-pull-error' : tone === 'warning' ? ' ollama-pull-warning' : ''}`}
    >
      <div className="ollama-pull-head">
        {title}
        <span className="muted small">{status}</span>
        {tone === 'error' && onRetry ? (
          <button type="button" className="gz-link-button" onClick={onRetry}>
            Retry
          </button>
        ) : (
          <button type="button" className="gz-link-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {clamped === null ? (
        <div className="ollama-pull-bar ollama-pull-bar-indeterminate">
          <div className="ollama-pull-bar-fill" />
        </div>
      ) : (
        <div className="ollama-pull-bar">
          <div className="ollama-pull-bar-fill" style={{ width: `${clamped}%` }} />
          <span className="ollama-pull-bar-label">{clamped}%</span>
        </div>
      )}
    </div>
  );
}
