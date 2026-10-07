/**
 * Per-scenario regression flags between two eval run roots.
 *
 * Pass/fail alone is throughput- and cost-blind by design, so a change that
 * keeps scenarios passing while making them several times slower goes
 * unnoticed. The factual-writing ledger did exactly that: merged on
 * 2026-10-05, it took qwen3.8-27b conflict-synthesis and incident-postmortem
 * from 3-4 to 16-22 minutes and input tokens from ~20k to as much as 547k,
 * all still passing, and a history review found it a day later. These flags
 * compare duration and token use per scenario against a baseline root so a
 * sweep report can say so the same day.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface TrialRow {
  scenarioId: string;
  success: boolean;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ScenarioSummary {
  scenarioId: string;
  trials: number;
  passes: number;
  meanDurationMs?: number;
  meanInputTokens?: number;
  meanOutputTokens?: number;
}

export type RegressionKind = 'duration' | 'input-tokens' | 'output-tokens' | 'pass-rate';

export interface RegressionFlag {
  scenarioId: string;
  kind: RegressionKind;
  current: number;
  baseline: number;
  /** current / baseline for the size flags; the drop for pass-rate. */
  ratio: number;
}

export interface RegressionOptions {
  /** Flag a size metric at or above this multiple of the baseline (default 2). */
  ratio?: number;
  /** Ignore duration growth smaller than this (default 2 minutes). */
  minDurationDeltaMs?: number;
  /** Ignore token growth smaller than this (default 20k input, 4k output). */
  minInputDelta?: number;
  minOutputDelta?: number;
  /** Flag a pass-rate drop at or above this (default 0.5). */
  passRateDrop?: number;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Every trial under `root` that has a `result.json`, preflight probes excluded. */
export function collectTrials(root: string): TrialRow[] {
  const rows: TrialRow[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes('result.json')) {
      const result = readJson(join(dir, 'result.json'));
      if (!result) return;
      const scenarioId =
        typeof result.scenarioId === 'string' ? result.scenarioId : basename(dirname(dir));
      if (scenarioId === 'preflight') return;
      const metrics = existsSync(join(dir, 'metrics.json'))
        ? readJson(join(dir, 'metrics.json'))
        : null;
      const derived = (metrics?.derived ?? {}) as Record<string, unknown>;
      const tokens = ((derived.billing as Record<string, unknown> | undefined)?.tokens ??
        {}) as Record<string, unknown>;
      const row: TrialRow = { scenarioId, success: result.success === true };
      const durationMs = num(result.durationMs);
      if (durationMs !== undefined) row.durationMs = durationMs;
      const inputTokens = num(tokens.input);
      if (inputTokens !== undefined) row.inputTokens = inputTokens;
      const outputTokens = num(tokens.output);
      if (outputTokens !== undefined) row.outputTokens = outputTokens;
      rows.push(row);
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory()) walk(child, depth + 1);
      } catch {
        // Unreadable entry: skip it.
      }
    }
  };
  walk(root, 0);
  return rows;
}

function mean(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : undefined;
}

export function summarizeByScenario(rows: readonly TrialRow[]): Map<string, ScenarioSummary> {
  const groups = new Map<string, TrialRow[]>();
  for (const row of rows) {
    const list = groups.get(row.scenarioId) ?? [];
    list.push(row);
    groups.set(row.scenarioId, list);
  }
  const out = new Map<string, ScenarioSummary>();
  for (const [scenarioId, list] of groups) {
    const summary: ScenarioSummary = {
      scenarioId,
      trials: list.length,
      passes: list.filter((r) => r.success).length,
    };
    const d = mean(list.map((r) => r.durationMs));
    if (d !== undefined) summary.meanDurationMs = d;
    const i = mean(list.map((r) => r.inputTokens));
    if (i !== undefined) summary.meanInputTokens = i;
    const o = mean(list.map((r) => r.outputTokens));
    if (o !== undefined) summary.meanOutputTokens = o;
    out.set(scenarioId, summary);
  }
  return out;
}

/** Scenarios present in both summaries whose cost grew, or whose pass rate fell, past the thresholds. */
export function regressionFlags(
  current: Map<string, ScenarioSummary>,
  baseline: Map<string, ScenarioSummary>,
  opts: RegressionOptions = {},
): RegressionFlag[] {
  const ratio = opts.ratio ?? 2;
  const minDuration = opts.minDurationDeltaMs ?? 120_000;
  const minInput = opts.minInputDelta ?? 20_000;
  const minOutput = opts.minOutputDelta ?? 4_000;
  const passDrop = opts.passRateDrop ?? 0.5;
  const flags: RegressionFlag[] = [];
  for (const [scenarioId, cur] of current) {
    const base = baseline.get(scenarioId);
    if (!base) continue;
    const size = (kind: RegressionKind, c?: number, b?: number, minDelta = 0) => {
      if (c === undefined || b === undefined || b <= 0) return;
      if (c / b >= ratio && c - b >= minDelta) {
        flags.push({ scenarioId, kind, current: c, baseline: b, ratio: c / b });
      }
    };
    size('duration', cur.meanDurationMs, base.meanDurationMs, minDuration);
    size('input-tokens', cur.meanInputTokens, base.meanInputTokens, minInput);
    size('output-tokens', cur.meanOutputTokens, base.meanOutputTokens, minOutput);
    const curRate = cur.passes / cur.trials;
    const baseRate = base.passes / base.trials;
    if (baseRate - curRate >= passDrop) {
      flags.push({
        scenarioId,
        kind: 'pass-rate',
        current: curRate,
        baseline: baseRate,
        ratio: baseRate - curRate,
      });
    }
  }
  return flags.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

/** A Markdown table of the flags, or a one-line all-clear. */
export function renderRegressionFlags(flags: readonly RegressionFlag[]): string {
  if (flags.length === 0) return 'No per-scenario regressions against the baseline.';
  const fmt = (kind: RegressionKind, v: number) =>
    kind === 'duration'
      ? `${(v / 60_000).toFixed(1)} min`
      : kind === 'pass-rate'
        ? `${Math.round(v * 100)}%`
        : `${Math.round(v).toLocaleString('en-US')}`;
  const lines = [
    '| scenario | metric | baseline | current | change |',
    '| --- | --- | --- | --- | --- |',
    ...flags.map(
      (f) =>
        `| ${f.scenarioId} | ${f.kind} | ${fmt(f.kind, f.baseline)} | ${fmt(f.kind, f.current)} | ${
          f.kind === 'pass-rate' ? `−${Math.round(f.ratio * 100)} pts` : `${f.ratio.toFixed(1)}×`
        } |`,
    ),
  ];
  return lines.join('\n');
}
