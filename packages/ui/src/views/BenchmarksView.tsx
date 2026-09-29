/**
 * Benchmarks — the in-app face of the eval harness.
 *
 * Every install can run it: the harness ships compiled beside the daemon (a
 * source checkout runs its live code instead). This view plans a run, hands
 * it to the daemon as a job, follows it while it runs, and reads back what
 * the harness recorded — scored with the published model scorecard's rules.
 *
 * Runs belong to the daemon, not to this view: closing Settings or reloading
 * the window never stops one.
 */

import type {
  EvalCatalog,
  EvalJob,
  EvalJobSpec,
  EvalTargetsResponse,
  EvalTrialSummary,
} from '@bendyline/gezel/eval';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Tabs } from '../primitives/index.js';
import './BenchmarksView.css';
import { JobPanel } from './benchmarks/JobPanel.js';
import { ResultsMatrix } from './benchmarks/ResultsMatrix.js';
import { RunPlanner } from './benchmarks/RunPlanner.js';
import { RunsList } from './benchmarks/RunsList.js';
import { TrialDetailDialog } from './benchmarks/TrialDetailDialog.js';
import { TrialsTable } from './benchmarks/TrialsTable.js';
import { isJobActive, jobTitle } from './benchmarks/format.js';

/** How often the view re-reads jobs and results while something is running. */
const ACTIVE_POLL_MS = 5_000;
const TRIAL_LIMIT = 2000;

type ResultsTab = 'scorecard' | 'trials' | 'runs';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function BenchmarksView() {
  const [catalog, setCatalog] = useState<EvalCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [targets, setTargets] = useState<EvalTargetsResponse | null>(null);
  const [jobs, setJobs] = useState<EvalJob[]>([]);
  const [trials, setTrials] = useState<EvalTrialSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ResultsTab>('scorecard');
  const [jobFilter, setJobFilter] = useState<{ id: string; title: string } | null>(null);
  const [openTrialId, setOpenTrialId] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      const [jobList, trialList] = await Promise.all([
        api.listEvalJobs(),
        api.listEvalTrials({ limit: TRIAL_LIMIT }),
      ]);
      setJobs(jobList.jobs);
      setTrials(trialList.trials);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const loadCatalog = useCallback(async (refresh = false) => {
    setCatalogError(null);
    try {
      const [nextCatalog, nextTargets] = await Promise.all([
        api.getEvalCatalog({ refresh }),
        api.listEvalTargets(),
      ]);
      setCatalog(nextCatalog);
      setTargets(nextTargets);
    } catch (err) {
      setCatalogError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void refreshRuns();
  }, [loadCatalog, refreshRuns]);

  const anyActive = jobs.some(isJobActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void refreshRuns(), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, refreshRuns]);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of targets?.targets ?? []) map.set(`${t.provider}:${t.modelId}`, t.label);
    return map;
  }, [targets]);
  const modelLabel = useCallback(
    (provider: string, modelId: string) => labels.get(`${provider}:${modelId}`) ?? modelId,
    [labels],
  );

  const onStart = useCallback(async (spec: EvalJobSpec) => {
    const job = await api.createEvalJob(spec);
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
  }, []);

  const onCancel = useCallback(async (job: EvalJob) => {
    try {
      const updated = await api.cancelEvalJob(job.id);
      setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const onJobChanged = useCallback(
    (job: EvalJob) => {
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
      if (!isJobActive(job)) void refreshRuns();
    },
    [refreshRuns],
  );

  const showJobTrials = useCallback(
    (job: EvalJob) => {
      setJobFilter({ id: job.id, title: jobTitle(job, catalog) });
      setTab('trials');
    },
    [catalog],
  );

  const openPath = window.__GEZEL__?.openPath;
  return (
    <div className="bench">
      <header className="bench-header">
        <h2>Benchmarks</h2>
        <p className="muted">
          Evaluate models on this computer with the same scenarios, grading, and scorecard rules
          gezel's own model scorecard uses. Runs continue in the background, so you can leave this
          page while one works.
        </p>
        {targets?.environment && (
          <p className="muted small">
            {targets.environment.harness === 'source'
              ? 'Using the eval harness from this source checkout. '
              : ''}
            Results are kept in <code>{targets.environment.runsDir}</code>
            {openPath && (
              <>
                {' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void openPath(targets.environment.runsDir)}
                >
                  Open
                </button>
              </>
            )}
          </p>
        )}
      </header>

      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}

      <JobPanel
        jobs={jobs}
        catalog={catalog}
        modelLabel={modelLabel}
        onJobChanged={onJobChanged}
        onCancel={onCancel}
      />

      {catalog && targets ? (
        <RunPlanner
          catalog={catalog}
          targets={targets.targets}
          imageModels={targets.imageModels}
          environment={targets.environment}
          willQueue={anyActive}
          onStart={onStart}
        />
      ) : (
        <section className="bench-section">
          <h3>Run an evaluation</h3>
          {catalogError ? (
            <>
              <p className="error small">{catalogError}</p>
              <button type="button" onClick={() => void loadCatalog(true)}>
                Try again
              </button>
            </>
          ) : (
            <p className="muted small">Loading the scenario catalog…</p>
          )}
        </section>
      )}

      <section className="bench-section" aria-labelledby="bench-results-heading">
        <div className="bench-section-heading">
          <h3 id="bench-results-heading">Results</h3>
          <button type="button" className="link-button" onClick={() => void refreshRuns()}>
            Refresh
          </button>
        </div>
        <Tabs.Root value={tab} onValueChange={(value) => setTab(value as ResultsTab)}>
          <Tabs.List aria-label="Results">
            <Tabs.Trigger value="scorecard">Scorecard</Tabs.Trigger>
            <Tabs.Trigger value="trials">Trials</Tabs.Trigger>
            <Tabs.Trigger value="runs">Runs</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="scorecard">
            <ResultsMatrix
              trials={trials}
              catalog={catalog}
              modelLabel={modelLabel}
              onOpenTrial={setOpenTrialId}
            />
          </Tabs.Content>
          <Tabs.Content value="trials">
            <TrialsTable
              trials={trials}
              modelLabel={modelLabel}
              jobFilter={jobFilter}
              onClearJobFilter={() => setJobFilter(null)}
              onOpenTrial={setOpenTrialId}
            />
          </Tabs.Content>
          <Tabs.Content value="runs">
            <RunsList
              jobs={jobs}
              catalog={catalog}
              modelLabel={modelLabel}
              onShowTrials={showJobTrials}
              onCancel={onCancel}
            />
          </Tabs.Content>
        </Tabs.Root>
      </section>

      <TrialDetailDialog
        trialId={openTrialId}
        modelLabel={modelLabel}
        onClose={() => setOpenTrialId(null)}
      />
    </div>
  );
}
