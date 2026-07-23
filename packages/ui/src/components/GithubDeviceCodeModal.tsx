import type { GithubIdentity, GithubLoginStartResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';

/**
 * Renders the GitHub OAuth device-flow handshake. Lifecycle:
 *
 *   1. On mount, calls `startGithubLogin()` to get a `deviceCode` +
 *      `userCode` + `verificationUri`.
 *   2. Shows the user code prominently with a copy button, plus an
 *      "Open GitHub" button that pops `verificationUri` in the
 *      browser. The user signs in there.
 *   3. Polls `pollGithubLogin(deviceCode)` every `interval` seconds
 *      (extending by 5s on `slow_down` per GitHub's contract) until
 *      success / expired / denied / fatal.
 *   4. On `success`, fires `onSignedIn(identity)` and the parent
 *      closes the modal.
 *
 * Closing the modal mid-poll cancels the timer; the device code
 * naturally expires server-side a few minutes later.
 */
export function GithubDeviceCodeModal({
  onClose,
  onSignedIn,
}: {
  onClose: () => void;
  onSignedIn: (identity: GithubIdentity) => void;
}) {
  const [state, setState] = useState<
    | { kind: 'starting' }
    | { kind: 'awaiting'; start: GithubLoginStartResponse; status: string }
    | { kind: 'expired' }
    | { kind: 'denied'; message?: string }
    | { kind: 'error'; message: string }
  >({ kind: 'starting' });
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  useEffect(() => {
    const cancel = cancelRef.current;
    void (async () => {
      try {
        const start = await api.startGithubLogin();
        if (cancel.cancelled) return;
        setState({ kind: 'awaiting', start, status: 'Waiting for you to authorize on GitHub…' });
        let intervalSec = start.interval;
        const expiresAt = Date.now() + start.expiresIn * 1000;
        while (!cancel.cancelled) {
          await delay(intervalSec * 1000);
          if (cancel.cancelled) return;
          if (Date.now() > expiresAt) {
            setState({ kind: 'expired' });
            return;
          }
          let res: Awaited<ReturnType<typeof api.pollGithubLogin>>;
          try {
            res = await api.pollGithubLogin(start.deviceCode);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setState({ kind: 'error', message });
            return;
          }
          if (cancel.cancelled) return;
          if (res.status === 'success') {
            onSignedIn(res.identity);
            return;
          }
          if (res.status === 'expired') {
            setState({ kind: 'expired' });
            return;
          }
          if (res.status === 'denied') {
            setState({ kind: 'denied', ...(res.error ? { message: res.error } : {}) });
            return;
          }
          if (res.status === 'not_configured') {
            setState({ kind: 'error', message: res.error });
            return;
          }
          if (res.status === 'slow_down') intervalSec += 5;
          // 'pending' → loop again
        }
      } catch (err) {
        if (cancel.cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
      }
    })();
    return () => {
      cancel.cancelled = true;
    };
  }, [onSignedIn]);

  const copyCode = useCallback(async () => {
    if (state.kind !== 'awaiting') return;
    try {
      await navigator.clipboard.writeText(state.start.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }, [state]);

  const openGithub = useCallback(() => {
    if (state.kind !== 'awaiting') return;
    window.open(state.start.verificationUri, '_blank', 'noopener,noreferrer');
  }, [state]);

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content>
          <Dialog.Title asChild>
            <h3>Sign in to GitHub</h3>
          </Dialog.Title>
          {state.kind === 'starting' && <p className="muted">Starting sign-in…</p>}
          {state.kind === 'awaiting' && (
            <>
              <p className="muted small">
                Open GitHub, paste the code below, and authorize Gezel. We'll detect when you're
                signed in and close this dialog automatically.
              </p>
              <div className="gz-github-device-code">
                <code>{state.start.userCode}</code>
                <button type="button" onClick={() => void copyCode()}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="gz-github-device-actions">
                <button type="button" className="primary" onClick={openGithub}>
                  Open GitHub
                </button>
                <span className="muted small">{state.status}</span>
              </div>
            </>
          )}
          {state.kind === 'expired' && (
            <p className="error small">Sign-in code expired. Close and try again.</p>
          )}
          {state.kind === 'denied' && (
            <p className="error small">
              Sign-in was denied{state.message ? `: ${state.message}` : ''}.
            </p>
          )}
          {state.kind === 'error' && <p className="error small">{state.message}</p>}
          <Dialog.Actions>
            <button type="button" onClick={onClose}>
              {state.kind === 'awaiting' ? 'Cancel' : 'Close'}
            </button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
