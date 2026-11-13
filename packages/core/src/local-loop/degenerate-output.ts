/**
 * Output no healthy model produces, and what it says about the engine.
 *
 * Wild-caught 2026-11-10 (squisq/37, qwen3.8-27b-q4 on llama.cpp v0.9.0,
 * ROCm, MTP drafting): partway through one reply the engine process started
 * emitting the single token "/" and never recovered. Every later reply, from
 * any gezel and any prompt, was "/" repeated to the output cap: 12,288 or
 * 16,384 tokens at ~16 tok/s, 13 to 16 minutes a turn, for five hours across
 * three night-shift tasks. Two things let it run:
 *
 * - Nothing watched the thinking channel. llama-server sends thinking as
 *   `reasoning_content`, which the ramble detector never reads, and the
 *   ramble detector's guards are built for prose loops anyway: its novelty
 *   guard needs eight distinct words and its stuck-line guard needs
 *   newlines, so a run of one character passes both.
 * - Every retry went back to the same broken process. Draft acceptance had
 *   fallen from 0.83 to exactly 0 (0 of 49,143 drafted tokens accepted), a
 *   signal the turn loop received in every reply's timings and ignored.
 *
 * {@link DegenerateRunDetector} catches the first; {@link DraftAcceptanceMonitor}
 * catches the second. Either one ends the turn. A draft collapse restarts the
 * engine without saving what it holds; repeated output does so on its second
 * run ({@link DegenerateStrikes}), since a model can loop on its own.
 */

/** One character, or a cycle of up to this many, repeated. */
export const DEGENERATE_RUN_MAX_PERIOD = 8;

/**
 * Trailing thinking that repeats one short unit for this many characters ends
 * the turn. Thinking is never asked to repeat anything, and the longest
 * legitimate run in practice is a divider line of ~80 characters. At the
 * incident's one character per token this is about a minute of decode, not
 * thirteen.
 */
export const DEGENERATE_REASONING_RUN_CHARS = 1024;

/**
 * Visible replies get four times the room: a person can ask for a long run
 * of one character, and a reply never has a reason to pad 4 KB with one.
 */
export const DEGENERATE_CONTENT_RUN_CHARS = 4096;

export type DegenerateChannel = 'reasoning' | 'content';

export interface DegenerateRun {
  channel: DegenerateChannel;
  /** The repeating unit, at most {@link DEGENERATE_RUN_MAX_PERIOD} characters. */
  unit: string;
  /** Characters of the trailing run seen when the detector fired. */
  length: number;
}

/**
 * Watches one streamed channel for a trailing run of a short repeating unit.
 * Fed chunk by chunk; keeps only a bounded tail, so each chunk costs at most
 * `minRun × maxPeriod` character comparisons, and healthy text fails on the
 * first one for nearly every period.
 */
export class DegenerateRunDetector {
  private tail = '';
  private fired = false;

  constructor(
    private readonly channel: DegenerateChannel,
    private readonly minRun: number,
    private readonly maxPeriod: number = DEGENERATE_RUN_MAX_PERIOD,
  ) {}

  /** Append the next chunk; returns the run the first time the tail turns degenerate. */
  observe(chunk: string): DegenerateRun | null {
    if (this.fired || chunk.length === 0) return null;
    this.tail += chunk;
    const keep = this.minRun * 2;
    if (this.tail.length > keep) this.tail = this.tail.slice(this.tail.length - keep);
    if (this.tail.length < this.minRun) return null;
    const end = this.tail.length;
    const start = end - this.minRun;
    for (let period = 1; period <= this.maxPeriod; period++) {
      if (!this.isPeriodic(start, end, period)) continue;
      this.fired = true;
      let runStart = start;
      while (
        runStart > 0 &&
        this.tail.charCodeAt(runStart - 1) === this.tail.charCodeAt(runStart - 1 + period)
      ) {
        runStart--;
      }
      return {
        channel: this.channel,
        unit: this.tail.slice(end - period, end),
        length: end - runStart,
      };
    }
    return null;
  }

