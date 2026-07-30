import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnsiOutput } from './AnsiOutput.js';
import { formatFolderLabel } from './terminal-folder-label.js';

export interface TerminalStreamingAwaitingInput {
  promptLine: string;
  mode: 'text' | 'password' | 'yes-no';
}

/** A small tolerance avoids disabling follow mode on fractional scroll positions. */
const LIVE_TAIL_THRESHOLD_PX = 24;
// Scroll containers need a tab stop so keyboard users can reach both axes.
const KEYBOARD_SCROLL_PROPS = { tabIndex: 0 } as const;

/**
 * Live "growing" output bubble shown while a terminal run is
 * mid-flight. Mirrors the static `TerminalBubble`'s output-row
 * layout (folder pill, "Terminal output" label, body `<pre>`)
 * with two differences:
 *
 *   - Content is accumulated by the parent and re-rendered as a complete
 *     ANSI-bearing buffer, so chunk boundaries cannot leak partial escapes.
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

  const outputRef = useRef<HTMLElement>(null);
  const followLiveTailRef = useRef(true);

  // The parent supplies the complete accumulated output on every render.
  // Keep the newest line visible while the user is following the tail, but
  // leave their scroll position alone once they deliberately move upward.
  // biome-ignore lint/correctness/useExhaustiveDependencies: content is the signal that the scroll layout grew; the effect intentionally reads the viewport, not the text.
  useLayoutEffect(() => {
    const output = outputRef.current;
    if (!output || !followLiveTailRef.current) return;
    output.scrollTop = output.scrollHeight;
  }, [content]);

  const onOutputScroll = () => {
    const output = outputRef.current;
    if (!output) return;
    const distanceFromBottom = output.scrollHeight - output.clientHeight - output.scrollTop;
    followLiveTailRef.current = distanceFromBottom <= LIVE_TAIL_THRESHOLD_PX;
  };

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
      <section
        ref={outputRef}
        className="terminal-output-viewport"
        aria-label="Live terminal output"
        aria-busy="true"
        {...KEYBOARD_SCROLL_PROPS}
        onScroll={onOutputScroll}
      >
        <pre className="terminal-output-body">
          <AnsiOutput text={content} />
        </pre>
      </section>
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
