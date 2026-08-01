/**
 * The dial for how much of the machine's memory on-device models may hold,
 * combined across every engine. Sits under {@link EngineBudgetStrip}, which
 * already polls the same snapshot and shows what's committed against it.
 *
 * Why it exists: the budget is auto-derived from physical RAM, and on a
 * unified-memory Mac the auto value has to be a compromise — leave too
 * little and a model the machine could hold is refused, leave too much and
 * the OS starts swapping. There is no correct answer we can pick for
 * someone, only a sensible default plus a way to move it. Before this, the
 * only override was the `GEZEL_CAPACITY_BUDGET_GB` environment variable,
 * which the denial message told people to set — an env var, in a desktop
 * app, at the exact moment they were blocked.
 *
 * Anything above the auto mark is flagged, not blocked: a budget the
 * machine cannot really back shows up as heavy swapping rather than a
 * clean error, so the honest thing is to let people go there deliberately.
 */

import type { EngineStatusResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const GIB = 1024 ** 3;
/** Below this nothing useful loads, so the track doesn't go there. */
const FLOOR_GB = 2;
/**
 * Kept out of reach at the top of the track. Not a safety margin — the
 * flagged zone above the auto mark already covers risk — just a guard
 * against a setting that cannot boot the app that renders it.
 */
const CEILING_RESERVE_GB = 2;
const STEP_GB = 0.5;
/** A draft within this of the auto value counts as "on Auto". */
const SNAP_GB = 0.25;

function fmtGb(gb: number): string {
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export interface EngineMemoryBudgetPanelProps {
  /** Live pool snapshot from `/api/engines/status`. */
  status: EngineStatusResponse;
  /** Re-poll the snapshot after a save lands. */
  onSaved: () => void | Promise<void>;
}

export function EngineMemoryBudgetPanel({ status, onSaved }: EngineMemoryBudgetPanelProps) {
  const systemRamBytes = status.systemRamBytes ?? 0;
  const autoBytes = status.autoBudgetBytes ?? 0;
  const overridden = status.overridden ?? false;

  // null = follow auto; a number = explicit slider position.
  const [draftGb, setDraftGb] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Adopt the live budget as the starting position whenever the server
  // reports an override (including one saved from another window).
  const liveGb = status.budgetBytes / GIB;
  useEffect(() => {
    setDraftGb(overridden ? liveGb : null);
  }, [overridden, liveGb]);

  const onSave = useCallback(
    async (gb: number | null) => {
      setSaving(true);
      setMessage(null);
      try {
        await api.updateConfig({ localEngineMemoryGb: gb });
        setMessage(gb === null ? 'Back to automatic' : 'Saved');
        await onSaved();
      } catch (err) {
        setMessage(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [onSaved],
  );

  // Without physical RAM there's no meaningful track to draw — an older
  // daemon that predates these snapshot fields still gets the strip above.
  if (systemRamBytes <= 0 || autoBytes <= 0) return null;

  const autoGb = autoBytes / GIB;
  const totalGb = systemRamBytes / GIB;
  const minGb = Math.min(FLOOR_GB, autoGb);
  const maxGb = Math.max(autoGb, totalGb - CEILING_RESERVE_GB);
  const valueGb = Math.min(Math.max(draftGb ?? autoGb, minGb), maxGb);
  const onAuto = draftGb === null || Math.abs(draftGb - autoGb) <= SNAP_GB;
  const overAuto = !onAuto && valueGb > autoGb;
  const dirty = (draftGb ?? autoGb) !== (overridden ? liveGb : autoGb);
  const markerPct = ((autoGb - minGb) / Math.max(0.001, maxGb - minGb)) * 100;

  return (
    <div className="engine-memory-budget">
      <h4>Memory for on-device models</h4>
      <p className="muted small">
        The most memory all your on-device models may hold at once. Raise it to run a larger model;
        lower it to leave more of this {totalGb >= 1 ? `${Math.round(totalGb)} GB ` : ''}machine to
        everything else.
      </p>

      <div className="gz-budget-slider">
        <div className="gz-budget-slider-head">
          <strong>{fmtGb(valueGb)}</strong>
          {onAuto ? (
            <span className="gz-budget-tag">Automatic</span>
          ) : (
            <span
              className={`gz-budget-tag ${overAuto ? 'gz-budget-tag-risky' : 'gz-budget-tag-custom'}`}
            >
              {overAuto ? 'Above recommended' : 'Custom'}
            </span>
          )}
        </div>
        <div className="gz-budget-track">
          <input
            type="range"
            min={minGb}
            max={maxGb}
            step={STEP_GB}
            value={valueGb}
            aria-label="Memory for on-device models"
            onChange={(e) => setDraftGb(Number.parseFloat(e.target.value))}
          />
          <div
            className="gz-budget-marker"
            style={{ left: `${markerPct}%` }}
            title={`Recommended for this machine: ${fmtGb(autoGb)}`}
            aria-hidden="true"
          >
            <span className="gz-budget-marker-arrow">▲</span>
            <span className="gz-budget-marker-label">Auto · {fmtGb(autoGb)}</span>
          </div>
        </div>
        <div className="gz-budget-scale muted small">
          <span>{fmtGb(minGb)}</span>
          <span>{fmtGb(maxGb)}</span>
        </div>
      </div>

      {overAuto && (
        <output className="muted small engine-memory-budget-warning">
          Above what we'd pick for this machine. Models will still load, but the rest of the system
          has less to work with — expect things to feel slower before anything fails outright.
        </output>
      )}

      <div className="engine-memory-budget-actions">
        <button
          type="button"
          onClick={() => void onSave(onAuto ? null : valueGb)}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {overridden && (
          <button type="button" onClick={() => void onSave(null)} disabled={saving}>
            Back to automatic
          </button>
        )}
      </div>

      {message && (
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          {message}
        </p>
      )}
    </div>
  );
}