  /** True when every character in `[start, end)` equals the one `period` before it. */
  private isPeriodic(start: number, end: number, period: number): boolean {
    for (let i = end - 1; i >= start + period; i--) {
      if (this.tail.charCodeAt(i) !== this.tail.charCodeAt(i - period)) return false;
    }
    return true;
  }
}

export interface DraftAcceptanceSample {
  /** Tokens the drafter proposed this reply (llama-server `timings.draft_n`). */
  drafted: number;
  /** Of those, tokens the target model accepted (`timings.draft_n_accepted`). */
  accepted: number;
}

export type DraftAcceptanceVerdict =
  | { sick: false }
  | { sick: true; acceptance: number; baseline: number; drafted: number; accepted: number };

/** A reply below this acceptance, on an engine that did far better, means the engine broke. */
export const SICK_DRAFT_ACCEPTANCE = 0.01;
/** Drafted tokens a reply needs before its acceptance can condemn the engine. */
export const MIN_DRAFTED_FOR_SICK_VERDICT = 2000;
/** What the same engine process must have reached earlier for a collapse to count. */
export const HEALTHY_DRAFT_ACCEPTANCE = 0.25;
/** Drafted tokens a reply needs before its acceptance counts toward the baseline. */
export const MIN_DRAFTED_FOR_BASELINE = 500;

/**
 * Judges a reply's draft acceptance against what the same engine process
 * achieved before. A drafter's own quality varies by model and backend, and
 * some legitimately collapse with context (DFlash v1 on Vulkan), so a low
 * number alone proves nothing. What proves the engine broke is a fall to
 * nearly zero on a process that earlier accepted a quarter or more: the
 * drafter reads the target's hidden states, so when they turn to garbage the
 * two stop agreeing on anything.
 */
export class DraftAcceptanceMonitor {
  private baseline: number | null = null;
  private engineKey: unknown;

  /**
   * `engineKey` names the engine process (its pid). A new key starts a new
   * record: a restarted engine has to earn its baseline again.
   */
  observe(sample: DraftAcceptanceSample, engineKey?: unknown): DraftAcceptanceVerdict {
    if (engineKey !== this.engineKey) {
      this.engineKey = engineKey;
      this.baseline = null;
    }
    const { drafted, accepted } = sample;
    if (!Number.isFinite(drafted) || !Number.isFinite(accepted) || drafted <= 0) {
      return { sick: false };
    }
    const acceptance = Math.max(0, accepted) / drafted;
    if (
      drafted >= MIN_DRAFTED_FOR_SICK_VERDICT &&
      acceptance < SICK_DRAFT_ACCEPTANCE &&
      this.baseline !== null &&
      this.baseline >= HEALTHY_DRAFT_ACCEPTANCE
    ) {
      return { sick: true, acceptance, baseline: this.baseline, drafted, accepted };
    }
    if (drafted >= MIN_DRAFTED_FOR_BASELINE) {
      this.baseline = Math.max(this.baseline ?? 0, acceptance);
    }
    return { sick: false };
  }

  reset(): void {
    this.baseline = null;
    this.engineKey = undefined;
  }
}

/** What the engine host did about degenerate output. */
export type DegenerateRecovery =
  /** The engine was stopped without saving; the next request starts a fresh process. */
  | 'restarted'
  /** One run of repeated output: the turn ended, the engine stays for its other turns. */
  | 'kept'
  /** The host cannot restart this engine (an external server). */
  | 'unavailable';

/** A host from before {@link DegenerateRecovery} answered whether it restarted. */
export function normalizeDegenerateRecovery(
  value: DegenerateRecovery | boolean | undefined,
): DegenerateRecovery {
  if (value === true) return 'restarted';
  if (value === false || value === undefined) return 'unavailable';
  return value;
}

/** A second run of repeated output on the same engine within this window condemns it. */
export const DEGENERATE_STRIKE_WINDOW_MS = 30 * 60_000;

