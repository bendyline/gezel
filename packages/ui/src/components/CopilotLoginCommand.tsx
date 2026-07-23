import { streamCopilotLogin } from '@bendyline/gezel-client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Sign-in surface for the GitHub Copilot CLI. Two ways to launch:
 *
 *   1. **Log in now** (primary) — POSTs to `/api/system/copilot-login`
 *      and streams the CLI's stdout/stderr into an inline pane. The
 *      bundled Node + bundled pnpm do the work; users don't need a
 *      global Node install or a separate terminal. On a clean exit
 *      `onComplete()` fires so the caller can refresh auth state.
 *
 *   2. **Copy command** — the legacy path: a copyable
 *      `npx copilot login` string for users who prefer to run it in
 *      their own terminal (remote-daemon setups, paranoid users,
 *      or the subprocess path is unavailable).
 *
 * Both paths land the token at `~/.copilot` where the Copilot SDK
 * picks it up automatically.
 */
export function CopilotLoginCommand({
  installDir,
  onComplete,
}: {
  installDir?: string;
  onComplete?: () => void;
}) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'streaming'; lines: string[] }
    | { kind: 'done'; code: number; lines: string[] }
    | { kind: 'error'; message: string; lines: string[] }
  >({ kind: 'idle' });
  const [showCommand, setShowCommand] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const paneRef = useRef<HTMLPreElement | null>(null);

  // Auto-scroll the streaming pane as lines arrive so the device code
  // URL stays visible without the user manually scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` is intentionally the trigger — we re-scroll on every state change, even though the effect body doesn't read it.
  useEffect(() => {
    if (paneRef.current) {
      paneRef.current.scrollTop = paneRef.current.scrollHeight;
    }
  }, [state]);

  // If the component unmounts mid-stream, cancel the subprocess.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const command = installDir
    ? `cd "${installDir}" && npx copilot login`
    : 'npx @github/copilot login';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently ignore; the command is still visible */
    }
  };

  const startLogin = async () => {
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    const lines: string[] = [];
    setState({ kind: 'streaming', lines });
    try {
      for await (const event of streamCopilotLogin({
        url: api.copilotLoginUrl(),
        headers: api.authHeader(),
        signal: ctrl.signal,
        fetch: api.getFetch(),
      })) {
        if (event.kind === 'stdout' || event.kind === 'stderr') {
          lines.push(event.line);
          setState({ kind: 'streaming', lines: [...lines] });
        } else if (event.kind === 'exit') {
          setState({ kind: 'done', code: event.code, lines: [...lines] });
          if (event.code === 0) onComplete?.();
        } else if (event.kind === 'error') {
          setState({ kind: 'error', message: event.message, lines: [...lines] });
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        lines,
      });
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ kind: 'idle' });
  };

  return (
    <div className="home-copilot-login">
      <div className="home-copilot-login-actions">
        {state.kind === 'idle' && (
          <button type="button" className="primary" onClick={() => void startLogin()}>
            Log in now
          </button>
        )}
        {state.kind === 'streaming' && (
          <button type="button" className="home-link" onClick={cancel}>
            Cancel
          </button>
        )}
        {(state.kind === 'done' || state.kind === 'error') && (
          <button type="button" className="home-link" onClick={() => setState({ kind: 'idle' })}>
            {state.kind === 'done' && state.code === 0 ? 'Dismiss' : 'Try again'}
          </button>
        )}
        <button
          type="button"
          className="home-link"
          onClick={() => setShowCommand((v) => !v)}
          title="Prefer to run it yourself in a separate terminal"
        >
          {showCommand ? 'Hide' : 'Or run it in a terminal'}
        </button>
      </div>

      {(state.kind === 'streaming' || state.kind === 'done' || state.kind === 'error') && (
        <pre ref={paneRef} className="home-copilot-login-output">
          {state.lines.length > 0 ? state.lines.join('\n') : 'Starting the Copilot CLI…'}
          {state.kind === 'done' &&
            state.code !== 0 &&
            `\n\n(copilot login exited with code ${state.code})`}
          {state.kind === 'error' && `\n\nError: ${state.message}`}
        </pre>
      )}

      {showCommand && (
        <pre className="home-copilot-cmd">
          <code>{command}</code>
          <button
            type="button"
            className="home-copilot-cmd-copy"
            onClick={() => void copy()}
            title="Copy to clipboard"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </pre>
      )}
    </div>
  );
}
