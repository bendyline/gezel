/**
 * Replicated effort-only capability experiment for local models whose chat
 * template exposes `reasoning_effort`.
 *
 * Default design:
 *   medium/xhigh x 3 replicates x 3 diverse scenarios = 18 trials.
 *
 * Budget (4096), reasoning preservation (off), profiles, sampling, prompts,
 * output caps, and behaviors stay fixed. Every selected trial must prove both
 * its launch controls and the effective request-body reasoning effort from the
 * daemon's non-sensitive request diagnostic.
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
  type ReasoningLaunchDiagnostic,
  parseReasoningLaunchDiagnostic,
} from './ab-reasoning-factorial.ts';
import {
  assertKnownFlags,
  parseArgs,
  parseDuration,
  printScenarios,
  resolveProviderFlag,
} from './args.ts';
import { type TrialFacts, score } from './score-trial.ts';

export const DEFAULT_REASONING_EFFORT_SCENARIOS = [
  'incident-postmortem',
  'schema-migration',
  'tool-routing-retrieval',
] as const;

export const REASONING_EFFORTS = ['medium', 'xhigh'] as const;
export type ReasoningEffortArm = (typeof REASONING_EFFORTS)[number];

const FIXED_REASONING_BUDGET_TOKENS = 4096;
const FIXED_REASONING_PRESERVE = false;

export interface ReasoningEffortCell {
  id: string;
  replicate: number;
  scenarioId: string;
  effort: ReasoningEffortArm;
}

export function buildReasoningEffortPlan(args: {
  scenarioIds: string[];
  count: number;
}): ReasoningEffortCell[] {
  if (!Number.isInteger(args.count) || args.count < 1) {
    throw new Error('effort A/B count must be a positive integer');
  }
  if (args.scenarioIds.length < 1) throw new Error('effort A/B requires at least one scenario');
  const cells: ReasoningEffortCell[] = [];
  for (let replicate = 1; replicate <= args.count; replicate++) {
    const scenarioOffset = (replicate - 1) % args.scenarioIds.length;
    const scenarios = [
      ...args.scenarioIds.slice(scenarioOffset),
      ...args.scenarioIds.slice(0, scenarioOffset),
    ];
    scenarios.forEach((scenarioId, scenarioIndex) => {
      const efforts =
        (replicate + scenarioIndex) % 2 === 0
          ? REASONING_EFFORTS
          : ([...REASONING_EFFORTS].reverse() as ReasoningEffortArm[]);
      for (const effort of efforts) {
        cells.push({
          id: `r${replicate}__${scenarioId}__effort-${effort}`,
          replicate,
          scenarioId,
          effort,
        });
      }
    });
  }
  return cells;
}

export interface ReasoningRequestDiagnostic {
  model?: string;
  iteration?: number;
  enableThinking?: boolean;
  reasoningEffort?: string | number | boolean;
  reasoningStrength?: string | number | boolean;
}

export function parseReasoningRequestDiagnostics(log: string): ReasoningRequestDiagnostic[] {
  const found: ReasoningRequestDiagnostic[] = [];
  for (const line of log.split('\n')) {
    const marker = line.indexOf('[llama-cpp] request-reasoning ');
    if (marker < 0) continue;
    const jsonStart = line.indexOf('{', marker);
    if (jsonStart < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(jsonStart)) as ReasoningRequestDiagnostic;
      if (parsed && typeof parsed === 'object') found.push(parsed);
    } catch {
      // Keep scanning: bounded logs can contain partial lines at shutdown.
    }
  }
  return found;
}

export function reasoningEffortConfigurationMatches(args: {
  launch: ReasoningLaunchDiagnostic | null;
  requests: ReasoningRequestDiagnostic[];
  effort: ReasoningEffortArm;
}): boolean {
  if (
    args.launch?.reasoningBudgetTokens !== FIXED_REASONING_BUDGET_TOKENS ||
    args.launch.reasoningPreserve !== FIXED_REASONING_PRESERVE
  ) {
    return false;
  }
  const thinkingRequests = args.requests.filter((request) => request.enableThinking !== false);
  const observedEfforts = thinkingRequests
    .map((request) => request.reasoningEffort)
    .filter((value): value is string => typeof value === 'string');
  return (
    observedEfforts.includes(args.effort) &&
    observedEfforts.every((value) => value === args.effort || value === 'low')
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
  requestReasoning: ReasoningRequestDiagnostic[];
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
  cell: ReasoningEffortCell;
  attempts: AttemptRecord[];
  selected: AttemptRecord | null;
}

interface EffortState {
  version: 1;
  experiment: 'reasoning-effort-only';
  status: 'running' | 'complete' | 'incomplete' | 'interrupted';
  modelId: string;
  engine: ChatProvider;
  count: number;
  timeoutMs: number;
  scenarios: string[];
  fixedControls: { reasoningBudgetTokens: 4096; reasoningPreserve: false };
  startedAt: string;
  updatedAt: string;
  plan: ReasoningEffortCell[];
  records: Record<string, CellRecord>;
}

function numberFlag(value: string | boolean | undefined, fallback: number, name: string): number {
  if (typeof value === 'boolean') throw new Error(`--${name} requires a value`);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function parseScenarioIds(value: string | boolean | undefined): string[] {
  if (value === undefined) return [...DEFAULT_REASONING_EFFORT_SCENARIOS];
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

async function recordAttempt(
  result: TrialResult,
  effort: ReasoningEffortArm,
): Promise<AttemptRecord> {
  const daemonLog = await readFile(join(result.runDir, 'daemon.log'), 'utf8').catch(() => '');
  const launch = parseReasoningLaunchDiagnostic(daemonLog);
  const requestReasoning = parseReasoningRequestDiagnostics(daemonLog);
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
    requestReasoning,
    configValid: reasoningEffortConfigurationMatches({
      launch,
      requests: requestReasoning,
      effort,
    }),
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

function pairedEffect(deltas: number[]) {
  const average = mean(deltas);
  const variance =
    deltas.length > 1 && average !== null
      ? deltas.reduce((sum, value) => sum + (value - average) ** 2, 0) / (deltas.length - 1)
      : null;
  const margin = variance !== null ? 1.96 * Math.sqrt(variance / deltas.length) : null;
  return {
    n: deltas.length,
    meanDelta: round(average),
    medianDelta: round(median(deltas)),
    ci95:
      average !== null && margin !== null
        ? ([round(average - margin), round(average + margin)] as const)
        : null,
    wins: deltas.filter((value) => value > 0).length,
    ties: deltas.filter((value) => value === 0).length,
    losses: deltas.filter((value) => value < 0).length,
  };
}

export function summarizeEffortExperiment(state: EffortState) {
  const selected = Object.values(state.records)
    .map((record) => ({ cell: record.cell, attempt: record.selected }))
    .filter(
      (entry): entry is { cell: ReasoningEffortCell; attempt: AttemptRecord } =>
        entry.attempt?.configValid === true && entry.attempt.includedInModelAggregate,
    );
  const key = (scenarioId: string, replicate: number, effort: ReasoningEffortArm) =>
    `${scenarioId}\0${replicate}\0${effort}`;
  const cells = new Map(
    selected.map((entry) => [
      key(entry.cell.scenarioId, entry.cell.replicate, entry.cell.effort),
      entry.attempt,
    ]),
  );
  const deltas: number[] = [];
  for (const scenarioId of state.scenarios) {
    for (let replicate = 1; replicate <= state.count; replicate++) {
      const medium = cells.get(key(scenarioId, replicate, 'medium'));
      const xhigh = cells.get(key(scenarioId, replicate, 'xhigh'));
      if (medium && xhigh) deltas.push(xhigh.score.composite - medium.score.composite);
    }
  }
  const byEffort = Object.fromEntries(
    REASONING_EFFORTS.map((effort) => [
      effort,
      aggregateAttempts(
        selected.filter((entry) => entry.cell.effort === effort).map((entry) => entry.attempt),
      ),
    ]),
  );
  const byScenario = Object.fromEntries(
    state.scenarios.map((scenarioId) => [
      scenarioId,
      Object.fromEntries(
        REASONING_EFFORTS.map((effort) => [
          effort,
          aggregateAttempts(
            selected
              .filter(
                (entry) => entry.cell.scenarioId === scenarioId && entry.cell.effort === effort,
              )
              .map((entry) => entry.attempt),
          ),
        ]),
      ),
    ]),
  );
  return {
    version: state.version,
    experiment: state.experiment,
    status: state.status,
    modelId: state.modelId,
    engine: state.engine,
    count: state.count,
    scenarios: state.scenarios,
    fixedControls: state.fixedControls,
    plannedTrials: state.plan.length,
    eligibleTrials: selected.length,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    byEffort,
    byScenario,
    pairedEffectXhighMinusMedium: pairedEffect(deltas),
  };
}

function formatMinutes(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 60_000).toFixed(1)}m`;
}

export function renderEffortReport(summary: ReturnType<typeof summarizeEffortExperiment>): string {
  const effect = summary.pairedEffectXhighMinusMedium;
  const ci = effect.ci95 ? `[${effect.ci95[0]}, ${effect.ci95[1]}]` : '—';
  const lines = [
    '# Qwen reasoning effort-only A/B',
    '',
    `Status: **${summary.status}** — ${summary.eligibleTrials}/${summary.plannedTrials} eligible planned trials`,
    '',
    `Model: \`${summary.modelId}\` · engine: \`${summary.engine}\` · replicates: ${summary.count}`,
    '',
    `Fixed controls: reasoning budget **${summary.fixedControls.reasoningBudgetTokens.toLocaleString()}**, preservation **off**; sampling, profiles, prompts, output caps, and behaviors unchanged.`,
    '',
    '## Arm aggregates',
    '',
    '| Effort | Pass | Mean composite | Median duration | Median first artifact | Mean tools | Mean output tokens |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const effort of REASONING_EFFORTS) {
    const aggregate = summary.byEffort[effort] ?? aggregateAttempts([]);
    lines.push(
      `| ${effort} | ${aggregate.successes}/${aggregate.trials} | ${aggregate.meanComposite ?? '—'} | ${formatMinutes(aggregate.medianDurationMs)} | ${formatMinutes(aggregate.medianTimeToFirstArtifactMs)} | ${aggregate.meanToolCalls ?? '—'} | ${aggregate.meanOutputTokens ?? '—'} |`,
    );
  }
  lines.push(
    '',
    '## Paired effect',
    '',
    `- xhigh − medium composite: ${effect.meanDelta ?? '—'} (95% descriptive CI ${ci}; W/T/L ${effect.wins}/${effect.ties}/${effect.losses}; n=${effect.n})`,
    '',
    'Positive values favor xhigh. Treat the interval as descriptive, not inferential; pass rate, failure classes, latency, token use, and generic daemon pathologies govern the final keep/revert decision.',
    '',
    '## Per-scenario results',
    '',
    '| Scenario | medium | xhigh |',
    '|---|---:|---:|',
  );
  for (const scenarioId of summary.scenarios) {
    lines.push(
      `| ${scenarioId} | ${REASONING_EFFORTS.map((effort) => {
        const value = summary.byScenario[scenarioId]?.[effort];
        return value ? `${value.successes}/${value.trials} (${value.meanComposite ?? '—'})` : '—';
      }).join(' | ')} |`,
    );
  }
  lines.push(
    '',
    'Configuration eligibility requires launch diagnostics to show budget=4096 and preservation=false, plus at least one actual thinking request whose `reasoning_effort` exactly matches its arm. Constrained repair requests may legitimately downgrade themselves to `low` and do not collapse the arm.',
    '',
    'Generated incrementally by `eval:ab-effort`.',
  );
  return `${lines.join('\n')}\n`;
}

async function writeState(root: string, state: EffortState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeFile(join(root, 'ab-state.json'), JSON.stringify(state, null, 2));
  const summary = summarizeEffortExperiment(state);
  await writeFile(join(root, 'ab-summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(root, 'REPORT.md'), renderEffortReport(summary));
}

function samePlan(
  state: EffortState,
  args: { modelId: string; scenarioIds: string[]; count: number },
): boolean {
  return (
    state.experiment === 'reasoning-effort-only' &&
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
  if (engine !== 'llama-cpp') throw new Error('reasoning effort A/B requires llama-cpp');
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
    () => join(repoRoot(), 'evals', 'runs', `ab-reasoning-effort-${timestampSlug()}`),
  );
  const plan = buildReasoningEffortPlan({ scenarioIds, count });
  if (args.flags['dry-run']) {
    console.log(
      JSON.stringify(
        {
          modelId,
          engine,
          count,
          timeoutMs,
          root,
          fixedControls: {
            reasoningBudgetTokens: FIXED_REASONING_BUDGET_TOKENS,
            reasoningPreserve: FIXED_REASONING_PRESERVE,
          },
          plan,
        },
        null,
        2,
      ),
    );
    return;
  }
  await mkdir(root, { recursive: true });
  const statePath = join(root, 'ab-state.json');
  const existing = await readJson<EffortState>(statePath);
  if (existing && !samePlan(existing, { modelId, scenarioIds, count })) {
    throw new Error(`existing effort A/B state at ${statePath} has a different plan`);
  }
  const now = new Date().toISOString();
  const state: EffortState = existing ?? {
    version: 1,
    experiment: 'reasoning-effort-only',
    status: 'running',
    modelId,
    engine,
    count,
    timeoutMs,
    scenarios: scenarioIds,
    fixedControls: {
      reasoningBudgetTokens: FIXED_REASONING_BUDGET_TOKENS,
      reasoningPreserve: FIXED_REASONING_PRESERVE,
    },
    startedAt: now,
    updatedAt: now,
    plan,
    records: {},
  };
  state.status = 'running';
  await writeState(root, state);

  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider: engine, scenarios });
  const signal = installEvalSignalHandlers('reasoning effort A/B');
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
      `[ab-effort] model=${modelId} scenarios=${scenarioIds.join(',')} count=${count} planned=${plan.length}\n[ab-effort] fixed preserve=false budget=4096\n[ab-effort] root=${root}`,
    );
    for (const [index, cell] of plan.entries()) {
      if (signal.signal.aborted) break;
      const prior = state.records[cell.id];
      if (prior?.selected?.configValid && prior.selected.includedInModelAggregate) {
        console.log(`[ab-effort] skip completed ${cell.id}`);
        continue;
      }
      const record: CellRecord = prior ?? { cell, attempts: [], selected: null };
      state.records[cell.id] = record;
      console.log(`\n[ab-effort] ${index + 1}/${plan.length} ${cell.id} effort=${cell.effort}`);
      const maxAttempts = infraRetries + 1;
      while (record.attempts.length < maxAttempts && !signal.signal.aborted) {
        const result = await runTrial(getScenario(cell.scenarioId), {
          modelId,
          engine,
          timeoutMs,
          signal: signal.signal,
          runsDir: join(root, 'arms', `effort-${cell.effort}`, cell.scenarioId),
          llamaCppReasoningPreserve: FIXED_REASONING_PRESERVE,
          llamaCppReasoningBudgetTokens: FIXED_REASONING_BUDGET_TOKENS,
          llamaCppReasoningEffort: cell.effort,
          ...(typeof args.flags['llama-bin'] === 'string'
            ? { llamaBin: args.flags['llama-bin'] }
            : {}),
        });
        const attempt = await recordAttempt(result, cell.effort);
        record.attempts.push(attempt);
        if (attempt.launch && !attempt.configValid && attempt.requestReasoning.length > 0) {
          await writeState(root, state);
          throw new Error(
            `effort arm collapsed for ${cell.id}: expected effort=${cell.effort} preserve=false budget=4096, observed launch=${JSON.stringify(attempt.launch)} requests=${JSON.stringify(attempt.requestReasoning.slice(0, 8))}`,
          );
        }
        if (attempt.configValid && attempt.includedInModelAggregate) {
          record.selected = attempt;
          break;
        }
        console.warn(
          `[ab-effort] excluded attempt ${attempt.trialId} class=${attempt.failureClass ?? 'unknown'} config=${attempt.configValid}; ${record.attempts.length < maxAttempts ? 'retrying' : 'retry budget exhausted'}`,
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
    console.log(`\n[ab-effort] ${state.status}: ${eligible}/${plan.length} eligible cells`);
    console.log(`[ab-effort] report=${join(root, 'REPORT.md')}`);
    process.exitCode = state.status === 'complete' ? 0 : 1;
  } finally {
    deviceLock?.release();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error('[ab-effort] fatal:', error);
    process.exitCode = 2;
  });
}