/**
 * Whether repeated output condemns the engine. A model can loop on its own
 * ("wait, wait, …"), and a restart ends every other turn the engine is
 * serving, so one run only ends its turn. A second run on the same engine
 * process within {@link DEGENERATE_STRIKE_WINDOW_MS} is the engine: the
 * incident's process repeated "/" in every reply, from every gezel.
 */
export class DegenerateStrikes {
  private engineKey: unknown;
  private lastAt: number | null = null;

  /** Record one run; true when it condemns the engine. `engineKey` names the process. */
  strike(engineKey: unknown, now: number = Date.now()): boolean {
    if (engineKey !== this.engineKey) {
      this.engineKey = engineKey;
      this.lastAt = null;
    }
    const condemned = this.lastAt !== null && now - this.lastAt <= DEGENERATE_STRIKE_WINDOW_MS;
    this.lastAt = condemned ? null : now;
    return condemned;
  }

  reset(): void {
    this.engineKey = undefined;
    this.lastAt = null;
  }
}

/** What the turn loop hands the engine host when it gives up on the engine's output. */
export type DegenerateEngineReport =
  | ({ kind: 'repeated-output'; sessionId?: string } & DegenerateRun)
  | {
      kind: 'draft-collapse';
      sessionId?: string;
      drafted: number;
      accepted: number;
      baseline: number;
    };

function showUnit(unit: string): string {
  return JSON.stringify(unit);
}

function percent(n: number): string {
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}

/** One line for logs: what was wrong with the output. */
export function describeDegenerateReport(report: DegenerateEngineReport): string {
  if (report.kind === 'repeated-output') {
    return `repeated ${showUnit(report.unit)} for ${report.length} chars of ${report.channel}`;
  }
  return `draft acceptance ${percent(report.accepted / report.drafted)} (${report.accepted}/${report.drafted}) after ${percent(report.baseline)} earlier on the same engine`;
}

/** The technical record and corrective; lands on the aborted turn's warnings. */
export function buildDegenerateModelMessage(
  providerLabel: string,
  report: DegenerateEngineReport,
  recovery: DegenerateRecovery | boolean,
): string {
  const outcome = normalizeDegenerateRecovery(recovery);
  if (outcome === 'kept' && report.kind === 'repeated-output') {
    return `${providerLabel} stopped this turn: the output repeated ${showUnit(report.unit)} for ${report.length} characters of ${report.channel === 'reasoning' ? 'thinking' : 'reply'}. Continue the work from where it stood, without repeating yourself.`;
  }
  const what =
    report.kind === 'repeated-output'
      ? `the engine repeated ${showUnit(report.unit)} for ${report.length} characters of ${report.channel === 'reasoning' ? 'thinking' : 'reply'}`
      : `the engine's output stopped matching its own draft model (${describeDegenerateReport(report)})`;
  return `${providerLabel} stopped this turn: ${what}. That is a fault in the engine, not in your work. ${
    outcome === 'restarted'
      ? 'The engine was restarted without its saved state; continue the work from where it stood.'
      : 'The engine could not be restarted from here.'
  }`;
}

/** Plain words for the failure banner. */
export function buildDegenerateUserMessage(
  report: DegenerateEngineReport,
  recovery: DegenerateRecovery | boolean,
): string {
  const outcome = normalizeDegenerateRecovery(recovery);
  if (outcome === 'kept' && report.kind === 'repeated-output') {
    return `The on-device model got stuck repeating ${showUnit(report.unit)}, so Gezel stopped it. Try again.`;
  }
  const what =
    report.kind === 'repeated-output'
      ? `The on-device model got stuck repeating ${showUnit(report.unit)} and produced nothing usable.`
      : 'The on-device model started producing output that made no sense.';
  return outcome === 'restarted'
    ? `${what} Gezel restarted it. Try again.`
    : `${what} Restart the on-device engine, then try again.`;
}
