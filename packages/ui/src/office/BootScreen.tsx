import { useState } from 'react';
import type { BootState } from './boot.js';

/**
 * Everything the pane shows before the chat: connecting, the one-time
 * connection code, and each way that can stop. Plain words; every stop has
 * a next step.
 */
export function BootScreen({ state, onRetry }: { state: BootState; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const retry = (
    <button type="button" className="primary" onClick={onRetry}>
      Try again
    </button>
  );
  switch (state.kind) {
    case 'connecting':
    case 'ready':
      return <div className="office-boot">Connecting to Gezel…</div>;
    case 'code':
      return (
        <div className="office-boot">
          <h1 className="office-boot-title">Connect this pane to Gezel</h1>
          <p>
            In the Gezel app, approve <strong>Microsoft Office</strong> and enter this code. You
            only do this once.
          </p>
          {state.code && (
            <div className="office-boot-code-row">
              <output className="office-boot-code" aria-label="Connection code">
                {state.code}
              </output>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(state.code ?? '').then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          <p className="muted small">
            If no approval request appears in Gezel, open Settings, then Connected Apps.
          </p>
          <p className="muted small" aria-live="polite">
            Waiting for approval…
          </p>
        </div>
      );
    case 'needs-revoke':
      return (
        <div className="office-boot">
          <h1 className="office-boot-title">Office is already connected</h1>
          <p>
            Gezel has a connection for Microsoft Office that this pane no longer holds. In Gezel,
            open Settings, then Connected Apps, and remove Microsoft Office. Then try again.
          </p>
          {retry}
        </div>
      );
    case 'denied':
      return (
        <div className="office-boot">
          <h1 className="office-boot-title">Connection declined</h1>
          <p>The request was declined in Gezel.</p>
          {retry}
        </div>
      );
    case 'expired':
      return (
        <div className="office-boot">
          <h1 className="office-boot-title">The code expired</h1>
          <p>The connection code was not approved in time.</p>
          {retry}
        </div>
      );
    case 'daemon-down':
      return (
        <div className="office-boot">
          <h1 className="office-boot-title">Gezel is not running</h1>
          <p>Start the Gezel app, then try again.</p>
          {retry}
        </div>
      );
    case 'error':
      return (
        <div className="office-boot">
          <h1 className="office-boot-title">Something went wrong</h1>
          <p>{state.message}</p>
          {retry}
        </div>
      );
  }
}
