import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What the engine and the strategy resolver logged during one trial, read
 * from its `daemon.log`. Context size and decode speed are tracked so a
 * strategy comparison can also show what each arm costs in context, and so
 * an engine bump that slows decoding shows up beside the scores.
 */
export interface TrialEngineMetrics {
  /** Largest prompt one engine request carried (llama-server `n_tokens`). */
  peakPromptTokens: number | null;
  /** The working session's first request: the first over 8K tokens. */
  firstPromptTokens: number | null;
  /**
   * Tools on the widest session the trial ran. Arms are comparable only
   * when this is: an owner carrying a whole installed roster pays for it in
   * every request, and that cost is the harness's, not the strategy's.
   */
  peakToolSurface: number | null;
  /** Median generation speed over the trial's engine timing lines. */
  decodeTps: number | null;
  /** Median prompt-processing speed. */
  prefillTps: number | null;
  /** The strategy the daemon resolved for the trial's task (`strategy=` marker). */
  resolvedStrategy: string | null;
  /** `model` or `tier` when `auto` decided, from the marker's `source=`. */
  resolvedSource: string | null;
}

const STOP_PROCESSING = /stop processing: n_tokens = (\d+)/g;
const DECODE = /\btg =\s*([\d.]+) t\/s/g;
const PREFILL =
  /prompt processing, n_tokens =\s*\d+, progress = [\d.]+, t =\s*[\d.]+ s \/\s*([\d.]+) tokens per second/g;
const TOOL_SURFACE = /model-facing tool surface has (\d+) tools/g;
const FIRST_REQUEST_FLOOR = 8_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function numbers(log: string, pattern: RegExp): number[] {
  return [...log.matchAll(pattern)].map((m) => Number(m[1])).filter(Number.isFinite);
}

export function parseEngineMetrics(log: string, taskRef?: string): TrialEngineMetrics {
  const prompts = numbers(log, STOP_PROCESSING);
  const surfaces = numbers(log, TOOL_SURFACE);
  const marker = taskRef
    ? log.split('\n').find((line) => line.includes(`${taskRef} generalist-mode resolved=`))
    : undefined;
  return {
    peakPromptTokens: prompts.length ? Math.max(...prompts) : null,
    firstPromptTokens: prompts.find((n) => n > FIRST_REQUEST_FLOOR) ?? null,
    peakToolSurface: surfaces.length ? Math.max(...surfaces) : null,
    decodeTps: median(numbers(log, DECODE)),
    prefillTps: median(numbers(log, PREFILL)),
    resolvedStrategy: marker?.match(/ strategy=(\S+)/)?.[1] ?? null,
    resolvedSource: marker?.match(/ source=(\S+)/)?.[1] ?? null,
  };
}

export async function readEngineMetrics(
  trialDir: string,
  taskRef?: string,
): Promise<TrialEngineMetrics | null> {
  try {
    return parseEngineMetrics(await readFile(join(trialDir, 'daemon.log'), 'latin1'), taskRef);
  } catch {
    return null;
  }
}
