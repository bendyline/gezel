import type { AppleFoundationModelsStatus as AppleStatus } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

export function AppleFoundationModelsStatus() {
  const [status, setStatus] = useState<AppleStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await api.appleFoundationModelsStatus());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <p className="muted small">
        Uses Apple Intelligence on this Mac. Apple manages the model; there is nothing to download
        in Gezel.
      </p>
      <output
        className="small"
        style={{ display: 'block', marginBottom: '0.75rem' }}
        aria-live="polite"
      >
        {checking
          ? 'Checking Apple on-device AI…'
          : (error ??
            (status?.available
              ? status.runtime
                ? `Ready · ${status.runtime.contextTokens.toLocaleString()} tokens of context`
                : 'Ready'
              : (status?.reason ?? 'Apple on-device AI is unavailable.')))}
      </output>
      <button type="button" className="btn" disabled={checking} onClick={() => void refresh()}>
        Check again
      </button>
      <p className="muted small">
        Works offline for chat, notes and short tasks. Start a new conversation when earlier
        messages no longer fit.
      </p>
    </div>
  );
}
