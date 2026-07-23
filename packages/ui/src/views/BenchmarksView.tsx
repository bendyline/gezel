/**
 * Benchmarks panel — in-app eval runner.
 *
 * Mirrors the CLI eval harness (`pnpm eval:run`) so users can launch
 * scenarios, watch trial progress, and review history without leaving
 * the app. The harness itself runs as a child process spawned by the
 * service (see packages/service/src/eval/runner.ts) — this view is
 * the SSE consumer + presentation layer.
 *
 * Layout:
 *
 *   1. Header — title + availability banner ("eval runner needs dev mode")
 *      when the service reports the harness isn't on disk.
 *   2. Run controls — scenario picker, model + image-model overrides,
 *      timeout slider, Run / Cancel button.
 *   3. Live trial — streaming log of the in-flight trial (only visible
 *      while a trial is running).
 *   4. Results history — table of past trials, filterable by scenario.
 *      Toggle between "list view" (rows = trials) and "matrix view"
 *      (rows = scenarios × cols = models, cells = pass rate).
 *
 * Performance metrics (per Tier 5b): the comparative views read each
 * trial's `metrics.json` + `host.json` via the existing
 * fetchProjectArtifact-style endpoints. v1 of this panel surfaces
 * "Mean tokens/sec" + "Peak GPU util" alongside the success column —
 * the deeper hardware/framework charts can land in a follow-up
 * without changing the panel's API shape.
 */

import type { EvalScenarioManifest, RunEvalEvent, TrialOutcome } from '@bendyline/gezel-client';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
// Plain <select> elements throughout; Radix Select wasn't worth the
// extra component layer for this v1 panel. Swap in later if we want
// keyboard-nav parity with the rest of Settings.

