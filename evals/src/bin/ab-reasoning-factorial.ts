/**
 * Replicated 2x2 capability experiment for llama.cpp reasoning history and
 * launch-time thinking budget.
 *
 * Default design:
 *   preservation off/on x reasoning budget 4096/8192
 *   x 3 replicates x 3 diverse coordination/repair scenarios = 36 trials.
 *
 * Cells run sequentially on one local engine. Arm order is counterbalanced
 * across replicates, every launch is checked against the daemon's structured
 * `[llama-server] launch` record, and state is written after every attempt so
 * an interrupted overnight run resumes without repeating valid cells.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { type FixedRubricScore, scoreTrialFacts } from '../fixed-rubric.ts';
import { assertLocalEngineSource } from '../model-sources.ts';
import { repoRoot } from '../native-bin.ts';
import { ensurePreflightAdmission, formatPreflightFailure } from '../preflight.ts';
import type { ChatProvider } from '../providers.ts';
import { resolveEvalRunsDir } from '../run-paths.ts';
import { runTrial } from '../runner.ts';
import { getScenario, listScenarios } from '../scenarios/index.ts';
import { installEvalSignalHandlers } from '../signal-handler.ts';
import type { EvalScenario, TrialResult } from '../types.ts';
import {
  assertKnownFlags,
  parseArgs,
  parseDuration,
  printScenarios,
  resolveProviderFlag,
} from './args.ts';
import { type TrialFacts, score } from './score-trial.ts';

export const DEFAULT_REASONING_FACTORIAL_SCENARIOS = [
  'self-correction-broken-js',
  'incident-postmortem',
  'schema-migration',
] as const;

export interface ReasoningArm {
  id: string;
  preserve: boolean;
  budgetTokens: 4096 | 8192;
}

export const REASONING_FACTORIAL_ARMS: readonly ReasoningArm[] = [
  { id: 'preserve-off-budget-4096', preserve: false, budgetTokens: 4096 },
  { id: 'preserve-on-budget-4096', preserve: true, budgetTokens: 4096 },
  { id: 'preserve-off-budget-8192', preserve: false, budgetTokens: 8192 },
  { id: 'preserve-on-budget-8192', preserve: true, budgetTokens: 8192 },
] as const;

const ARM_SEQUENCES = [
  [0, 1, 3, 2],
  [1, 2, 0, 3],
  [2, 3, 1, 0],
  [3, 0, 2, 1],
] as const;

export interface FactorialCell {
  id: string;
  replicate: number;
  scenarioId: string;
  arm: ReasoningArm;
}

export function buildReasoningFactorialPlan(args: {
  scenarioIds: string[];
  count: number;
}): FactorialCell[] {
  if (!Number.isInteger(args.count) || args.count < 1) {
    throw new Error('factorial count must be a positive integer');
  }
  if (args.scenarioIds.length < 1) throw new Error('factorial requires at least one scenario');
  const cells: FactorialCell[] = [];
  for (let replicate = 1; replicate <= args.count; replicate++) {
    const scenarioOffset = (replicate - 1) % args.scenarioIds.length;
    const scenarios = [
      ...args.scenarioIds.slice(scenarioOffset),
      ...args.scenarioIds.slice(0, scenarioOffset),
    ];
    const armOrder = ARM_SEQUENCES[(replicate - 1) % ARM_SEQUENCES.length] ?? ARM_SEQUENCES[0];
    for (const scenarioId of scenarios) {
      for (const armIndex of armOrder) {
        const arm = REASONING_FACTORIAL_ARMS[armIndex];
        if (!arm) throw new Error(`factorial arm index ${armIndex} is not configured`);
        cells.push({
          id: `r${replicate}__${scenarioId}__${arm.id}`,
          replicate,
          scenarioId,
          arm,
        });
      }
    }
  }
  return cells;
}

export interface ReasoningLaunchDiagnostic {
  reasoningBudgetTokens: number | 'unbounded';
  reasoningBudgetSource?: string;
  reasoningPreserve: boolean;
}

export function parseReasoningLaunchDiagnostic(log: string): ReasoningLaunchDiagnostic | null {
  let found: ReasoningLaunchDiagnostic | null = null;
  for (const line of log.split('\n')) {
    const marker = line.indexOf('[llama-server] launch ');
    if (marker < 0) continue;
    const jsonStart = line.indexOf('{', marker);
    if (jsonStart < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
      const budget = parsed.reasoningBudgetTokens;
      const preserve = parsed.reasoningPreserve;
      if ((typeof budget !== 'number' && budget !== 'unbounded') || typeof preserve !== 'boolean') {
        continue;
      }
      found = {
        reasoningBudgetTokens: budget,
        ...(typeof parsed.reasoningBudgetSource === 'string'
          ? { reasoningBudgetSource: parsed.reasoningBudgetSource }
          : {}),
        reasoningPreserve: preserve,
      };
    } catch {
      // Keep scanning; bounded daemon logs can contain older unrelated lines.
    }
  }
  return found;
}

export function reasoningLaunchMatchesArm(
  launch: ReasoningLaunchDiagnostic | null,
  arm: ReasoningArm,
): boolean {
  return (
    launch?.reasoningBudgetTokens === arm.budgetTokens && launch.reasoningPreserve === arm.preserve
  );
}

interface AttemptRecord {
  trialId: string;
  runDir: string;
  success: boolean;
  failureClass?: string;
  reason: string;
  durationMs: number;
  launch: ReasoningLaunchDiagnostic | null;
  configValid: boolean;
  includedInModelAggregate: boolean;
  score: FixedRubricScore;
  facts: {
    timeToFirstArtifactMs: number | null;
    timeToFirstToolCallMs: number | null;
    toolCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

interface CellRecord {
  cell: FactorialCell;
  attempts: AttemptRecord[];
  selected: AttemptRecord | null;
}

interface FactorialState {
  version: 1;
  status: 'running' | 'complete' | 'incomplete' | 'interrupted';
  modelId: string;
  engine: ChatProvider;
  count: number;
  timeoutMs: number;
  scenarios: string[];
  startedAt: string;
  updatedAt: string;
  plan: FactorialCell[];
  records: Record<string, CellRecord>;
}

function numberFlag(value: string | boolean | undefined, fallback: number, name: string): number {
  if (typeof value === 'boolean') throw new Error(`--${name} requires a value`);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function parseScenarioIds(value: string | boolean | undefined): string[] {
  if (value === undefined) return [...DEFAULT_REASONING_FACTORIAL_SCENARIOS];
  if (typeof value === 'boolean') throw new Error('--scenarios requires a comma-separated value');
  const ids = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length < 1) throw new Error('--scenarios must contain at least one id');
  return ids;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeState(root: string, state: FactorialState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeFile(join(root, 'ab-state.json'), JSON.stringify(state, null, 2));
  const summary = summarizeFactorial(state);
  await writeFile(join(root, 'ab-summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(root, 'REPORT.md'), renderFactorialReport(summary));
}

function usageTokens(facts: TrialFacts): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const perf = facts.perf as
    | { usage?: { totalInputTokens?: unknown; totalOutputTokens?: unknown } }
    | undefined;
  return {
    inputTokens:
      typeof perf?.usage?.totalInputTokens === 'number' ? perf.usage.totalInputTokens : null,
    outputTokens:
      typeof perf?.usage?.totalOutputTokens === 'number' ? perf.usage.totalOutputTokens : null,
  };
}

async function recordAttempt(result: TrialResult, arm: ReasoningArm): Promise<AttemptRecord> {
  const daemonLog = await readFile(join(result.runDir, 'daemon.log'), 'utf8').catch(() => '');
  const launch = parseReasoningLaunchDiagnostic(daemonLog);
  const facts = score(result.runDir);
  const fixedScore = scoreTrialFacts(facts, result);
  await writeFile(join(result.runDir, 'fixed-rubric.json'), JSON.stringify(fixedScore, null, 2));
  const tokens = usageTokens(facts);
  return {
    trialId: result.trialId,
    runDir: result.runDir,
    success: result.success,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    reason: result.reason,
    durationMs: result.durationMs,
    launch,
    configValid: reasoningLaunchMatchesArm(launch, arm),
    includedInModelAggregate: fixedScore.eligibility.includedInModelAggregate,
    score: fixedScore,
    facts: {
      timeToFirstArtifactMs: facts.timing.timeToFirstArtifactMs,
      timeToFirstToolCallMs: facts.timing.timeToFirstToolCallMs,
      toolCalls: facts.toolUse.totalToolCalls,
      ...tokens,
    },
  };
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? null);
}

function round(value: number | null, places = 2): number | null {
  if (value === null) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function aggregateAttempts(attempts: AttemptRecord[]) {
  const numeric = (pick: (attempt: AttemptRecord) => number | null): number[] =>
    attempts.map(pick).filter((value): value is number => value !== null);
  return {
    trials: attempts.length,
    successes: attempts.filter((attempt) => attempt.success).length,
    passRate:
      attempts.length > 0
        ? attempts.filter((attempt) => attempt.success).length / attempts.length
        : 0,
    meanComposite: round(mean(numeric((attempt) => attempt.score.composite))),
    medianDurationMs: round(median(numeric((attempt) => attempt.durationMs)), 0),
    medianTimeToFirstArtifactMs: round(
      median(numeric((attempt) => attempt.facts.timeToFirstArtifactMs)),
      0,
    ),
    meanToolCalls: round(mean(numeric((attempt) => attempt.facts.toolCalls))),
    meanInputTokens: round(mean(numeric((attempt) => attempt.facts.inputTokens)), 0),
    meanOutputTokens: round(mean(numeric((attempt) => attempt.facts.outputTokens)), 0),
  };
}

interface PairedEffect {
  n: number;
  meanDelta: number | null;
  medianDelta: number | null;
  ci95: [number, number] | null;
  wins: number;
  ties: number;
  losses: number;
}

function pairedEffect(deltas: number[]): PairedEffect {
  const average = mean(deltas);
  const variance =
    deltas.length > 1 && average !== null
      ? deltas.reduce((sum, value) => sum + (value - average) ** 2, 0) / (deltas.length - 1)
      : null;
  const margin = variance !== null ? 1.96 * Math.sqrt(variance / Math.max(1, deltas.length)) : null;
  return {
    n: deltas.length,
    meanDelta: round(average),
    medianDelta: round(median(deltas)),
    ci95:
      average !== null && margin !== null
        ? [round(average - margin) ?? 0, round(average + margin) ?? 0]
        : null,
    wins: deltas.filter((value) => value > 0).length,
    ties: deltas.filter((value) => value === 0).length,
    losses: deltas.filter((value) => value < 0).length,
  };
}

export function summarizeFactorial(state: FactorialState) {
  const selected = Object.values(state.records)
    .map((record) => ({ cell: record.cell, attempt: record.selected }))
    .filter(
      (entry): entry is { cell: FactorialCell; attempt: AttemptRecord } =>
        entry.attempt?.configValid === true && entry.attempt.includedInModelAggregate,
    );
  const key = (scenarioId: string, replicate: number, preserve: boolean, budget: number) =>
    `${scenarioId}\0${replicate}\0${preserve ? 1 : 0}\0${budget}`;
  const cells = new Map(
    selected.map((entry) => [
      key(
        entry.cell.scenarioId,
        entry.cell.replicate,
        entry.cell.arm.preserve,
        entry.cell.arm.budgetTokens,
      ),
      entry.attempt,
    ]),
  );
  const preserveDeltas: number[] = [];
  const budgetDeltas: number[] = [];
  const interactionDeltas: number[] = [];
  for (const scenarioId of state.scenarios) {
    for (let replicate = 1; replicate <= state.count; replicate++) {
      const off4096 = cells.get(key(scenarioId, replicate, false, 4096));
      const on4096 = cells.get(key(scenarioId, replicate, true, 4096));
      const off8192 = cells.get(key(scenarioId, replicate, false, 8192));
      const on8192 = cells.get(key(scenarioId, replicate, true, 8192));
      if (off4096 && on4096) preserveDeltas.push(on4096.score.composite - off4096.score.composite);
      if (off8192 && on8192) preserveDeltas.push(on8192.score.composite - off8192.score.composite);
      if (off4096 && off8192) budgetDeltas.push(off4096.score.composite - off8192.score.composite);
      if (on4096 && on8192) budgetDeltas.push(on4096.score.composite - on8192.score.composite);
      if (off4096 && on4096 && off8192 && on8192) {
        interactionDeltas.push(
          on4096.score.composite -
            off4096.score.composite -
            (on8192.score.composite - off8192.score.composite),
        );
      }
    }
  }
  const byArm = Object.fromEntries(
    REASONING_FACTORIAL_ARMS.map((arm) => [
      arm.id,
      aggregateAttempts(
        selected.filter((entry) => entry.cell.arm.id === arm.id).map((entry) => entry.attempt),
      ),
    ]),
  );
  const byScenario = Object.fromEntries(
    state.scenarios.map((scenarioId) => [
      scenarioId,
      Object.fromEntries(
        REASONING_FACTORIAL_ARMS.map((arm) => [
          arm.id,
          aggregateAttempts(
            selected
              .filter(
                (entry) => entry.cell.scenarioId === scenarioId && entry.cell.arm.id === arm.id,
              )
              .map((entry) => entry.attempt),
          ),
        ]),
      ),
    ]),
  );
  return {
    version: state.version,
    status: state.status,
    modelId: state.modelId,
    engine: state.engine,
    count: state.count,
    scenarios: state.scenarios,
    plannedTrials: state.plan.length,
    eligibleTrials: selected.length,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    byArm,
    byScenario,
    pairedEffects: {
      preservationOnMinusOff: pairedEffect(preserveDeltas),
      budget4096Minus8192: pairedEffect(budgetDeltas),
      interaction: pairedEffect(interactionDeltas),
    },
  };
}

function formatMinutes(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 60_000).toFixed(1)}m`;
}

function effectText(effect: PairedEffect): string {
  const ci = effect.ci95 ? `[${effect.ci95[0]}, ${effect.ci95[1]}]` : '—';
  return `${effect.meanDelta ?? '—'} (95% descriptive CI ${ci}; W/T/L ${effect.wins}/${effect.ties}/${effect.losses}; n=${effect.n})`;
}

export function renderFactorialReport(summary: ReturnType<typeof summarizeFactorial>): string {
  const lines = [
    '# Qwen reasoning preservation × budget factorial',
    '',
    `Status: **${summary.status}** — ${summary.eligibleTrials}/${summary.plannedTrials} eligible planned trials`,
    '',
    `Model: \`${summary.modelId}\` · engine: \`${summary.engine}\` · replicates: ${summary.count}`,
    '',
    '## Arm aggregates',
    '',
    '| Arm | Pass | Mean composite | Median duration | Median first artifact | Mean tools |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const arm of REASONING_FACTORIAL_ARMS) {
    const aggregate = summary.byArm[arm.id] ?? aggregateAttempts([]);
    lines.push(
      `| ${arm.id} | ${aggregate.successes}/${aggregate.trials} | ${aggregate.meanComposite ?? '—'} | ${formatMinutes(aggregate.medianDurationMs)} | ${formatMinutes(aggregate.medianTimeToFirstArtifactMs)} | ${aggregate.meanToolCalls ?? '—'} |`,
    );
  }
  lines.push(
    '',
    '## Paired factorial effects',
    '',
    `- Preservation on − off, composite: ${effectText(summary.pairedEffects.preservationOnMinusOff)}`,
    `- 4,096 − 8,192 budget, composite: ${effectText(summary.pairedEffects.budget4096Minus8192)}`,
    `- Interaction: ${effectText(summary.pairedEffects.interaction)}`,
    '',
    'Positive budget effect favors the smaller 4,096-token budget. Confidence intervals are descriptive normal approximations; pass rate, failure classes, latency, token use, and generic daemon pathologies still govern the keep/revert decision.',
    '',
    '## Per-scenario pass cells',
    '',
    `| Scenario | ${REASONING_FACTORIAL_ARMS.map((arm) => arm.id).join(' | ')} |`,
    `|---|${REASONING_FACTORIAL_ARMS.map(() => '---:').join('|')}|`,
  );
  for (const scenarioId of summary.scenarios) {
    lines.push(
      `| ${scenarioId} | ${REASONING_FACTORIAL_ARMS.map((arm) => {
        const value = summary.byScenario[scenarioId]?.[arm.id];
        return value ? `${value.successes}/${value.trials} (${value.meanComposite ?? '—'})` : '—';
      }).join(' | ')} |`,
    );
  }
  lines.push('', 'Generated incrementally by `eval:ab-reasoning`.');
  return `${lines.join('\n')}\n`;
}

function samePlan(
  state: FactorialState,
  args: { modelId: string; scenarioIds: string[]; count: number },
): boolean {
  return (
    state.modelId === args.modelId &&
    state.count === args.count &&
    JSON.stringify(state.scenarios) === JSON.stringify(args.scenarioIds)
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertKnownFlags(args.flags, [
    'count',
    'dry-run',
    'infra-retries',
    'list',
    'llama-bin',
    'model',
    'provider',
    'runs-dir',
    'scenarios',
    'skip-preflight',
    'timeout',
  ]);
  if (args.flags.list) {
    printScenarios(listScenarios());
    return;
  }
  for (const name of [
    'count',
    'infra-retries',
    'llama-bin',
    'model',
    'provider',
    'runs-dir',
    'scenarios',
    'timeout',
  ]) {
    if (typeof args.flags[name] === 'boolean') throw new Error(`--${name} requires a value`);
  }
  const modelId = typeof args.flags.model === 'string' ? args.flags.model : 'qwen3.8-27b-q4';
  const engine = resolveProviderFlag(args.flags) ?? 'llama-cpp';
  if (engine !== 'llama-cpp')
    throw new Error('reasoning preservation factorial requires llama-cpp');
  assertLocalEngineSource(engine, modelId);
  const scenarioIds = parseScenarioIds(args.flags.scenarios);
  const scenarios: EvalScenario[] = scenarioIds.map(getScenario);
  const count = numberFlag(args.flags.count, 3, 'count');
  if (count < 1) throw new Error('--count must be positive');
  const infraRetries = numberFlag(args.flags['infra-retries'], 1, 'infra-retries');
  const timeoutMs =
    args.flags.timeout === undefined ? 50 * 60_000 : parseDuration(String(args.flags.timeout));
  const root = resolveEvalRunsDir(
    typeof args.flags['runs-dir'] === 'string' ? args.flags['runs-dir'] : undefined,
    () => join(repoRoot(), 'evals', 'runs', `ab-reasoning-factorial-${timestampSlug()}`),
  );
  const plan = buildReasoningFactorialPlan({ scenarioIds, count });
  if (args.flags['dry-run']) {
    console.log(JSON.stringify({ modelId, engine, count, timeoutMs, root, plan }, null, 2));
    return;
  }
  await mkdir(root, { recursive: true });
  const statePath = join(root, 'ab-state.json');
  const existing = await readJson<FactorialState>(statePath);
  if (existing && !samePlan(existing, { modelId, scenarioIds, count })) {
    throw new Error(
      `existing factorial state at ${statePath} has a different model/scenario/count plan`,
    );
  }
  const now = new Date().toISOString();
  const state: FactorialState = existing ?? {
    version: 1,
    status: 'running',
    modelId,
    engine,
    count,
    timeoutMs,
    scenarios: scenarioIds,
    startedAt: now,
    updatedAt: now,
    plan,
    records: {},
  };
  state.status = 'running';
  await writeState(root, state);

  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider: engine, scenarios });
  const signal = installEvalSignalHandlers('reasoning factorial');
  try {
    if (!args.flags['skip-preflight']) {
      const preflight = await ensurePreflightAdmission({
        modelId,
        engine,
        ...(typeof args.flags['llama-bin'] === 'string'
          ? { llamaBin: args.flags['llama-bin'] }
          : {}),
        log: (line) => console.log(line),
      });
      if (!preflight.admitted) throw new Error(formatPreflightFailure(preflight));
    }
    console.log(
      `[ab-reasoning] model=${modelId} scenarios=${scenarioIds.join(',')} count=${count} planned=${plan.length}\n[ab-reasoning] root=${root}`,
    );
    for (const [index, cell] of plan.entries()) {
      if (signal.signal.aborted) break;
      const prior = state.records[cell.id];
      if (prior?.selected?.configValid && prior.selected.includedInModelAggregate) {
        console.log(`[ab-reasoning] skip completed ${cell.id}`);
        continue;
      }
      const record: CellRecord = prior ?? { cell, attempts: [], selected: null };
      state.records[cell.id] = record;
      console.log(
        `\n[ab-reasoning] ${index + 1}/${plan.length} ${cell.id} preserve=${cell.arm.preserve} budget=${cell.arm.budgetTokens}`,
      );
      const maxAttempts = infraRetries + 1;
      while (record.attempts.length < maxAttempts && !signal.signal.aborted) {
        const result = await runTrial(getScenario(cell.scenarioId), {
          modelId,
          engine,
          timeoutMs,
          signal: signal.signal,
          runsDir: join(root, 'arms', cell.arm.id, cell.scenarioId),
          llamaCppReasoningPreserve: cell.arm.preserve,
          llamaCppReasoningBudgetTokens: cell.arm.budgetTokens,
          ...(typeof args.flags['llama-bin'] === 'string'
            ? { llamaBin: args.flags['llama-bin'] }
            : {}),
        });
        const attempt = await recordAttempt(result, cell.arm);
        record.attempts.push(attempt);
        if (attempt.launch && !attempt.configValid) {
          await writeState(root, state);
          throw new Error(
            `factorial arm collapsed for ${cell.id}: expected preserve=${cell.arm.preserve} budget=${cell.arm.budgetTokens}, observed ${JSON.stringify(attempt.launch)}`,
          );
        }
        if (attempt.configValid && attempt.includedInModelAggregate) {
          record.selected = attempt;
          break;
        }
        console.warn(
          `[ab-reasoning] excluded attempt ${attempt.trialId} class=${attempt.failureClass ?? 'unknown'} config=${attempt.configValid}; ${record.attempts.length < maxAttempts ? 'retrying' : 'retry budget exhausted'}`,
        );
        await writeState(root, state);
      }
      await writeState(root, state);
    }
    const eligible = Object.values(state.records).filter(
      (record) => record.selected?.configValid && record.selected.includedInModelAggregate,
    ).length;
    state.status = signal.signal.aborted
      ? 'interrupted'
      : eligible === plan.length
        ? 'complete'
        : 'incomplete';
    await writeState(root, state);
    console.log(`\n[ab-reasoning] ${state.status}: ${eligible}/${plan.length} eligible cells`);
    console.log(`[ab-reasoning] report=${join(root, 'REPORT.md')}`);
    process.exitCode = state.status === 'complete' ? 0 : 1;
  } finally {
    deviceLock?.release();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error('[ab-reasoning] fatal:', error);
    process.exitCode = 2;
  });
}
