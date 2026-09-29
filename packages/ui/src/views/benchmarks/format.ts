import type {
  EvalCatalog,
  EvalJob,
  EvalJobSpec,
  EvalProviderId,
  EvalRequirement,
  EvalTrialSummary,
} from '@bendyline/gezel/eval';

export const PROVIDER_LABELS: Record<EvalProviderId, string> = {
  mlx: 'MLX',
  'llama-cpp': 'llama.cpp',
  ds4: 'DwarfStar',
  'apple-foundation-models': 'Apple on-device',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'anthropic-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
  copilot: 'GitHub Copilot',
};

export function providerLabel(provider: string | undefined): string {
  return provider ? (PROVIDER_LABELS[provider as EvalProviderId] ?? provider) : 'Unknown engine';
}

export function targetKey(target: { provider?: string; modelId: string }): string {
  return `${target.provider ?? 'unknown'}:${target.modelId}`;
}

/** "2h 05m", "14m", "45s" — for ceilings and trial durations. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export const JOB_STATUS_LABELS: Record<EvalJob['status'], string> = {
  queued: 'Queued',
  'waiting-for-device': 'Waiting for the device',
  running: 'Running',
  completed: 'Finished',
  failed: 'Could not run',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
};

export function isJobActive(job: EvalJob): boolean {
  return job.status === 'queued' || job.status === 'waiting-for-device' || job.status === 'running';
}

/** Short title for a job: the suite, or how many scenarios it picked. */
export function jobTitle(job: EvalJob, catalog: EvalCatalog | null): string {
  const picked = job.spec.scenarioIds ?? [];
  if (job.spec.suiteId) {
    const suite = catalog?.suites.find((s) => s.id === job.spec.suiteId);
    const subset =
      picked.length > 0 && suite && picked.length < suite.scenarioIds.length
        ? ` (${picked.length} of ${suite.scenarioIds.length})`
        : '';
    return `${job.spec.suiteId} suite${subset}`;
  }
  if (picked.length === 1) return picked[0] ?? '';
  return `${picked.length} scenarios`;
}

export type TrialOutcome = 'running' | 'passed' | 'failed' | 'not-counted' | 'interrupted';

/**
 * How a trial reads to a person. "Not counted" is any failure the scorecard
 * leaves out of the model's rate: the engine, the grader, or a stop.
 */
export function trialOutcome(trial: EvalTrialSummary): TrialOutcome {
  if (trial.running) return 'running';
  if (trial.success === undefined) return 'interrupted';
  if (trial.success) return 'passed';
  if (trial.failureClass && trial.failureClass !== 'model') return 'not-counted';
  return 'failed';
}

export const OUTCOME_LABELS: Record<TrialOutcome, string> = {
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  'not-counted': 'Not counted',
  interrupted: 'Stopped early',
};

export const FAILURE_CLASS_EXPLANATIONS: Record<string, string> = {
  model: 'Counts against the model.',
  infra: 'Not counted: the engine or the trial daemon failed, not the model.',
  grader: 'Not counted: this computer could not grade the result.',
  operator: 'Not counted: the run was stopped.',
};

export const BAND_LABELS: Record<string, string> = {
  'ship-ready': 'Ship-ready',
  'needs-tuning': 'Needs tuning',
  'framework-gap': 'Framework gap',
};

/**
 * What a requirement means when this install cannot meet it, as the
 * predicate of a sentence whose subject is one or more scenario names.
 */
export function requirementGap(requirement: EvalRequirement, count: number): string {
  const one = count === 1;
  switch (requirement) {
    case 'image-model':
      return `${one ? 'needs' : 'need'} an image model — install one under Image generation first`;
    case 'embeddings':
      return `${one ? 'needs' : 'need'} the embedding engine`;
    case 'docblocks':
      return `${one ? 'needs' : 'need'} the DocBlocks command-line tools, which only a developer setup has`;
    case 'chromium':
      return `${one ? 'is' : 'are'} graded in a browser that is not installed yet, so ${one ? 'it' : 'they'} will finish as not counted`;
    case 'vitest':
      return `${one ? 'is' : 'are'} graded by a test runner that only a gezel source checkout includes, so ${one ? 'it' : 'they'} will finish as not counted`;
    case 'network':
      return `${one ? 'uses' : 'use'} the internet`;
    case 'external-checkout':
      return `${one ? 'needs' : 'need'} a source checkout that only a developer machine has`;
  }
}

/** The scenarios a spec selects, in run order. */
export function selectedScenarioIds(
  spec: Pick<EvalJobSpec, 'suiteId' | 'scenarioIds'>,
  catalog: EvalCatalog,
): string[] {
  const suite = spec.suiteId ? catalog.suites.find((s) => s.id === spec.suiteId) : undefined;
  if (suite) {
    const subset = new Set(spec.scenarioIds ?? []);
    return subset.size > 0
      ? suite.scenarioIds.filter((id) => subset.has(id))
      : [...suite.scenarioIds];
  }
  return [...(spec.scenarioIds ?? [])];
}
