import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { useRuns, useRunsMeta } from './RunsContext.js';
import { IndexView } from './views/IndexView.js';
import { ScenarioView } from './views/ScenarioView.js';
import { TrialView } from './views/TrialView.js';

function updatedAtLabel(lastUpdated: number | null): string {
  if (lastUpdated == null) return 'static snapshot';
  const hhmm = new Date(lastUpdated).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Updated at ${hhmm}`;
}

export function App() {
  const runs = useRuns();
  const { lastUpdated } = useRunsMeta();
  const live = lastUpdated != null;
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Gezel Eval Viewer
        </Link>
        <nav className="navlinks">
          <NavLink to="/" end>
            Runs
          </NavLink>
          {runs.scenarios.map((s) => (
            <NavLink key={s} to={`/scenario/${s}`}>
              {s}
            </NavLink>
          ))}
        </nav>
        <span className="indexmeta">
          <span
            className={live ? 'liveDot liveDot--on' : 'liveDot'}
            title={live ? 'live' : 'static'}
          >
            ●
          </span>{' '}
          {runs.counts.running > 0 ? `${runs.counts.running} running · ` : ''}
          {runs.counts.trials} trials · {runs.counts.scored} scored · {runs.counts.passed} passed ·{' '}
          {updatedAtLabel(lastUpdated)}
        </span>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<IndexView />} />
          <Route path="/scenario/:scenarioId" element={<ScenarioView />} />
          <Route path="/trial/:trialId" element={<TrialView />} />
          <Route
            path="*"
            element={
              <div className="empty">
                Not found. <Link to="/">Back home</Link>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
