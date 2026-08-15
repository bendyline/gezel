/**
 * Failure classification — who broke the trial?
 *
 * Pass-rate tables built from raw `success` booleans systematically
 * understate model capability: the cross-history analysis of
 * 912 trials found large failure buckets that were NOT model failures —
 * operator SIGINTs counted as fails, capacity-broker denials
 * misclassified as "engine hung", GPU-arbiter evictions killing in-flight
 * renders, and grader bugs false-failing correct work. Optimizing tuning
 * against that scoreboard optimizes against noise.
 *
 * Every terminal trial therefore gets a coarse `failureClass` tag:
 *
 *   - `pass`     — trial succeeded.
 *   - `operator` — a human stopped it (SIGINT/SIGTERM). No signal at all.
 *   - `infra`    — the harness/daemon/engine broke it: capacity denial,
 *                  context overflow, wedged engine, scheduler deadlock,
 *                  chat-template 500s, a render killed mid-flight.
 *   - `grader`   — the success check itself was wrong (style-sensitive
 *                  sniff, unsatisfiable required signal). Only assigned
 *                  by the backfill script, which re-analyzes the final
 *                  workspace against the FIXED graders — live runs assume
 *                  current graders are correct.
 *   - `model`    — everything else: the model genuinely didn't deliver.
 *
 * Rules are deliberately high-precision: when in doubt a failure stays
 * `model`. An infra tag must be backed by an explicit signature in the
 * failure reason or the daemon log, because the whole point is that the
 * `model` column becomes trustworthy.
 *
 * This generalizes the `readCapacityDenialFromLog` pattern that runner.ts
 * grew one terminal-error reader at a time.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { parseDaemonActivityText } from './progress-fingerprint.ts';
import type { FailureClass, NativeEngineIncidentSummary } from './types.ts';

/**
 * Read the tail of a daemon.log for classification. Daemon logs commonly
 * grow past 100 MB; the terminal-error signatures we classify on always
 * live in the most recent window, so a bounded tail keeps backfill over
 * hundreds of historical trials cheap. Returns null when unreadable.
 */
export function readDaemonLogTailSync(path: string, capBytes = 16 * 1024 * 1024): string | null {
  if (!existsSync(path)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - capBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface FailureClassification {
  failureClass: FailureClass;
  /** Stable rule id (e.g. 'capacity-denial'); 'model-default' when no
   * specific signature matched. */
  rule: string;
  /** Short excerpt of the matched reason/log text. */
  evidence?: string;
}

export interface ClassifyTrialInput {
  success: boolean;
  reason?: string | null;
  failureMode?: string | null;
  /** daemon.log text (tail is fine). Log-signature rules skip when absent. */
  daemonLog?: string | null;
  /** Structured JSONL copied from the trial home's native incident log. */
  nativeIncidentLog?: string | null;
}

/** Failure modes where the trial died waiting/looping rather than on an
 * explicit terminal error — the modes a daemon-side defect can masquerade
 * behind. Log-signature rules only apply to these, so a trial that failed
 * for a crisp other reason can't be re-blamed on an incidental log line. */
const STALL_MODES = new Set(['chat-stalled', 'model-stuck', 'timeout', 'no-progress']);

function isStallish(input: ClassifyTrialInput): boolean {
  if (input.failureMode) return STALL_MODES.has(input.failureMode);
  // Legacy results (pre-failureMode) — fall back to reason shapes.
  const reason = input.reason ?? '';
  return /retry loop|stalled|hard ceiling|timed out|no real progress/.test(reason);
}

function excerpt(text: string, index: number, length = 140): string {
  return text.slice(index, index + length).split('\n')[0] ?? '';
}

function findInReasonOrLog(input: ClassifyTrialInput, pattern: RegExp): string | null {
  const reason = input.reason ?? '';
  const reasonMatch = reason.match(pattern);
  if (reasonMatch && reasonMatch.index !== undefined) {
    return excerpt(reason, reasonMatch.index);
  }
  const log = input.daemonLog ?? '';
  const logMatch = log.match(pattern);
  if (logMatch && logMatch.index !== undefined) {
    return excerpt(log, logMatch.index);
  }
  return null;
}

function countInLog(input: ClassifyTrialInput, pattern: RegExp): number {
  const log = input.daemonLog;
  if (!log) return 0;
  return log.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))?.length ?? 0;
}

// Shape contract with the product: ProviderPool logs
// `capacity broker denied <key>: <reason>` at both deny sites via
// capacityDenialLogLine (packages/service/src/providers/native/provider-pool.ts).
const CAPACITY_DENIAL = /capacity broker denied [^\n]*budget exhausted/;
const CONTEXT_OVERFLOW =
  /On-device model ran out of working memory|context overflow: [\d,]+ tokens|exceeds the available context size/;
