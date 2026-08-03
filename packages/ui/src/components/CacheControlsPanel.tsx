/**
 * Operator controls for one engine's memory budget — the ceiling of
 * RAM gezel will hold in warm prompt caches before LRU eviction kicks
 * in. Drops into the existing MLX / llama.cpp settings panes; lives in
 * its own file so we don't duplicate the slider + clear button across
 * two views.
 *
 * Two operator-facing things here:
 *
 *   1. **Memory budget slider.** Caps how much RAM the
 *      SessionCacheController will let cached prompts hold per engine
 *      before LRU eviction. The track runs from a small floor to
 *      physical system RAM, with a tick marking the RAM-aware
 *      suggestion (1/2/4/8/16 GB across <16/16-32/32-64/≥64 GB
 *      systems). Leaving the slider on the suggestion keeps the budget
 *      "Auto" (no stored override, so it re-derives if RAM changes).
 *   2. **Clear all caches.** Emergency button — immediately drops
 *      every warm session for this engine. Used when caches feel
 *      stuck or the engine misbehaves.
 *
 * Live stats pull from `/api/cache/stats` once on mount + every 5s
 * thereafter. The polling cadence intentionally matches the
 * controller's reconcile interval so the displayed numbers stay in
 * sync with engine truth.
 */

import type { ProviderCacheStatsResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const POLL_MS = 5_000;
const MB = 1024 * 1024;
/** Below this a cache can't even hold one session — not worth offering. */
const FLOOR_MB = 512;
/** Fallback slider ceiling when the server hasn't reported system RAM. */
const FALLBACK_MAX_MB = 32 * 1024;
/**
 * RAM held back from the budget ceiling for the OS and other apps —
 * the slider never lets gezel claim the machine's last few GB. 4 GB is
 * a conservative floor for macOS + a couple of background apps.
 */
const SYSTEM_RESERVE_MB = 4 * 1024;
/** A draft within this of the suggestion counts as "on Auto". */
const SNAP_MB = 256;

/** MB → human string, e.g. 512 → "512 MB", 8192 → "8 GB", 2560 → "2.5 GB". */
function fmtMemory(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export interface CacheControlsPanelProps {
  /** Provider name to control — `'mlx'` or `'llama-cpp'`. */
  providerName: 'mlx' | 'llama-cpp';
  /** Friendly name for the panel header. e.g. "This Mac AI engine". */
  label: string;
  /** Current configured budget in MB (undefined = use auto default). */
  configuredBudgetMb: number | undefined;
}

export function CacheControlsPanel({
  providerName,
  label,
  configuredBudgetMb,
}: CacheControlsPanelProps) {
  const [stats, setStats] = useState<ProviderCacheStatsResponse | null>(null);
  // null = follow the auto suggestion; a number = explicit slider position.
  const [draftMb, setDraftMb] = useState<number | null>(configuredBudgetMb ?? null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getCacheStats();
      const entry = res.providers.find((p) => p.providerName === providerName) ?? null;
      setStats(entry);
    } catch {
      // Non-fatal — engine may not be initialized yet.
    }
  }, [providerName]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Sync the slider when config changes from elsewhere (e.g. reset to default).
  useEffect(() => {
    setDraftMb(configuredBudgetMb ?? null);
  }, [configuredBudgetMb]);

  const onSave = useCallback(
    async (valueMb: number | undefined) => {
      setSaving(true);
      setMessage(null);
      try {
        await api.updateConfig({
          cacheBudgetMb: { [providerName]: valueMb } as Record<string, number | undefined>,
        });
        setMessage(valueMb === undefined ? 'Reset to auto' : 'Saved');
        await refresh();
      } catch (err) {
        setMessage(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [providerName, refresh],
  );

  const onClear = useCallback(async () => {
    setClearing(true);
    setMessage(null);
    try {
      await api.clearProviderCache(providerName);
      setMessage('Cleared all caches');
      await refresh();
    } catch (err) {
      setMessage(`Failed to clear: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClearing(false);
    }
  }, [providerName, refresh]);

  const totalMb = stats ? Math.round(stats.totalBytes / MB) : 0;
  const budgetMb = stats ? Math.round(stats.budgetBytes / MB) : 0;

  // The RAM-aware suggestion (override-independent) and the physical-RAM
  // ceiling, both reported by /api/cache/stats. Fall back to the live
  // budget / a fixed ceiling until the first poll lands.
  const suggestedMb = stats?.defaultBudgetBytes
    ? Math.round(stats.defaultBudgetBytes / MB)
    : budgetMb || 2048;
  const minMb = Math.min(FLOOR_MB, suggestedMb);
  // Ceiling = physical RAM minus a reserve for the OS / other apps, so
  // the budget can never starve the rest of the machine. Floor it above
  // the suggestion so the track always spans the recommended value.
  const maxMb = stats?.systemRamBytes
    ? Math.max(suggestedMb, Math.round(stats.systemRamBytes / MB) - SYSTEM_RESERVE_MB)
    : Math.max(FALLBACK_MAX_MB, suggestedMb * 2);

  // Live slider position: the explicit draft, or the suggestion while on auto.
  const valueMb = Math.min(Math.max(draftMb ?? suggestedMb, minMb), maxMb);
  // "On auto" = no draft, or a draft that snaps back to the suggestion.
  const onAuto = draftMb === null || Math.abs(draftMb - suggestedMb) <= SNAP_MB;
  const isPersistedOverride = configuredBudgetMb !== undefined;
  const dirty = (draftMb ?? suggestedMb) !== (configuredBudgetMb ?? suggestedMb);
  const markerPct = ((suggestedMb - minMb) / Math.max(1, maxMb - minMb)) * 100;

  return (
    <div className="cache-controls-panel">
      <h4>Memory budget</h4>
      <p className="muted small">
        The most memory {label} keeps for warm threads before older ones are released.
      </p>
      {stats && stats.warmSessionCount > 0 ? (
        <p className="muted small">
          {stats.warmSessionCount} warm {stats.warmSessionCount === 1 ? 'thread' : 'threads'} ·{' '}
          {fmtMemory(totalMb)} used of {fmtMemory(budgetMb)}
          {stats.recentHitRate > 0 && (
            <> · {Math.round(stats.recentHitRate * 100)}% hit rate (last 50 turns)</>
          )}
        </p>
      ) : (
        <p className="muted small">No warm threads yet — cache populates after the first turn.</p>
      )}

      <div className="gz-budget-slider">
        <div className="gz-budget-slider-head">
          <strong>{fmtMemory(valueMb)}</strong>
          {onAuto ? (
            <span className="gz-budget-tag">Auto (RAM-aware)</span>
          ) : (
            <span className="gz-budget-tag gz-budget-tag-custom">Custom</span>
          )}
        </div>
        <div className="gz-budget-track">
          <input
            type="range"
            min={minMb}
            max={maxMb}
            step={256}
            value={valueMb}
            aria-label={`Memory budget for ${label}`}
            onChange={(e) => setDraftMb(Number.parseInt(e.target.value, 10))}
          />
          {/* Tick + arrow marking the RAM-aware suggestion on the track. */}
          <div
            className="gz-budget-marker"
            style={{ left: `${markerPct}%` }}
            title={`Suggested for this Mac: ${fmtMemory(suggestedMb)}`}
            aria-hidden="true"
          >
            <span className="gz-budget-marker-arrow">▲</span>
            <span className="gz-budget-marker-label">Auto · {fmtMemory(suggestedMb)}</span>
          </div>
        </div>
        <div className="gz-budget-scale muted small">
          <span>{fmtMemory(minMb)}</span>
          <span>{fmtMemory(maxMb)}</span>
        </div>
      </div>

      <div className="cache-budget-actions" style={{ marginTop: '0.75rem' }}>
        <button
          type="button"
          onClick={() => void onSave(onAuto ? undefined : valueMb)}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {isPersistedOverride && (
          <button
            type="button"
            onClick={() => void onSave(undefined)}
            disabled={saving}
            style={{ marginLeft: '0.5rem' }}
          >
            Reset to auto
          </button>
        )}
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <button
          type="button"
          onClick={() => void onClear()}
          disabled={clearing || !stats || stats.warmSessionCount === 0}
        >
          {clearing ? 'Clearing…' : 'Clear all caches'}
        </button>
      </div>

      {message && (
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          {message}
        </p>
      )}
    </div>
  );
}
