import { useMemo, useState } from 'react';
import { useRuns } from '../RunsContext.js';
import { TimelineChart } from '../components/TimelineChart.js';
import { TrialRow } from '../components/TrialRow.js';

export function IndexView() {
  const runs = useRuns();
  const [scenario, setScenario] = useState<string>('all');
  const [model, setModel] = useState<string>('all');
  const [outcome, setOutcome] = useState<'all' | 'pass' | 'fail'>('all');
  const [scoredOnly, setScoredOnly] = useState(false);

  const filtered = useMemo(() => {
    return runs.trials.filter((t) => {
      if (scenario !== 'all' && t.scenarioId !== scenario) return false;
      if (model !== 'all' && t.modelId !== model) return false;
      if (outcome === 'pass' && !t.success) return false;
      if (outcome === 'fail' && t.success) return false;
      if (scoredOnly && t.composite == null) return false;
      return true;
    });
  }, [runs, scenario, model, outcome, scoredOnly]);

  // Group trials by day for the table
  const byDay = useMemo(() => {
    const m = new Map<string, typeof filtered>();
    for (const t of filtered) {
      const k = t.dayKey ?? 'unknown';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  return (
    <div className="indexview">
      <section className="filters">
        <label>
          Scenario
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            <option value="all">all</option>
            {runs.scenarios.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="all">all</option>
            {runs.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as 'all' | 'pass' | 'fail')}
          >
            <option value="all">all</option>
            <option value="pass">pass</option>
            <option value="fail">fail</option>
          </select>
        </label>
        <label className="checkboxlabel">
          <input
            type="checkbox"
            checked={scoredOnly}
            onChange={(e) => setScoredOnly(e.target.checked)}
          />
          scored only
        </label>
        <span className="filtercount">
          {filtered.length} / {runs.trials.length}
        </span>
      </section>

      <section className="chartsection">
        <h2>Composite over time</h2>
        <TimelineChart trials={filtered} />
      </section>

      <section className="tablesection">
        <h2>Trials</h2>
        {byDay.map(([day, list]) => (
          <div key={day} className="daygroup">
            <h3 className="dayhead">
              {day} <span className="daycount">({list.length})</span>
            </h3>
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
                {list.map((t) => (
                  <TrialRow key={t.trialId} trial={t} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
    </div>
  );
}
