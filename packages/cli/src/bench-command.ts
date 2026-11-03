import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ScorecardDataset, ScorecardModelResult, ScorecardRun } from '@bendyline/gezel';
import { ScorecardDatasetSchema } from '@bendyline/gezel';
import { gildePackageRoot } from '@bendyline/gezel-catalog';
import type { GezelClient } from '@bendyline/gezel-client';
import {
  EVAL_SUBSET_NOTE,
  type EvalCatalog,
  type EvalCatalogSuite,
  type EvalJob,
  type EvalJobSpec,
  type EvalTarget,
  type EvalTrialSummary,
  SCORECARD_SUITE_IDS,
  SCORECARD_SUITE_LABELS,
  buildEvalMatrix,
  describeEvalHost,
  describeEvalRun,
  evalDeviceFromHost,
  evalEngineBuilds,
  evalRunId,
  evalRunProvenance,
  evalShard,
  evalSuiteResult,
  isSuiteSubset,
  medianDecodeTokensPerSec,
  smokeSuiteIdFor,
} from '@bendyline/gezel/eval';
import type { Command } from 'commander';
import { CliError } from './connection.js';

/**
 * `gezel bench …`: run the published model scorecard's suites on this
 * machine, through the daemon's eval runner — the same scenarios, grading
 * and counting rules as Settings → Benchmarks and the Handboek's scorecard.
 *
 * A thin client, deliberately. The harness owns trial orchestration and
 * grading; the daemon owns the job; this command plans, follows, and
 * reports. The report uses the scorecard's own matrix, so a count here and
 * a count in the app can never disagree.
 */

export type BenchClient = Pick<
  GezelClient,
  | 'getEvalCatalog'
  | 'listEvalTargets'
  | 'listEvalJobs'
  | 'createEvalJob'
  | 'getEvalJob'
  | 'streamEvalJob'
  | 'listEvalTrials'
  | 'getSystemDiagnostics'
>;

export interface BenchIo {
  /** Where the report goes (stdout). */
  out: (line: string) => void;
  /** Where progress and notes go (stderr). */
  note: (line: string) => void;
  /** Ask before an expensive run; absent when there is no terminal to ask. */
  confirm?: (question: string) => Promise<boolean>;
  /** The machine's CPU, when the daemon is on this machine. */
  cpuModel?: () => string | undefined;
  gildeVersion?: () => string;
  now?: () => Date;
}

/** Runs longer than this ask before starting. */
export const BENCH_CONFIRM_ABOVE_MS = 60 * 60_000;

/** Keep the repo's issue address in one place. */
export const BENCH_SUBMIT_REPO = 'bendyline/gezel';

export interface BenchRunOptions {
  suite?: string;
  smoke?: boolean;
  model?: string;
  provider?: string;
  count?: number;
  json?: string;
  yes?: boolean;
  note?: string;
  verbose?: boolean;
}

