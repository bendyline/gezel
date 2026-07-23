import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { AlertDialog } from '../primitives/index.js';

/**
 * Global consent prompt for `/v1/apps/register`. Mounted once in App.tsx
 * so it surfaces from anywhere — the user shouldn't need to navigate to
 * Settings → Connected Apps to approve a request.
 *
 * Polls `GET /v1/apps` every 5s. When a pending grant is observed it
 * opens; the user picks Approve or Deny; the dialog closes and the
 * Settings panel + the polling third-party app both see the verdict.
 *
 * If multiple pending grants exist, the dialog shows them one at a
 * time in `createdAt` order so the user isn't overwhelmed.
 */
interface PendingGrant {
  id: string;
  appId: string;
  appName: string;
  scopes: string[];
  iconUrl?: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
  kind?: 'app' | 'device';
}

interface ConnectedAppsResponse {
  apps: unknown[];
  grants: PendingGrant[];
}

const POLL_INTERVAL_MS = 5000;

export function GrantConsentDialog() {
  const [grant, setGrant] = useState<PendingGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`${api.getBaseUrl()}/v1/apps`, {
        headers: api.authHeader(),
      });
      if (!res.ok) return;
      const body = (await res.json()) as ConnectedAppsResponse;
      const pending = body.grants
        .filter((g) => g.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt);
      // Don't churn the dialog state mid-interaction: only update when
      // there's no active grant, or when the active grant disappeared
      // (e.g. user approved it in Settings instead).
      setGrant((current) => {
        if (current) {
          const stillPending = pending.find((g) => g.id === current.id);
          return stillPending ?? null;
        }
        return pending[0] ?? null;
      });
    } catch {
      // Daemon transient — try again next tick.
    }
  }, []);

  useEffect(() => {
    void poll();
    const t = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [poll]);

  const decide = useCallback(
    async (action: 'approve' | 'deny') => {
      if (!grant || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `${api.getBaseUrl()}/v1/apps/grant/${encodeURIComponent(grant.id)}/${action}`,
          { method: 'POST', headers: api.authHeader() },
        );
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        setGrant(null);
        // Refresh so any other pending grant slides in immediately.
        void poll();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [grant, busy, poll],
  );

  if (!grant) return null;

  return (
    <AlertDialog.Root
      open
      onOpenChange={(next) => {
        // Backdrop/Escape behaves as deny so user dismissals are unambiguous.
        if (!next && !busy) void decide('deny');
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay />
        <AlertDialog.Content>
          <AlertDialog.Title asChild>
            <h3>{grant.appName} wants to connect</h3>
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div>
              <p className="muted small">
                {grant.kind === 'device'
                  ? 'Another Gezel device is asking to use models served by this computer.'
                  : 'An application on this computer or local network is asking to connect to Gezel.'}
              </p>
              <dl className="grant-consent-details">
                <dt>App ID</dt>
                <dd>
                  <code>{grant.appId}</code>
                </dd>
                <dt>Scopes</dt>
                <dd>{grant.scopes.join(', ')}</dd>
              </dl>
              <p className="muted small">
                You can revoke this any time from Settings → Connected Apps.
              </p>
              {error && (
                <p className="settings-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </AlertDialog.Description>
          <AlertDialog.Actions>
            <AlertDialog.Cancel asChild>
              <button type="button" onClick={() => void decide('deny')} disabled={busy}>
                Deny
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                className="primary"
                onClick={(e) => {
                  e.preventDefault();
                  void decide('approve');
                }}
                disabled={busy}
              >
                {busy ? 'Working…' : 'Approve'}
              </button>
            </AlertDialog.Action>
          </AlertDialog.Actions>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
