import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useRuns } from '../RunsContext.js';
import { TimelineChart } from '../components/TimelineChart.js';
import { TrialRow } from '../components/TrialRow.js';

export function ScenarioView() {
  const runs = useRuns();
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const trials = useMemo(
    () => runs.trials.filter((t) => t.scenarioId === scenarioId),
    [runs, scenarioId],
  );

  // Per-model summary: most recent composite + count
  const perModel = useMemo(() => {
    const m = new Map<
      string,
      {
        count: number;
        passed: number;
        scored: number;
        lastComposite: number | null;
        lastAt: string | null;
      }
    >();
    for (const t of trials) {
      const k = t.modelId ?? 'unknown';
      const cur = m.get(k) ?? { count: 0, passed: 0, scored: 0, lastComposite: null, lastAt: null };
      cur.count += 1;
      if (t.success) cur.passed += 1;
      if (t.composite != null) {
        cur.scored += 1;
        if (!cur.lastAt || (t.startedAt ?? '') > cur.lastAt) {
          cur.lastAt = t.startedAt ?? null;
          cur.lastComposite = t.composite;
        }
      }
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [trials]);

  return (
    <div className="scenarioview">
      <header className="scenariohead">
        <h1>Scenario · {scenarioId}</h1>
        <span className="indexmeta">{trials.length} trials</span>
      </header>

      <section className="chartsection">
        <h2>Composite over time</h2>
        <TimelineChart trials={trials} height={260} />
      </section>

      <section className="modelsummary">
        <h2>By model</h2>
        <table className="trials">
          <thead>
            <tr>
              <th>Model</th>
              <th>Trials</th>
              <th>Passed</th>
              <th>Scored</th>
              <th>Latest composite</th>
              <th>Latest run</th>
            </tr>
          </thead>
          <tbody>
            {perModel.map(([model, s]) => (
              <tr key={model}>
                <td>{model}</td>
                <td>{s.count}</td>
                <td>{s.passed}</td>
                <td>{s.scored}</td>
                <td>{s.lastComposite != null ? s.lastComposite.toFixed(1) : '—'}</td>
                <td>{s.lastAt ? new Date(s.lastAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="tablesection">
        <h2>All trials</h2>
        <table className="trials">
          <thead>
            <tr>
              <th>Score</th>
              <th>Outcome</th>
              <th>Trial</th>
              <th>Scenario</th>
              <th>Model</th>
              <th>Duration</th>
              <th>Started</th>
              <th>Kind</th>
            </tr>
          </thead>
          <tbody>
            {trials.map((t) => (
              <TrialRow key={t.trialId} trial={t} />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