export interface BenchPlan {
  suites: EvalCatalogSuite[];
  target: EvalTarget;
  count: number;
  /** Sum of authored ceilings × trials, before `suggestedTrials` caps. */
  worstCaseMs: number;
  /** Suites being run through their smoke variant. */
  smoke: boolean;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Resolve `--suite` (one id, `all`, or absent → `core`) against the catalog. */
export function resolveBenchSuites(
  catalog: EvalCatalog,
  opts: BenchRunOptions,
): EvalCatalogSuite[] {
  const wanted =
    !opts.suite || opts.suite === 'core' || opts.suite === 'default'
      ? ['core']
      : opts.suite === 'all'
        ? // Every scorecard suite this daemon's catalog carries; an older
          // harness without one of them still runs the rest.
          SCORECARD_SUITE_IDS.filter((id) => catalog.suites.some((s) => s.id === id))
        : opts.suite
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  const suites: EvalCatalogSuite[] = [];
  for (const id of wanted) {
    const base = catalog.suites.find((s) => s.id === id);
    if (!base) {
      throw new CliError(
        `Unknown suite "${id}". Choose one of: ${SCORECARD_SUITE_IDS.join(', ')}, or all. \`gezel bench list\` shows every suite.`,
      );
    }
    if (opts.smoke) {
      const smokeId = smokeSuiteIdFor(id, catalog);
      const smoke = smokeId ? catalog.suites.find((s) => s.id === smokeId) : undefined;
      if (!smoke) {
        throw new CliError(`The ${id} suite has no smoke variant in this catalog.`);
      }
      suites.push(smoke);
    } else {
      suites.push(base);
    }
  }
  return suites;
}

/** The (provider, model) to measure: explicit flags, else the install's default. */
export function resolveBenchTarget(
  catalog: EvalCatalog,
  targets: readonly EvalTarget[],
  opts: Pick<BenchRunOptions, 'model' | 'provider'>,
): EvalTarget {
  const available = targets.filter((t) => t.available);
  if (opts.model) {
    const matches = available.filter(
      (t) => t.modelId === opts.model && (!opts.provider || t.provider === opts.provider),
    );
    const preferred = matches.find((t) => t.provider === catalog.defaultProvider) ?? matches[0];
    if (preferred) return preferred;
    const unavailable = targets.find(
      (t) => t.modelId === opts.model && (!opts.provider || t.provider === opts.provider),
    );
    throw new CliError(
      unavailable?.unavailableReason
        ? `${opts.model} can't run here: ${unavailable.unavailableReason}`
        : `No model "${opts.model}"${opts.provider ? ` on ${opts.provider}` : ''} is available to evaluate. \`gezel model list\` shows what is installed.`,
    );
  }
  const byProvider = opts.provider
    ? available.filter((t) => t.provider === opts.provider)
    : available;
  const chosen =
    byProvider.find((t) => t.isDefault && t.provider === catalog.defaultProvider) ??
    byProvider.find((t) => t.isDefault) ??
    byProvider.find((t) => t.provider === catalog.defaultProvider) ??
    byProvider[0];
  if (!chosen) {
    throw new CliError(
      'No model is available to evaluate. Download one with `gezel model pull <id>` or sign in to a cloud provider, then try again.',
    );
  }
  return chosen;
}

export function planBench(
  catalog: EvalCatalog,
  targets: readonly EvalTarget[],
  opts: BenchRunOptions,
): BenchPlan {
  const count = opts.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new CliError(
      '--count must be a whole number from 1 to 10 (3 is what it takes to quote a rate).',
    );
  }
  const suites = resolveBenchSuites(catalog, opts);
  const target = resolveBenchTarget(catalog, targets, opts);
  const worstCaseMs = suites.reduce((sum, s) => sum + s.authoredCeilingMs * count, 0);
  return { suites, target, count, worstCaseMs, smoke: Boolean(opts.smoke) };
}

export function describePlan(plan: BenchPlan, catalog: EvalCatalog): string[] {
  const lines = [
    `Model: ${plan.target.label} (${plan.target.modelId} on ${plan.target.provider})`,
    `Trials per task: ${plan.count}${
      plan.count < catalog.minTrialsForRate
        ? ` — results show as counts; ${catalog.minTrialsForRate} trials is what it takes to quote a rate`
        : ''
    }`,
  ];
  for (const suite of plan.suites) {
    lines.push(
      `Suite: ${suite.id} — ${suite.scenarioIds.length} tasks, at most ${formatDuration(
        suite.authoredCeilingMs * plan.count,
      )}`,
    );
    if (plan.smoke) lines.push(`  ${suite.description}`);
  }
  lines.push(
    `At most ${formatDuration(plan.worstCaseMs)} in all. The run keeps going if this terminal closes.`,
  );
  return lines;
}

/** Why a job did not run to completion, in words a person can act on. */
export function describeJobOutcome(job: EvalJob): string | null {
  switch (job.status) {
    case 'completed':
      return null;
    case 'failed':
      return `The run could not start: ${job.error ?? 'the harness reported a setup error'}.`;
    case 'cancelled':
      return 'The run was stopped before it finished.';
    case 'interrupted':
      return 'The Gezel service stopped while the run was in progress; the trials it finished are counted.';
    default:
      return `The run ended in state "${job.status}".`;
  }
}

