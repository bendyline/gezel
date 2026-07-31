import type { EngineStatusResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { EngineMemoryBudgetPanel } from './EngineMemoryBudgetPanel.js';

interface Props {
  /**
   * Which engine's entries to summarize. The strip itself shows the
   * GLOBAL budget (broker is shared) but lists only matching-engine
   * resident keys so each settings page focuses on its own pool.
   */
  provider: 'llama-cpp' | 'mlx';
  /** Polling cadence in milliseconds. Default 2s — matches the plan. */
  pollMs?: number;
}

function fmtGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Header strip that surfaces the engine memory broker's live view:
 * committed bytes vs. configured budget, plus the per-replica
 * resident list filtered to the page's engine. Polls
 * `/api/engines/status` so a `POST /reconcile` (or a chat-driven
 * spawn) lights up here within ~2s.
 */
export function EngineBudgetStrip({ provider, pollMs = 2000 }: Props) {
  const [status, setStatus] = useState<EngineStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Shared by the poll loop and the budget panel's post-save refresh, so a
  // saved budget shows on the bar immediately instead of up to `pollMs`
  // later.
  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getEngineStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.getEngineStatus();
        if (cancelled) return;
        setStatus(s);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  if (error) {
    return (
      <div style={{ fontSize: 12, color: 'var(--gz-color-muted, #888)' }}>
        Engine status unavailable: {error}
      </div>
    );
  }
  if (!status || !status.enforced) {
    // Cloud-only install or pre-boot — hide the strip rather than
    // showing 0 / 0 which would look like a bug.
    return null;
  }

  const ratio = status.budgetBytes > 0 ? status.committedBytes / status.budgetBytes : 0;
  const filtered = status.entries.filter((e) => e.provider === provider);
  const overBudget = ratio > 1;

  return (
    <div
      style={{
        border: '1px solid var(--gz-color-border, #2c2c2c)',
        borderRadius: 6,
        padding: '10px 14px',
        marginBottom: '1rem',
        background: 'var(--gz-color-surface, transparent)',
        fontSize: 13,
      }}
    >
      <div style={{ marginBottom: 6, fontWeight: 500 }}>Engine memory budget</div>
      <div
        style={{
          height: 8,
          width: '100%',
          borderRadius: 4,
          background: 'var(--gz-color-border, #2c2c2c)',
          overflow: 'hidden',
          marginBottom: 6,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, Math.round(ratio * 100))}%`,
            background: overBudget ? 'var(--warning)' : 'var(--success)',
            transition: 'width 0.4s ease-out',
          }}
        />
      </div>
      <div style={{ fontSize: 12, color: 'var(--gz-color-muted, #888)' }}>
        {fmtGB(status.committedBytes)} of {fmtGB(status.budgetBytes)} used
        {filtered.length > 0 ? (
          <>
            {' · '}
            {filtered
              .map(
                (e) =>
                  `${e.replicaIdx === 0 ? '' : `${e.replicaIdx + 1}× `}${e.modelId} (${fmtGB(
                    e.residentBytes,
                  )})`,
              )
              .join(' · ')}
          </>
        ) : null}
      </div>
      <EngineMemoryBudgetPanel status={status} onSaved={refresh} />
    </div>
  );
}
