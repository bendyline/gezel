import type { TerminalTimelineEntry } from '@bendyline/gezel';
import { AnsiOutput } from './AnsiOutput.js';
import { formatFolderLabel } from './terminal-folder-label.js';

// Scroll containers need a tab stop so keyboard users can reach both axes.
const KEYBOARD_SCROLL_PROPS = { tabIndex: 0 } as const;

/**
 * Renders one row from a terminal thread inside the project timeline.
 *
 * Visual contract (matching the user's stated mental model):
 *   - `command`  →  right-aligned, monospace, leading `>` prefix.
 *                   Echoes the resolved shell-paste form; if the entry
 *                   was index-resolved (e.g. typed `build` → ran
 *                   `pnpm run build`), the original input is shown as
 *                   a small "from: …" hint below.
 *   - `output`   →  left-aligned, monospace, exit-code pill on the right,
 *                   truncation badge when output was clipped, error
 *                   message banner when the run failed to spawn.
 *
 * Both variants render a folder pill so the user sees which working
 * directory the row belonged to — necessary because a single project
 * timeline can interleave commands from multiple folders.
 */
export function TerminalBubble({ entry }: { entry: TerminalTimelineEntry }) {
  // Prefer the per-message `cwd` (set by the server from the
  // persistent shell's actual cwd at the time the command ran) over
  // the thread's anchor `workingDir`. The anchor is where the user
  // explicitly picked via FolderTreeSwitcher; the shell may have
  // since cd'd elsewhere, and the bubble should reflect THAT, not
  // the original picker selection. Falls back to the anchor for
  // older messages persisted before the cwd field existed.
  const displayDir = entry.cwd !== undefined ? entry.cwd : entry.workingDir;
  const folder = formatFolderLabel(displayDir);
  if (entry.msgKind === 'command') {
    return (
      <div
        className="msg msg-user terminal-group terminal-group-command"
        data-terminal-message-id={entry.messageId}
      >
        <div className="msg-header terminal-group-header">
          <span className="terminal-folder-pill" title="Working folder">
            {folder}
          </span>
          <span className="msg-author">You · terminal</span>
        </div>
        <div className="msg-body terminal-cmd-body">
          <span className="terminal-prompt-sigil">&gt;</span>{' '}
          <code className="terminal-cmd-code">{entry.content}</code>
        </div>
        {entry.resolvedFrom && entry.resolvedFrom !== entry.content && (
          <div className="terminal-resolved-hint">from: {entry.resolvedFrom}</div>
        )}
      </div>
    );
  }

  // output
  const isFailed = entry.exitCode !== undefined && entry.exitCode !== 0;
  const exitLabel =
    entry.exitCode === undefined
      ? null
      : entry.exitCode === 0
        ? 'exit 0'
        : `exit ${entry.exitCode}`;
  return (
    <div
      className="msg msg-assistant terminal-group terminal-group-output"
      data-terminal-message-id={entry.messageId}
    >
      <div className="msg-header terminal-group-header">
        <span className="terminal-folder-pill" title="Working folder">
          {folder}
        </span>
        <span className="msg-author">Terminal output</span>
        {exitLabel && (
          <span
            className={`terminal-exit-pill ${isFailed ? 'terminal-exit-fail' : 'terminal-exit-ok'}`}
          >
            {exitLabel}
          </span>
        )}
        {typeof entry.durationMs === 'number' && (
          <span className="terminal-duration">{formatDuration(entry.durationMs)}</span>
        )}
        {entry.truncated && (
          <span className="terminal-truncated-pill" title="200KB output cap reached">
            truncated
          </span>
        )}
      </div>
      {entry.errorMessage && entry.exitCode === -1 && (
        <div className="terminal-error-banner">{entry.errorMessage}</div>
      )}
      <section
        className="terminal-output-viewport"
        aria-label="Terminal output"
        {...KEYBOARD_SCROLL_PROPS}
      >
        <pre className="terminal-output-body">
          {entry.content ? <AnsiOutput text={entry.content} /> : isFailed ? '(no output)' : ''}
        </pre>
      </section>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return `${min}m${rem.toString().padStart(2, '0')}s`;
}