/** A scenario-by-scenario table for one suite, with the suite's own claim. */
export function renderSuiteReport(
  suite: EvalCatalogSuite,
  target: Pick<EvalTarget, 'provider' | 'modelId'>,
  trials: readonly EvalTrialSummary[],
  minTrialsForRate: number,
): string[] {
  const matrix = buildEvalMatrix(trials, { scenarioOrder: suite.scenarioIds });
  const column = matrix.columns.find(
    (c) => c.modelId === target.modelId && (c.provider ?? target.provider) === target.provider,
  );
  const width = Math.min(40, Math.max(12, ...suite.scenarioIds.map((id) => id.length)) + 2);
  const lines: string[] = [];
  for (const scenarioId of suite.scenarioIds) {
    const cell = column ? matrix.cell(scenarioId, column.key) : undefined;
    const claim = cell ? cell.claim : 'not run';
    const extra = cell?.nonModelFailures
      ? `  (${cell.nonModelFailures} not counted: not the model's fault)`
      : '';
    lines.push(`  ${scenarioId.padEnd(width)}${claim}${extra}`);
  }
  const total = column ? column.claim : 'not measured';
  const label = SCORECARD_SUITE_LABELS[suite.id as keyof typeof SCORECARD_SUITE_LABELS] ?? suite.id;
  lines.push(`  ${'suite'.padEnd(width)}${total}`);
  if (column && column.passRate === null && column.attributableTrials > 0) {
    lines.push(
      `  A count, not a rate: ${minTrialsForRate} trials per task is the floor for quoting a percentage.`,
    );
  }
  const decode = medianDecodeTokensPerSec(trials);
  lines.push(
    `  Decode: ${decode ? `${decode.toFixed(1)} tok/s (median over finished tasks)` : 'not recorded'}. Prefill: not recorded by the daemon's trial index.`,
  );
  return [`${label} (${suite.id})`, ...lines];
}

interface JobFollower {
  /** Called on every job update; returns lines to print. */
  update(job: EvalJob): string[];
}

/** Turns job snapshots into progress lines, printing each change once. */
export function createJobFollower(suite: EvalCatalogSuite, count: number): JobFollower {
  let lastTrial: string | null = null;
  let lastCompleted = -1;
  let announcedWaiting = false;
  let announcedPreflight = false;
  return {
    update(job) {
      const lines: string[] = [];
      const target = job.targets[0];
      if (job.status === 'waiting-for-device' && !announcedWaiting) {
        announcedWaiting = true;
        lines.push(
          `Waiting: another evaluation${job.waitingOn ? ` (${job.waitingOn})` : ''} holds this machine's engines.`,
        );
      }
      if (!target) return lines;
      if (target.preflight && !announcedPreflight) {
        announcedPreflight = true;
        const p = target.preflight;
        lines.push(
          p.admitted === null
            ? `Fitness check skipped${p.skippedReason ? `: ${p.skippedReason}` : ''}.`
            : p.admitted
              ? `Fitness check passed${p.decodeTokensPerSec ? ` · ${p.decodeTokensPerSec.toFixed(1)} tok/s` : ''}.`
              : `Fitness check failed${p.skippedReason ? `: ${p.skippedReason}` : ''}.`,
        );
      }
      const planned = target.plannedTrials ?? suite.scenarioIds.length * count;
      if (target.completedTrials !== lastCompleted && lastCompleted >= 0) {
        lines.push(`  ${target.completedTrials}/${planned} done, ${target.passedTrials} passed`);
      }
      lastCompleted = target.completedTrials;
      const current = target.currentTrial;
      if (current && current.trialId !== lastTrial) {
        lastTrial = current.trialId;
        lines.push(`  ${current.scenarioId} (${current.trialIndex}/${planned}) running…`);
      }
      return lines;
    },
  };
}

function finishedJob(job: EvalJob): boolean {
  return (
    job.status === 'completed' ||
    job.status === 'failed' ||
    job.status === 'cancelled' ||
    job.status === 'interrupted'
  );
}

/** Follow a job to its end, printing progress; returns the final record. */
export async function followJob(
  client: BenchClient,
  job: EvalJob,
  suite: EvalCatalogSuite,
  count: number,
  io: Pick<BenchIo, 'note'>,
  verbose = false,
): Promise<EvalJob> {
  const follower = createJobFollower(suite, count);
  let latest = job;
  for (const line of follower.update(job)) io.note(line);
  await client.streamEvalJob(job.id, (event) => {
    if (event.type === 'log') {
      if (verbose) io.note(`    ${event.line}`);
      return;
    }
    latest = event.job;
    for (const line of follower.update(event.job)) io.note(line);
  });
  if (!finishedJob(latest)) latest = await client.getEvalJob(job.id);
  return latest;
}

