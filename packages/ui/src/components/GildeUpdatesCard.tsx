import type { GildeUpdateCheckResult, GildeUpdateStatusResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';

/**
 * Settings → About → "Catalog content": the opt-in toggle for live gilde
 * content updates, a manual Check-now, and a one-line status (content
 * source + last check outcome). The update engine lives in the daemon;
 * this card only flips `config.gildeUpdates.enabled` and polls
 * `GET /api/gilde-updates` while a check is in flight.
 */

function contentSourceLabel(status: GildeUpdateStatusResponse): string {
  if (status.mode === 'overridden')
    return 'Content source: developer override (GEZEL_GILDE_DATA_DIR)';
  if (status.mode === 'live' && status.activeVersion) {
    return `Content: ${status.activeVersion} (app shipped with ${status.bundledVersion})`;
  }
  return `Content: ${status.bundledVersion} (bundled with the app)`;
}

function lastCheckLabel(check: GildeUpdateCheckResult): string {
  const when = formatRelativeTime(check.at);
  switch (check.outcome) {
    case 'up-to-date':
      return `checked ${when} — up to date`;
    case 'updated':
      return `updated to ${check.version ?? '?'} ${when}`;
    case 'incompatible':
      return `checked ${when} — ${check.version ?? 'a newer version'} needs an app update first`;
    case 'error':
      return `check failed ${when} — ${check.message ?? 'unknown error'}`;
    case 'blocked':
      return `not checked (${check.message ?? 'blocked'})`;
  }
}

export function GildeUpdatesCard() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<GildeUpdateStatusResponse | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const refreshStatus = useCallback(async (): Promise<GildeUpdateStatusResponse | null> => {
    try {
      const next = await api.getGildeUpdateStatus();
      setStatus(next);
      setEnabled(next.enabled);
      return next;
    } catch {
      return null;
    }
  }, []);

  // Follow an in-flight check to its outcome. Bounded so a wedged daemon
  // can't leave the card polling forever.
  const pollUntilIdle = useCallback(() => {
    if (pollTimer.current !== null) return;
    let remaining = 60;
    const tick = async () => {
      pollTimer.current = null;
      const next = await refreshStatus();
      remaining -= 1;
      if (next?.updateInProgress && remaining > 0) {
        pollTimer.current = window.setTimeout(() => void tick(), 2000);
      }
    };
    pollTimer.current = window.setTimeout(() => void tick(), 2000);
  }, [refreshStatus]);

  useEffect(() => {
    void refreshStatus();
    return () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, [refreshStatus]);

  const saveEnabled = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setSaveError(null);
      try {
        await api.updateConfig({ gildeUpdates: { enabled: next } });
        // Enabling kicks a background check daemon-side; follow it.
        if (next) pollUntilIdle();
        else void refreshStatus();
      } catch (err) {
        setEnabled(previous);
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    },
    [enabled, pollUntilIdle, refreshStatus],
  );

  const checkNow = useCallback(async () => {
    setSaveError(null);
    try {
      await api.checkGildeUpdates();
      setStatus((current) => (current ? { ...current, updateInProgress: true } : current));
      pollUntilIdle();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [pollUntilIdle]);

  const checkDisabled = status?.mode === 'overridden' || status?.updateInProgress === true;

  return (
    <section style={{ marginBottom: '2rem' }}>
      <h3>Catalog content</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Craftbooks, model recommendations, and role templates ship with the app and can also update
        between releases. When on, Gezel checks about once a day for newer content, verifies it, and
        applies it. Nothing about you or this install is sent. Turning it off returns to the content
        that shipped with the app.
      </p>
      <label className="debug-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void saveEnabled(e.target.checked)}
        />
        <span>Keep catalog content up to date automatically</span>
      </label>
      <div
        className="new-row"
        style={{
          marginTop: '0.75rem',
          alignItems: 'flex-start',
          flexDirection: 'column',
          gap: '0.5rem',
        }}
      >
        <span
          className="muted small"
          title={status?.lastCheck ? formatAbsoluteTime(status.lastCheck.at) : undefined}
        >
          {status ? contentSourceLabel(status) : 'loading…'}
          {status?.updateInProgress
            ? ' · checking…'
            : status?.lastCheck
              ? ` · ${lastCheckLabel(status.lastCheck)}`
              : ''}
        </span>
        {enabled && (
          <button type="button" onClick={() => void checkNow()} disabled={checkDisabled}>
            Check now
          </button>
        )}
      </div>
      {saveError && <p className="error small">{saveError}</p>}
    </section>
  );
}
