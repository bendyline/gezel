import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { type AnsiRenderer, createAnsiRenderer } from './AnsiOutput.js';
import { formatFolderLabel } from './terminal-folder-label.js';

export interface TerminalStreamingAwaitingInput {
  promptLine: string;
  mode: 'text' | 'password' | 'yes-no';
}

/**
 * Live "growing" output bubble shown while a terminal run is
 * mid-flight. Mirrors the static `TerminalBubble`'s output-row
 * layout (folder pill, "Terminal output" label, body `<pre>`)
 * with two differences:
 *
 *   - Content is fed incrementally through a stateful
 *     `createAnsiRenderer()` so partial CSI sequences arriving
 *     across separate chunks buffer correctly.
 *   - A small "running…" elapsed-time indicator replaces the
 *     final exit-code pill until the run completes (at which
 *     point the parent ChatTimelineView drops the slot and the
 *     persisted TerminalBubble takes over the row).
 *
 * Cancel UI lands in Phase 2c — the `onCancel` callback is the
 * hook point.
 */
export function TerminalStreamingBubble({
  content,
  cwd,
  startedAt,
  onCancel,
  awaitingInput,
  onSendInput,
}: {
  content: string;
  cwd: string;
  /** ISO timestamp; used for the live "running 2s" indicator. */
  startedAt: string;
  /** Phase 2c hook — fires when user clicks Stop. Optional until
   *  cancellation lands. */
  onCancel?: () => void;
  /** Set when the server's prompt-detection heuristic decided the
   *  shell is waiting on stdin. Drives the inline reply input. */
  awaitingInput?: TerminalStreamingAwaitingInput;
  /** Phase 2d hook — fires with the user's typed reply (sans
   *  newline). The parent POSTs it to the input endpoint. */
  onSendInput?: (text: string) => void;
}) {
  const folder = formatFolderLabel(cwd);

  // Stateful ANSI renderer that survives the lifetime of THIS
  // streaming row. Re-feed the full content on each render — the
  // renderer is cheap and keeping it stateful across renders is
  // what makes partial CSI sequences buffer correctly across
  // chunk boundaries (a chunk ending in `\x1b[31` and the next
  // starting with `m` collapse into one styled span).
  const renderer = useMemo<AnsiRenderer>(() => createAnsiRenderer(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderer is intentionally stable across renders; content drives the redraw.
  const nodes = useMemo(() => renderer.feed(content), [content]);

  return (
    <div className="msg msg-assistant terminal-group terminal-group-output terminal-group-streaming">
      <div className="msg-header terminal-group-header">
        <span className="terminal-folder-pill" title="Working folder">
          {folder}
        </span>
        <span className="msg-author">Terminal output</span>
        <LiveElapsedPill startedAt={startedAt} />
        {onCancel && (
          <button
            type="button"
            className="terminal-cancel-btn"
            onClick={onCancel}
            title="Stop the running command (Ctrl+C)"
          >
            ■ Stop
          </button>
        )}
      </div>
      <pre className="terminal-output-body">{nodes}</pre>
      {awaitingInput && onSendInput && (
        <InteractiveReplyInput awaitingInput={awaitingInput} onSubmit={onSendInput} />
      )}
    </div>
  );
}

/**
 * Inline input that appears under the streaming bubble when the
 * server detects the shell is waiting on stdin. Three modes:
 *
 *   - `text`     → plain input + Enter / Send
 *   - `password` → masked input + helper text reminding the user
 *                  the value isn't echoed or logged
 *   - `yes-no`   → Yes / No buttons + free-text fallback
 *
 * Submitting clears the local input. The server's next chunk
 * implicitly clears the `awaitingInput` flag in the slot above
 * (any inbound output means the prompt was answered). If the
 * shell asks again (e.g., wrong password), a fresh
 * `inputRequested` event re-sets the flag and the input shows
 * again — no special re-init needed.
 */
function InteractiveReplyInput({
  awaitingInput,
  onSubmit,
}: {
  awaitingInput: TerminalStreamingAwaitingInput;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState('');
  const handleSubmit = (text: string) => {
    onSubmit(text);
    setValue('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(value);
    }
  };

  if (awaitingInput.mode === 'yes-no') {
    return (
      <div className="terminal-input-prompt">
        <div className="terminal-input-prompt-line">{awaitingInput.promptLine}</div>
        <div className="terminal-input-prompt-row">
          <button
            type="button"
            className="terminal-input-yesno-btn"
            onClick={() => handleSubmit('y')}
          >
            Yes
          </button>
          <button
            type="button"
            className="terminal-input-yesno-btn"
            onClick={() => handleSubmit('n')}
          >
            No
          </button>
          <input
            type="text"
            className="terminal-input-reply"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKey}
            placeholder="or type a custom reply"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </div>
    );
  }

  const isPassword = awaitingInput.mode === 'password';
  return (
    <div className="terminal-input-prompt">
      <div className="terminal-input-prompt-line">{awaitingInput.promptLine}</div>
      <div className="terminal-input-prompt-row">
        <input
          type={isPassword ? 'password' : 'text'}
          className="terminal-input-reply"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          placeholder={isPassword ? 'password (not echoed or saved)' : 'reply…'}
          // biome-ignore lint/a11y/noAutofocus: the prompt-detection event opens this input specifically for the user to reply — autofocus is the expected affordance.
          autoFocus
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="terminal-input-send-btn"
          onClick={() => handleSubmit(value)}
        >
          Send
        </button>
      </div>
      {isPassword && (
        <div className="terminal-input-hint">
          Your input is hidden and isn't kept in the timeline.
        </div>
      )}
    </div>
  );
}

/**
 * Re-renders every second to keep the "running 12s" pill ticking.
 * Cheap — only this small component re-renders, not the whole
 * streaming bubble (which is driven by `content` deltas).
 */
function LiveElapsedPill({ startedAt }: { startedAt: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const startedMs = useMemo(() => new Date(startedAt).getTime(), [startedAt]);
  const elapsed = Math.max(0, Date.now() - startedMs);
  return (
    <span className="terminal-running-pill" title="Running…">
      running {formatElapsed(elapsed)}
    </span>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${rem.toString().padStart(2, '0')}s`;
}