/** The catalog pin this install resolves, read from the gilde package itself. */
function defaultGildeVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(gildePackageRoot(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function defaultCpuModel(): string | undefined {
  return cpus()[0]?.model?.trim() || undefined;
}

export interface BenchRunReport {
  run: ScorecardRun;
  results: ScorecardModelResult[];
  jobs: EvalJob[];
  shard: ScorecardDataset;
}

/** The whole `gezel bench` run: plan, confirm, queue, follow, report, save. */
export async function runBench(
  client: BenchClient,
  opts: BenchRunOptions,
  io: BenchIo,
): Promise<BenchRunReport> {
  const [catalog, targetsResponse, host] = await Promise.all([
    client.getEvalCatalog(),
    client.listEvalTargets(),
    client.getSystemDiagnostics(),
  ]);
  const plan = planBench(catalog, targetsResponse.targets, opts);
  const cpuModel = io.cpuModel ? io.cpuModel() : undefined;
  io.note(describeEvalHost(host, cpuModel));
  for (const line of describePlan(plan, catalog)) io.note(line);

  if (plan.worstCaseMs > BENCH_CONFIRM_ABOVE_MS && !opts.yes) {
    if (!io.confirm) {
      throw new CliError(
        `This run could take ${formatDuration(plan.worstCaseMs)}. Add --yes to start it without a prompt.`,
      );
    }
    const go = await io.confirm(`Start a run of up to ${formatDuration(plan.worstCaseMs)}? [y/N] `);
    if (!go) throw new CliError('Not started.');
  }

  const startedAt = (io.now?.() ?? new Date()).toISOString();
  const device = evalDeviceFromHost(host, cpuModel);
  const scenariosBySuite: Record<string, readonly string[]> = {};
  const jobs: EvalJob[] = [];
  const results: ScorecardModelResult[] = [];
  const runId = evalRunId(startedAt, device, plan.target.modelId);
  const gildeVersion = (io.gildeVersion ?? defaultGildeVersion)();
  const run = evalRunProvenance({
    id: runId,
    startedAt,
    device,
    gezelVersion: host.version,
    gildeVersion,
    count: plan.count,
    engineBuilds: evalEngineBuilds(host),
    scenariosBySuite: Object.fromEntries(plan.suites.map((s) => [s.id, s.scenarioIds])),
    subset: false,
    ...(opts.note ? { note: opts.note } : {}),
  });

  for (const suite of plan.suites) {
    const spec: EvalJobSpec = {
      suiteId: suite.id,
      count: plan.count,
      ...(plan.count > 1 ? { countStrict: true } : {}),
      targets: [{ provider: plan.target.provider, modelId: plan.target.modelId }],
      note: `gezel bench ${runId}`,
    };
    io.note('');
    io.note(`Starting ${suite.id}…`);
    const created = await client.createEvalJob(spec);
    const job = await followJob(client, created, suite, plan.count, io, opts.verbose);
    jobs.push(job);
    scenariosBySuite[suite.id] = suite.scenarioIds;
    const outcome = describeJobOutcome(job);
    if (outcome) io.note(outcome);
    const { trials } = await client.listEvalTrials({ jobId: job.id, limit: 2000 });
    results.push(evalSuiteResult({ run, suite, target: plan.target, trials }));
    io.out('');
    for (const line of renderSuiteReport(suite, plan.target, trials, catalog.minTrialsForRate)) {
      io.out(line);
    }
    if (plan.smoke) io.out(`  ${suite.description}`);
  }

  io.out('');
  io.out(describeEvalRun(run, [plan.target.provider]));
  io.out(
    `Results are kept in ${targetsResponse.environment.runsDir}; Settings → Benchmarks shows the same runs.`,
  );
  const shard = evalShard(run, results);
  if (opts.json) {
    await writeFile(opts.json, `${JSON.stringify(shard, null, 2)}\n`, 'utf8');
    io.out(`Wrote ${opts.json}. Share it with \`gezel bench submit ${opts.json}\`.`);
  }
  return { run, results, jobs, shard };
}

/** `gezel bench list`: every suite, its size and its planning time. */
export function renderSuiteList(catalog: EvalCatalog): string[] {
  const width = Math.max(...catalog.suites.map((s) => s.id.length)) + 2;
  const lines = [
    'Suites (`gezel bench --suite <id>`); times are the authored ceilings at one trial per task:',
  ];
  const scorecard = catalog.suites.filter((s) =>
    (SCORECARD_SUITE_IDS as readonly string[]).includes(s.id),
  );
  const rest = catalog.suites.filter((s) => !scorecard.includes(s));
  for (const suite of [...scorecard, ...rest]) {
    const label = SCORECARD_SUITE_LABELS[suite.id as keyof typeof SCORECARD_SUITE_LABELS];
    lines.push(
      `  ${suite.id.padEnd(width)}${String(suite.scenarioIds.length).padStart(2)} tasks  ${formatDuration(
        suite.authoredCeilingMs,
      ).padStart(7)}  ${label ?? suite.description}`,
    );
  }
  lines.push(
    '',
    `The published scorecard runs ${SCORECARD_SUITE_IDS.join(', ')}. Add --smoke for a suite's pulse check; it is not a suite score.`,
  );
  return lines;
}

/** `gezel bench results`: finished jobs on this machine, newest first. */
export async function renderResults(
  client: BenchClient,
  catalog: EvalCatalog,
  limit: number,
): Promise<string[]> {
  const { jobs } = await client.listEvalJobs();
  const finished = jobs.filter(finishedJob).slice(0, limit);
  if (finished.length === 0)
    return ['No finished runs on this machine yet. `gezel bench` starts one.'];
  const lines: string[] = [];
  for (const job of finished) {
    const suite = job.spec.suiteId
      ? catalog.suites.find((s) => s.id === job.spec.suiteId)
      : undefined;
    const target = job.targets[0];
    const { trials } = await client.listEvalTrials({ jobId: job.id, limit: 2000 });
    const order = suite?.scenarioIds ?? [...new Set(trials.map((t) => t.scenarioId))];
    const matrix = buildEvalMatrix(trials, { scenarioOrder: order });
    const column = target
      ? matrix.columns.find(
          (c) =>
            c.modelId === target.modelId && (c.provider ?? target.provider) === target.provider,
        )
      : matrix.columns[0];
    const subset =
      suite && job.spec.scenarioIds ? isSuiteSubset(suite, job.spec.scenarioIds) : false;
    const what = suite
      ? `${suite.id}${subset ? ' (subset)' : ''}`
      : `${job.spec.scenarioIds?.length ?? 0} tasks`;
    lines.push(
      `${(job.finishedAt ?? job.createdAt).slice(0, 16).replace('T', ' ')}  ${(target?.modelId ?? '?').padEnd(24)} ${what.padEnd(22)} ${column?.claim ?? 'not measured'}${
        job.status !== 'completed' ? `  [${job.status}]` : ''
      }`,
    );
    if (subset) lines.push(`  ${EVAL_SUBSET_NOTE}`);
  }
  return lines;
}

export interface SubmitResult {
  title: string;
  body: string;
  url: string;
  /** Set when `gh` created the issue. */
  issueUrl?: string;
}

/** Issue title and body for a results shard. */
export function describeSubmission(shard: ScorecardDataset): { title: string; body: string } {
  const run = shard.runs[0]!;
  const models = [...new Set(shard.results.map((r) => `${r.modelId} (${r.engine})`))];
  const suites = run.suites.join(', ');
  const title = `Bench result: ${models.join(', ')} on ${run.provenance.device.label}`;
  const body = [
    '## Community bench result',
    '',
    `- Run: \`${run.id}\``,
    `- ${describeEvalRun(run, [...new Set(shard.results.map((r) => r.engine))])}`,
    `- Suites: ${suites}`,
    ...(run.note ? [`- Note: ${run.note}`] : []),
    '',
    'Results (count below three trials per task, rate otherwise):',
    ...shard.results.map((r) => {
      const matrixLike = r.cells.reduce(
        (acc, c) => {
          acc.trials += Math.max(0, c.trials - c.nonModelFailures);
          acc.successes += c.successes;
          return acc;
        },
        { trials: 0, successes: 0 },
      );
      return `- ${r.suiteId}: ${matrixLike.successes}/${matrixLike.trials}`;
    }),
    '',
    'The JSON shard produced by `gezel bench --json` is attached below. It is a `ScorecardDataset` and ingests with the same code as a published round; community rounds are shown separately from Bendyline rounds.',
    '',
    '<details><summary>shard.json</summary>',
    '',
    '```json',
    JSON.stringify(shard, null, 2),
    '```',
    '',
    '</details>',
  ].join('\n');
  return { title, body };
}

const execFileAsync = promisify(execFile);

/** `gezel bench submit <file>`: a prefilled issue, through `gh` when it is installed. */
export async function submitBench(
  file: string,
  io: Pick<BenchIo, 'out' | 'note'>,
  deps: {
    readFile?: (path: string) => Promise<string>;
    gh?: (args: string[]) => Promise<string>;
  } = {},
): Promise<SubmitResult> {
  const text = await (deps.readFile ?? ((p: string) => readFile(p, 'utf8')))(file);
  let shard: ScorecardDataset;
  try {
    shard = ScorecardDatasetSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new CliError(
      `${file} is not a bench result file: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}. Produce one with \`gezel bench --json <file>\`.`,
    );
  }
  if (shard.runs.length !== 1) {
    throw new CliError(`${file} holds ${shard.runs.length} runs; submit one run per issue.`);
  }
  const { title, body } = describeSubmission(shard);
  const params = new URLSearchParams({ title, labels: 'bench-result' });
  // GitHub caps URLs; the full shard travels in the body only through gh.
  const url = `https://github.com/${BENCH_SUBMIT_REPO}/issues/new?${params.toString()}`;
  const gh =
    deps.gh ??
    (async (args: string[]) => (await execFileAsync('gh', args, { encoding: 'utf8' })).stdout);
  try {
    const stdout = await gh([
      'issue',
      'create',
      '--repo',
      BENCH_SUBMIT_REPO,
      '--title',
      title,
      '--label',
      'bench-result',
      '--body',
      body,
    ]);
    const issueUrl = stdout.trim().split('\n').pop() ?? '';
    io.out(`Opened ${issueUrl}`);
    return { title, body, url, issueUrl };
  } catch {
    io.out('Open this page and attach the file to the issue:');
    io.out(`  ${url}`);
    io.out(`  file: ${file}`);
    io.note('(Install the GitHub CLI, `gh`, and sign in to have this done for you.)');
    return { title, body, url };
  }
}

/** Register `gezel bench` and its subcommands. */
export function registerBenchCommands(
  program: Command,
  connect: () => Promise<BenchClient>,
  io: BenchIo = {
    out: (line) => console.log(line),
    note: (line) => console.error(line),
    confirm: process.stdin.isTTY ? confirmOnTerminal : undefined,
    cpuModel: defaultCpuModel,
  },
): void {
  const bench = program
    .command('bench')
    .description(
      'Run the model scorecard on this machine: the same tasks, checks and counting rules as the published scorecard',
    )
    .option(
      '--suite <id>',
      'core (default), productivity, developer, complex-work, a comma list, or all',
    )
    .option('--smoke', "Run the suite's pulse check instead (fast; not a suite score)")
    .option('--model <id>', 'Model to evaluate (default: the model chats use)')
    .option('--provider <id>', 'Provider for --model when a model is on more than one')
    .option('--count <n>', 'Trials per task; 3 is what it takes to quote a rate (default 1)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--json <file>', 'Also write the results as a scorecard shard')
    .option('--note <text>', 'A note kept with the run')
    .option('--yes', 'Start without asking, however long the run')
    .option('--verbose', "Show the harness's own log lines while it runs")
    .action(async (opts: BenchRunOptions) => {
      const client = await connect();
      await runBench(client, opts, io);
    });

  bench
    .command('list')
    .description('Show the suites, how many tasks each has, and how long it can take')
    .action(async () => {
      const client = await connect();
      for (const line of renderSuiteList(await client.getEvalCatalog())) io.out(line);
    });

  bench
    .command('results')
    .description('Show finished runs on this machine')
    .option('--limit <n>', 'How many runs to show (default 20)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { limit?: number }) => {
      const client = await connect();
      const catalog = await client.getEvalCatalog();
      for (const line of await renderResults(client, catalog, opts.limit ?? 20)) io.out(line);
    });

  bench
    .command('submit <file>')
    .description('Share a results shard from `gezel bench --json` as a GitHub issue')
    .action(async (file: string) => {
      await submitBench(file, io);
    });
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
