import {
  type ScorecardDataset,
  type ScorecardDevice,
  describeProvenance,
  measuredClaim,
  measuredResultFor,
  measuredRowsFor,
  scorecardHardwareKey,
  scorecardHardwareLabel,
} from '@bendyline/gezel';
import type { ModelFitnessEntry } from '@bendyline/gezel-client';

/**
 * The second half of `gezel doctor`: not whether the service runs, but
 * whether the model it will use can do the work. Two sources, kept apart
 * because they answer different questions. The fitness check (the proeve)
 * says whether the model works mechanically on this machine — it spawns,
 * answers a tool call, decodes fast enough, has room for a prompt. The
 * scorecard says how often it finishes real jobs, measured on hardware that
 * is named beside every number.
 */

export interface DoctorModelInput {
  provider: string;
  modelId: string | undefined;
  fitness: ModelFitnessEntry | undefined;
  /** True while a probe for this model is running. */
  probing: boolean;
  dataset: ScorecardDataset;
  device: Pick<ScorecardDevice, 'platform' | 'arch' | 'label'>;
  /** How many published rows to list below the headline. */
  rows?: number;
}

const CHECK_LABELS: Record<keyof ModelFitnessEntry['record']['checks'], string> = {
  spawn: 'starts',
  toolRoundTrip: 'answers a tool call',
  throughput: 'decodes fast enough',
  reasoningBudget: 'bounded reasoning',
  contextFit: 'room for a prompt',
};

export function renderFitness(entry: ModelFitnessEntry | undefined, probing: boolean): string[] {
  if (probing) return ['fitness check: running now'];
  if (!entry) {
    return [
      'fitness check: not run yet — Gezel runs it when a model is installed, or from Settings → Models',
    ];
  }
  const { record } = entry;
  const head =
    record.status === 'probed'
      ? record.admitted
        ? 'fitness check: passed'
        : 'fitness check: FAILED'
      : `fitness check: ${record.status}`;
  const qualifiers = [
    entry.stale ? 'the model changed since; treat as not run' : '',
    entry.hardwareChanged ? "this machine's memory changed since" : '',
    record.genTokensPerSec ? `${record.genTokensPerSec.toFixed(1)} tok/s` : '',
    record.createdAt ? record.createdAt.slice(0, 10) : '',
  ].filter(Boolean);
  const lines = [`${head}${qualifiers.length ? ` (${qualifiers.join(', ')})` : ''}`];
  for (const key of Object.keys(CHECK_LABELS) as Array<keyof typeof CHECK_LABELS>) {
    const check = record.checks[key];
    if (!check) continue;
    lines.push(`  ${check.ok ? 'ok ' : 'NO '} ${CHECK_LABELS[key].padEnd(20)} ${check.detail}`);
  }
  return lines;
}

/**
 * Whether the published scorecard has anything from this kind of machine —
 * for this model, and at all. A number measured on another platform is a
 * weaker guide, and the reader should know which they are looking at.
 */
export function hardwareClassCoverage(
  dataset: ScorecardDataset,
  modelId: string,
  device: Pick<ScorecardDevice, 'platform' | 'arch' | 'label'>,
): string {
  const key = scorecardHardwareKey(device);
  const name = scorecardHardwareLabel(device);
  const rounds = dataset.runs.filter(
    (run) => run.scope !== 'subset' && scorecardHardwareKey(run.provenance.device) === key,
  ).length;
  const mine = measuredRowsFor(dataset, modelId).filter(
    (row) => scorecardHardwareKey(row.run.provenance.device) === key,
  ).length;
  if (rounds === 0) {
    return `  on ${name}: no published scorecard round has run on ${name} yet — \`gezel bench\` would be the first`;
  }
  const roundWord = rounds === 1 ? 'round' : 'rounds';
  if (mine === 0) {
    return `  on ${name}: ${rounds} published ${roundWord}, none with this model — \`gezel bench\` measures it here`;
  }
  return `  on ${name}: ${rounds} published ${roundWord}; ${mine} ${mine === 1 ? 'result' : 'results'} for this model`;
}

export function renderMeasured(
  dataset: ScorecardDataset,
  modelId: string,
  device: Pick<ScorecardDevice, 'platform' | 'arch' | 'label'>,
  rows = 4,
): string[] {
  const headline = measuredResultFor(dataset, modelId, device);
  const coverage = hardwareClassCoverage(dataset, modelId, device);
  if (!headline) {
    return [
      'measured: not measured in a published round — `gezel bench` measures it on this machine',
      coverage,
    ];
  }
  const lines = [
    `measured: ${measuredClaim(headline)}${headline.sameHardwareClass ? '' : ' — a different platform; your numbers may differ'}`,
    coverage,
  ];
  for (const row of measuredRowsFor(dataset, modelId).slice(0, rows)) {
    lines.push(
      `  ${row.result.suiteId.padEnd(14)} ${row.score.claim.padEnd(36)} ${describeProvenance(row.run, [row.result.engine])}`,
    );
  }
  lines.push('  Full tables: https://gezel.com/docs/model-scorecard/');
  return lines;
}

/** Everything `gezel doctor` says about the model chats will use. */
export function renderDoctorModel(input: DoctorModelInput): string[] {
  if (!input.modelId) {
    return [
      `model: none for ${input.provider}`,
      '  `gezel model list --available` shows what fits this machine; `gezel model pull <id>` downloads one.',
    ];
  }
  const lines = [`model: ${input.modelId} (${input.provider})`];
  for (const line of renderFitness(input.fitness, input.probing)) lines.push(`  ${line}`);
  for (const line of renderMeasured(input.dataset, input.modelId, input.device, input.rows)) {
    lines.push(`  ${line}`);
  }
  return lines;
}

export interface DoctorVerdictInput {
  nodeOk: boolean;
  serviceReachable: boolean;
  modelId: string | undefined;
  fitnessAdmitted: boolean | null;
}

/** One sentence at the end: what works, what is missing, what to run next. */
export function doctorVerdict(input: DoctorVerdictInput): string {
  if (!input.nodeOk) return 'Verdict: install Node.js 24 or newer, then run `gezel doctor` again.';
  if (!input.serviceReachable) {
    return 'Verdict: Gezel is installed but no service is running. `gezel start` starts one; `gezel run "hello"` starts one and sends a message.';
  }
  if (!input.modelId) {
    return 'Verdict: the service runs but has no model to chat with. `gezel model list --available` shows what fits; `gezel model pull <id>` downloads one.';
  }
  if (input.fitnessAdmitted === false) {
    return `Verdict: ${input.modelId} failed its fitness check on this machine. Pick a smaller model with \`gezel model list --available\`, or re-run the check from Settings → Models.`;
  }
  return `Verdict: ready. ${input.modelId} is installed and ${
    input.fitnessAdmitted ? 'passed its fitness check' : 'has not been fitness-checked yet'
  }; \`gezel run "hello"\` to talk to it, \`gezel bench\` to measure it.`;
}