const ENGINE_HUNG_REASON = /engine appears hung|no daemon activity for|image render wedged/;
const NATIVE_ENGINE_CRASH_REASON = /native-engine-crash|on-device engine crashed/i;
const CUDA_INVALID_ARGUMENT = /CUDA error:\s*invalid (?:configuration )?argument/i;
const LLAMA_SIGABRT = /\[llama-server\][^\n]*(?:signal=SIGABRT|"signal":"SIGABRT")/i;
const STRUCTURED_CUDA_CRASH =
  /"expected":false[^\n]*"panicKind":"cuda-[^"]+"|"panicKind":"cuda-[^"]+"[^\n]*"expected":false/i;
const JINJA_TEMPLATE_500 = /Jinja Exception: Conversation roles must alternate/;
const VOORMAN_SCHEDULER_SKIP = /skip meester nudge — voorman is the Meester/;

/** Minimum repeats before a log signature counts as the cause: a single
 * Jinja 500 can be recovered from; a single scheduler skip is routine. */
const JINJA_MIN_OCCURRENCES = 3;
const VOORMAN_SKIP_MIN_OCCURRENCES = 10;

export function classifyTrial(input: ClassifyTrialInput): FailureClassification {
  if (input.success) {
    return { failureClass: 'pass', rule: 'pass' };
  }

  const reason = input.reason ?? '';

  if (input.failureMode === 'interrupted' || /interrupted \(SIG(INT|TERM)/.test(reason)) {
    return { failureClass: 'operator', rule: 'operator-interrupt', evidence: reason.slice(0, 140) };
  }

  const capacity = findInReasonOrLog(input, CAPACITY_DENIAL);
  if (capacity) {
    return { failureClass: 'infra', rule: 'capacity-denial', evidence: capacity };
  }

  const overflow = findInReasonOrLog(input, CONTEXT_OVERFLOW);
  if (overflow) {
    return { failureClass: 'infra', rule: 'context-overflow', evidence: overflow };
  }

  const incidentText = input.nativeIncidentLog ?? '';
  const combinedCrashText = `${reason}\n${input.daemonLog ?? ''}\n${incidentText}`;
  const typedNativeCrash = NATIVE_ENGINE_CRASH_REASON.test(combinedCrashText);
  const structuredCudaCrash = STRUCTURED_CUDA_CRASH.test(combinedCrashText);
  const rawCudaAbort =
    CUDA_INVALID_ARGUMENT.test(combinedCrashText) && LLAMA_SIGABRT.test(combinedCrashText);
  if (
    input.failureMode === 'engine-crash' ||
    ((isStallish(input) || input.failureMode === 'crash') &&
      (typedNativeCrash || structuredCudaCrash || rawCudaAbort))
  ) {
    const match = combinedCrashText.match(
      /[^\n]*(?:native-engine-crash|on-device engine crashed|"panicKind":"cuda-[^"]+"|CUDA error:\s*invalid (?:configuration )?argument)[^\n]*/i,
    );
    return {
      failureClass: 'infra',
      rule:
        structuredCudaCrash || rawCudaAbort || CUDA_INVALID_ARGUMENT.test(combinedCrashText)
          ? 'cuda-engine-crash'
          : 'native-engine-crash',
      evidence: (match?.[0] ?? reason).slice(0, 240),
    };
  }
  if (input.failureMode === 'crash') {
    return { failureClass: 'infra', rule: 'daemon-crash', evidence: reason.slice(0, 140) };
  }
  if (input.failureMode === 'spawn-error') {
    return { failureClass: 'infra', rule: 'spawn-error', evidence: reason.slice(0, 140) };
  }
  if (input.failureMode === 'engine-hung' || ENGINE_HUNG_REASON.test(reason)) {
    return { failureClass: 'infra', rule: 'engine-hung', evidence: reason.slice(0, 140) };
  }

  if (isStallish(input) && input.daemonLog) {
    // A render that opened and never completed at kill time means the
    // trial died waiting on (or was killed holding) a native image job —
    // the June 1-2 GPU-arbiter-vs-watchdog class.
    const activity = parseDaemonActivityText(input.daemonLog);
    if (activity.imageGenerationActive) {
      return {
        failureClass: 'infra',
        rule: 'render-killed',
        evidence: 'generate_image started with no completion before the trial ended',
      };
    }
    const jinja = countInLog(input, JINJA_TEMPLATE_500);
    if (jinja >= JINJA_MIN_OCCURRENCES) {
      return {
        failureClass: 'infra',
        rule: 'chat-template-500',
        evidence: `${jinja}× "Conversation roles must alternate" 500s from llama-server`,
      };
    }
    const voorman = countInLog(input, VOORMAN_SCHEDULER_SKIP);
    if (voorman >= VOORMAN_SKIP_MIN_OCCURRENCES) {
      return {
        failureClass: 'infra',
        rule: 'scheduler-voorman-deadlock',
        evidence: `${voorman}× "[scheduler] skip meester nudge — voorman is the Meester" (project never driven)`,
      };
    }
  }

  return { failureClass: 'model', rule: 'model-default' };
}

/** Parse the dedicated JSONL reliability log. Malformed/expected rows are ignored. */
export function summarizeNativeEngineIncidents(
  jsonl: string | null | undefined,
): NativeEngineIncidentSummary | undefined {
  if (!jsonl) return undefined;
  const kinds: Record<string, number> = {};
  const incidentIds: string[] = [];
  const evidence: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.expected !== false || typeof row.incidentId !== 'string') continue;
      const kind = typeof row.panicKind === 'string' ? row.panicKind : 'unexpected-exit';
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      incidentIds.push(row.incidentId);
      const panicLine = typeof row.panicLine === 'string' ? row.panicLine : '';
      const signal = typeof row.signal === 'string' ? row.signal : '';
      evidence.push((panicLine || `${kind}${signal ? ` (${signal})` : ''}`).slice(0, 240));
    } catch {
      // One partial line must not hide later complete incidents.
    }
  }
  if (incidentIds.length === 0) return undefined;
  return { count: incidentIds.length, kinds, incidentIds, evidence };
}