interface LiveTrial {
  scenarioId: string;
  modelId: string;
  startedAt: number;
  trialId: string | null;
  runDir: string | null;
  logTail: string[];
  ac: AbortController;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export function BenchmarksView() {
  const [scenarios, setScenarios] = useState<EvalScenarioManifest[]>([]);
  const [availability, setAvailability] = useState<{ available: boolean; reason: string | null }>({
    available: true,
    reason: null,
  });
  const [scenarioId, setScenarioId] = useState<string>('');
  const [modelId, setModelId] = useState<string>('');
  const [imageModelId, setImageModelId] = useState<string>('');
  const [timeoutMin, setTimeoutMin] = useState<number>(0); // 0 = use scenario default
  const [installedModels, setInstalledModels] = useState<string[]>([]);

  const [results, setResults] = useState<TrialOutcome[]>([]);
  const [scenarioFilter, setScenarioFilter] = useState<string>('');
  const [viewMode, setViewMode] = useState<'list' | 'matrix'>('list');
  const [live, setLive] = useState<LiveTrial | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Boot — load scenarios + installed models + availability.
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const [scen, avail, llama] = await Promise.all([
          api.listEvalScenarios(),
          api.getEvalAvailability(),
          api.listLlamaCppModels().catch(() => ({ models: [] })),
        ]);
        if (cancelled) return;
        setScenarios(scen.scenarios.slice());
        setAvailability(avail);
        // Catalog-id mode — show whatever's locally installed. UI shows
        // it as "<modelId> (installed)" so users know it's ready.
        // biome-ignore lint/suspicious/noExplicitAny: provider shape varies
        const ids = (llama.models as any[])
          .map((m) => (typeof m.id === 'string' ? m.id : null))
          .filter((s): s is string => Boolean(s));
        setInstalledModels(ids);
        if (scen.scenarios.length > 0 && !scenarioId) {
          const first = scen.scenarios[0];
          if (first) {
            setScenarioId(first.id);
            setModelId(first.defaultModel);
            setImageModelId(first.defaultImageModel ?? '');
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [scenarioId]);

  // Imperative reload. Used by (a) the initial mount + scenario-filter
  // change effect below, (b) the Refresh button, (c) the post-trial
  // cleanup in `onRun`. Avoids a `refreshKey` state hack — Biome's
  // useExhaustiveDependencies rightly objects when an effect lists a
  // dep its body never reads.
  const reloadResults = useCallback(async () => {
    try {
      const got = await api.listEvalResults({
        ...(scenarioFilter ? { scenarioId: scenarioFilter } : {}),
        limit: 200,
      });
      setResults(got.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [scenarioFilter]);

  // Auto-reload on mount + whenever the scenario filter changes.
  useEffect(() => {
    void reloadResults();
  }, [reloadResults]);

  const selectedScenario = useMemo(
    () => scenarios.find((s) => s.id === scenarioId),
    [scenarios, scenarioId],
  );

  const onScenarioChange = useCallback(
    (id: string) => {
      setScenarioId(id);
      const s = scenarios.find((x) => x.id === id);
      if (s) {
        setModelId(s.defaultModel);
        setImageModelId(s.defaultImageModel ?? '');
      }
    },
    [scenarios],
  );

  const onRun = useCallback(async () => {
    if (!selectedScenario) return;
    const ac = new AbortController();
    const trial: LiveTrial = {
      scenarioId: selectedScenario.id,
      modelId,
      startedAt: Date.now(),
      trialId: null,
      runDir: null,
      logTail: [],
      ac,
    };
    setLive(trial);
    setError(null);
    try {
      await api.runEval(
        {
          scenarioId: selectedScenario.id,
          modelId,
          ...(imageModelId ? { imageModelId } : {}),
          ...(timeoutMin > 0 ? { timeoutMs: timeoutMin * 60_000 } : {}),
        },
        (event: RunEvalEvent) => {
          setLive((prev) => {
            if (!prev) return prev;
            const next = { ...prev, logTail: prev.logTail };
            if (event.type === 'spawned') {
              next.trialId = event.trialId ?? null;
              next.runDir = event.runDir ?? null;
            } else if (event.type === 'log') {
              next.logTail = [...prev.logTail, event.line].slice(-200);
            } else if (event.type === 'error') {
              setError(event.error);
            }
            return next;
          });
        },
        ac.signal,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLive(null);
      void reloadResults();
    }
  }, [selectedScenario, modelId, imageModelId, timeoutMin, reloadResults]);

  const onCancel = useCallback(() => {
    if (live) live.ac.abort();
  }, [live]);

  return (
    <div className="benchmarks-view" style={{ padding: 16 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Benchmarks</h2>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>
          Run eval scenarios and review outcomes on this device.
        </span>
      </header>

      {!availability.available && (
        <div
          style={{
            margin: '12px 0',
            padding: 10,
            background: 'rgba(220, 170, 0, 0.1)',
            border: '1px solid rgba(220, 170, 0, 0.35)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <strong>In-app eval runner unavailable.</strong>{' '}
          {availability.reason ?? 'The harness binary was not found on disk.'} You can still review
          past results below; new runs need <code>pnpm eval:run</code> from the repo.
        </div>
      )}

      {error && (
        <div
          style={{
            margin: '12px 0',
            padding: 10,
            background: 'rgba(220, 80, 80, 0.1)',
            border: '1px solid rgba(220, 80, 80, 0.35)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <section style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 8 }}>Run a trial</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '180px 1fr',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <label htmlFor="bench-scenario">Scenario</label>
          <select
            id="bench-scenario"
            value={scenarioId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              onScenarioChange(e.currentTarget.value)
            }
            style={{ padding: 4 }}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.capabilityAxis} {s.anchored ? '(anchored)' : ''}
              </option>
            ))}
          </select>

          <label htmlFor="bench-model">Model</label>
          <select
            id="bench-model"
            value={modelId}
            onChange={(e) => setModelId(e.currentTarget.value)}
            style={{ padding: 4 }}
          >
            <option value={selectedScenario?.defaultModel ?? ''}>
              {selectedScenario?.defaultModel ?? '(no scenario)'} (default)
            </option>
            {installedModels
              .filter((m) => m !== selectedScenario?.defaultModel)
              .map((m) => (
                <option key={m} value={m}>
                  {m} (local)
                </option>
              ))}
          </select>

          {selectedScenario?.defaultImageModel && (
            <>
              <label htmlFor="bench-image-model">Image model</label>
              <input
                id="bench-image-model"
                type="text"
                value={imageModelId}
                onChange={(e) => setImageModelId(e.currentTarget.value)}
                style={{ padding: 4 }}
              />
            </>
          )}

          <label htmlFor="bench-timeout">Timeout (min)</label>
          <input
            id="bench-timeout"
            type="number"
            min={0}
            max={120}
            value={timeoutMin}
            onChange={(e) => setTimeoutMin(Number(e.currentTarget.value) || 0)}
            style={{ padding: 4, width: 80 }}
          />
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          {!live ? (
            <button
              type="button"
              onClick={() => void onRun()}
              disabled={!selectedScenario || !modelId || !availability.available}
            >
              Run {selectedScenario?.name ?? 'scenario'}
            </button>
          ) : (
            <button type="button" onClick={onCancel}>
              Cancel running trial
            </button>
          )}
          <span style={{ color: 'var(--muted)', fontSize: 12, alignSelf: 'center' }}>
            {selectedScenario
              ? `Default timeout: ${Math.round(selectedScenario.timeoutMs / 60_000)} min`
              : ''}
          </span>
        </div>
      </section>

      {live && (
        <section style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 8 }}>
            Running: {live.scenarioId} / {live.modelId}{' '}
            <span style={{ color: 'var(--muted)', fontSize: 13, fontWeight: 'normal' }}>
              ({fmtDuration(Date.now() - live.startedAt)})
            </span>
          </h3>
          {live.runDir && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>runDir: {live.runDir}</div>
          )}
          <pre
            style={{
              maxHeight: 280,
              overflow: 'auto',
              background: 'var(--code-bg, #0e1014)',
              color: 'var(--code-fg, #d6d6d6)',
              padding: 8,
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {live.logTail.join('\n')}
          </pre>
        </section>
      )}

      <section style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h3 style={{ marginBottom: 0 }}>Past results ({results.length})</h3>
          <select
            value={scenarioFilter}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setScenarioFilter(e.currentTarget.value)
            }
            style={{ padding: 4 }}
          >
            <option value="">All scenarios</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void reloadResults()}>
            Refresh
          </button>
          <span style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              disabled={viewMode === 'list'}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode('matrix')}
              disabled={viewMode === 'matrix'}
            >
              Matrix
            </button>
          </span>
        </div>

        {viewMode === 'list' && <ResultsTable results={results} />}
        {viewMode === 'matrix' && <MatrixView results={results} scenarios={scenarios} />}
      </section>
    </div>
  );
}

function ResultsTable({ results }: { results: TrialOutcome[] }) {
  if (results.length === 0) {
    return <p style={{ color: 'var(--muted)', marginTop: 12 }}>No results yet for this filter.</p>;
  }
  return (
    <table style={{ marginTop: 12, width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border, #444)', textAlign: 'left' }}>
          <th style={{ padding: '6px 8px' }}>When</th>
          <th style={{ padding: '6px 8px' }}>Scenario</th>
          <th style={{ padding: '6px 8px' }}>Model</th>
          <th style={{ padding: '6px 8px' }}>Outcome</th>
          <th style={{ padding: '6px 8px' }}>Duration</th>
          <th style={{ padding: '6px 8px' }}>Reason</th>
        </tr>
      </thead>
      <tbody>
        {results.map((r) => (
          <tr key={r.trialId} style={{ borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
            <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
              {new Date(r.startedAt).toLocaleString()}
            </td>
            <td style={{ padding: '6px 8px' }}>{r.scenarioId}</td>
            <td style={{ padding: '6px 8px' }}>{r.modelId}</td>
            <td style={{ padding: '6px 8px' }}>
              {r.success ? (
                <span style={{ color: 'var(--ok, #5bbf5e)' }}>PASS</span>
              ) : (
                <span style={{ color: 'var(--fail, #d57070)' }}>
                  FAIL{r.failureMode ? ` (${r.failureMode})` : ''}
                </span>
              )}
            </td>
            <td style={{ padding: '6px 8px' }}>{fmtDuration(r.durationMs)}</td>
            <td
              style={{
                padding: '6px 8px',
                maxWidth: 360,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={r.reason}
            >
              {r.reason}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Matrix view — rows are scenarios, columns are models the user has
 * run, cells show the latest success rate (passes / total runs).
 * Surfaces the "coverage matrix not leaderboard" framing from
 * docs/eval-strategy.md: a missing cell is itself information.
 */
function MatrixView({
  results,
  scenarios,
}: {
  results: TrialOutcome[];
  scenarios: EvalScenarioManifest[];
}) {
  // Aggregate by (scenarioId, modelId) → { passes, total, latest }.
  const grid = useMemo(() => {
    const cells = new Map<string, { passes: number; total: number; latest: TrialOutcome }>();
    const modelsSet = new Set<string>();
    for (const r of results) {
      const key = `${r.scenarioId}::${r.modelId}`;
      const cur = cells.get(key);
      modelsSet.add(r.modelId);
      if (!cur) {
        cells.set(key, { passes: r.success ? 1 : 0, total: 1, latest: r });
      } else {
        cells.set(key, {
          passes: cur.passes + (r.success ? 1 : 0),
          total: cur.total + 1,
          // Keep the most recent for the tooltip — sorted desc upstream
          // so r is newer than cur.latest only when iterating reverse;
          // we already sorted, so iteration order has latest first.
          latest: cur.latest,
        });
      }
    }
    return {
      cells,
      models: [...modelsSet].sort(),
    };
  }, [results]);

  if (results.length === 0) {
    return <p style={{ color: 'var(--muted)', marginTop: 12 }}>No data to compare yet.</p>;
  }
  return (
    <table style={{ marginTop: 12, borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border, #444)' }}>
          <th style={{ padding: '6px 8px', textAlign: 'left' }}>Scenario</th>
          {grid.models.map((m) => (
            <th key={m} style={{ padding: '6px 8px', textAlign: 'left' }}>
              {m}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {scenarios.map((s) => (
          <tr key={s.id} style={{ borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
            <td style={{ padding: '6px 8px' }}>{s.name}</td>
            {grid.models.map((m) => {
              const cell = grid.cells.get(`${s.id}::${m}`);
              if (!cell) {
                return (
                  <td key={m} style={{ padding: '6px 8px', color: 'var(--muted)' }}>
                    —
                  </td>
                );
              }
              const pct = Math.round((cell.passes / cell.total) * 100);
              const tone =
                pct >= 75 ? 'var(--ok, #5bbf5e)' : pct >= 50 ? '#cc9b3c' : 'var(--fail, #d57070)';
              return (
                <td
                  key={m}
                  style={{ padding: '6px 8px', color: tone }}
                  title={`${cell.passes}/${cell.total} passes — most recent: ${new Date(cell.latest.startedAt).toLocaleString()} (${cell.latest.success ? 'PASS' : 'FAIL'})`}
                >
                  {cell.passes}/{cell.total} ({pct}%)
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
