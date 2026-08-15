import { join } from 'node:path';
import { type GezelConfig, createLogger } from '@bendyline/gezel';
import type { QuotaBucket, UsageTracker } from '../chat/usage.js';
import {
  type ClaudeQuotaSnapshot,
  readClaudeQuotaSnapshot,
} from '../providers/anthropic-cli/quota.js';
import { getCliPresence } from '../providers/cli-detection.js';
import { readCodexQuotaBucketsCached } from '../providers/codex-cli/quota.js';
import type { ProviderName } from '../providers/types.js';

const log = createLogger('night-shift');

export const DEFAULT_QUOTA_RESERVE_OVERALL_PERCENT = 20;
export const DEFAULT_QUOTA_RESERVE_PER_DAY_PERCENT = 10;

/** The only providers that report account quota today. */
export const QUOTA_RESERVE_PROVIDERS = ['copilot', 'anthropic-cli', 'codex-cli'] as const;

export type QuotaReserveRule = 'overall' | 'per-day';

export type QuotaReserveConfig = NonNullable<
  NonNullable<GezelConfig['nightShift']>['quotaReserve']
>;

/** Why one bucket failed the reserve check (provider attached by the gate). */
export interface QuotaReserveViolation {
  /** Provider bucket id that tripped the reserve (e.g. "premium_interactions"). */
  bucket: string;
  /** Derived remaining, 0-100, one decimal. */
  remainingPercent: number;
  /** Effective floor that triggered the hold, 0-100, one decimal. */
  floorPercent: number;
  /** Which enabled rule produced the winning floor ('overall' on ties). */
  rule: QuotaReserveRule;
  resetDate?: string;
}

export interface QuotaReserveHold extends QuotaReserveViolation {
  provider: ProviderName;
}

/**
 * Whether any reserve rule is in force. The overall rule is ON by default
 * (absent config = enabled at 20%); the per-day rule is opt-in.
 */
export function quotaReserveEnabled(reserve: QuotaReserveConfig | undefined): boolean {
  return reserve?.overall?.enabled !== false || reserve?.perDay?.enabled === true;
}

/**
 * Pure reserve policy for one provider's quota buckets. Returns the most
 * severe violation (smallest remaining-minus-floor margin; ties broken by
 * bucket order) or null to allow.
 *
 * Per bucket: skip unlimited buckets and buckets with no measurable
 * consumption (`limit <= 0 && used <= 0` — Copilot's parser defaults a
 * missing `remainingPercentage` to 1, which would otherwise read as "1%
 * left" for a bucket that never reported data). Remaining% derives from
 * `used / limit` when a real limit exists, else trusts `remainingPercent`
 * (0-100 for every quota provider). The effective floor is the max of the
 * applicable rules, clamped to 0-100; a bucket without a future
 * `resetDate` skips the per-day rule. Hold when remaining <= floor.
 */
export function evaluateQuotaReserve(
  buckets: QuotaBucket[],
  reserve: QuotaReserveConfig | undefined,
  now: Date,
): QuotaReserveViolation | null {
  const overallOn = reserve?.overall?.enabled !== false;
  const perDayOn = reserve?.perDay?.enabled === true;
  if (!overallOn && !perDayOn) return null;
  const overallFloor = clampPercent(
    reserve?.overall?.percent ?? DEFAULT_QUOTA_RESERVE_OVERALL_PERCENT,
  );
  const perDayPercent = clampPercent(
    reserve?.perDay?.percent ?? DEFAULT_QUOTA_RESERVE_PER_DAY_PERCENT,
  );

  let worst: QuotaReserveViolation | null = null;
  let worstMargin = Number.POSITIVE_INFINITY;
  for (const bucket of buckets) {
    if (bucket.isUnlimited) continue;
    if (bucket.limit <= 0 && bucket.used <= 0) continue;
    const remaining =
      bucket.limit > 0
        ? clampPercent(100 - (bucket.used / bucket.limit) * 100)
        : clampPercent(bucket.remainingPercent);

    let floor = -1;
    let rule: QuotaReserveRule = 'overall';
    if (overallOn) {
      floor = overallFloor;
    }
    if (perDayOn) {
      const daysLeft = fractionalDaysUntil(bucket.resetDate, now);
      if (daysLeft !== null) {
        const perDayFloor = clampPercent(perDayPercent * daysLeft);
        if (perDayFloor > floor) {
          floor = perDayFloor;
          rule = 'per-day';
        }
      }
    }
    if (floor < 0 || remaining > floor) continue;

    const margin = remaining - floor;
    if (margin < worstMargin) {
      worstMargin = margin;
      worst = {
        bucket: bucket.name,
        remainingPercent: roundOne(remaining),
        floorPercent: roundOne(floor),
        rule,
        ...(bucket.resetDate ? { resetDate: bucket.resetDate } : {}),
      };
    }
  }
  return worst;
}

export interface NightShiftQuotaGateOptions {
  store: { readConfig(): Promise<GezelConfig> };
  usage: UsageTracker;
  /** GEZEL_HOME — locates the anthropic-cli runtime snapshot. */
  home: string;
  /** Clock override for tests. */
  now?: () => Date;
  /** Probe seams for tests; production uses the real readers. */
  probes?: {
    claude?: (runtimeDir: string) => Promise<ClaudeQuotaSnapshot | null>;
    codex?: (opts: { binaryPath: string }) => Promise<QuotaBucket[]>;
  };
}

/**
 * Verdict source for the Night Shift quota reserve. `TaskRunner` asks it
 * per night handoff at admission ("may this provider take another turn?")
 * and `NightShiftManager` asks it per pending night task to tell held
 * work from dispatchable work. Verdicts are recomputed per call — quota
 * only decreases until a window resets, and a mid-window reset must
 * reopen the gate on the next tick, so nothing here latches.
 *
 * Freshness per provider mirrors the usage route: Copilot only reports
 * through turn events (empty tracker = allow, optimistically — the first
 * night turn populates it); anthropic-cli is a cheap snapshot-file read;
 * codex-cli probes `codex app-server` behind its 60s success/failure
 * cache, and only ever from here when a night handoff actually resolves
 * to codex-cli.
 */
export class NightShiftQuotaGate {
  private readonly store: { readConfig(): Promise<GezelConfig> };
  private readonly usage: UsageTracker;
  private readonly home: string;
  private readonly now: () => Date;
  private readonly claudeProbe: (runtimeDir: string) => Promise<ClaudeQuotaSnapshot | null>;
  private readonly codexProbe: (opts: { binaryPath: string }) => Promise<QuotaBucket[]>;
  /** Last verdict key per provider, to log transitions rather than every call. */
  private readonly lastVerdict = new Map<ProviderName, string | null>();

  constructor(opts: NightShiftQuotaGateOptions) {
    this.store = opts.store;
    this.usage = opts.usage;
    this.home = opts.home;
    this.now = opts.now ?? (() => new Date());
    this.claudeProbe = opts.probes?.claude ?? readClaudeQuotaSnapshot;
    this.codexProbe = opts.probes?.codex ?? readCodexQuotaBucketsCached;
  }

  /**
   * Reserve verdict for one provider. Never throws; unknown or absent
   * quota data allows. Fast-paths to null — before any probe — when no
   * rule is enabled or the provider does not report quota.
   */
  async holdFor(provider: ProviderName): Promise<QuotaReserveHold | null> {
    try {
      if (!(QUOTA_RESERVE_PROVIDERS as readonly string[]).includes(provider)) return null;
      const config = await this.store.readConfig();
      const reserve = config.nightShift?.quotaReserve;
      if (!quotaReserveEnabled(reserve)) return null;
      const buckets = await this.bucketsFor(provider, config);
      const violation = evaluateQuotaReserve(buckets, reserve, this.now());
      const hold = violation ? { provider, ...violation } : null;
      this.logTransition(provider, hold);
      return hold;
    } catch {
      return null;
    }
  }

  private async bucketsFor(provider: ProviderName, config: GezelConfig): Promise<QuotaBucket[]> {
    if (provider === 'anthropic-cli') {
      const snapshot = await this.claudeProbe(join(this.home, 'runtime', 'anthropic-cli')).catch(
        () => null,
      );
      if (snapshot) {
        // A snapshot with zero windows is authoritative (post-logout clear).
        this.usage.recordQuotaBuckets('anthropic-cli', snapshot.buckets, snapshot.capturedAt);
        return snapshot.buckets;
      }
      return this.usage.quotaBucketsFor('anthropic-cli');
    }
    if (provider === 'codex-cli') {
      const detections = getCliPresence(config.codexCli ? { codexCli: config.codexCli } : {});
      const binaryPath = detections.codexCli.installed ? detections.codexCli.path : undefined;
      if (binaryPath) {
        const buckets = await this.codexProbe({ binaryPath }).catch(() => null);
        if (buckets) {
          this.usage.recordQuotaBuckets('codex-cli', buckets);
          return buckets;
        }
      }
      return this.usage.quotaBucketsFor('codex-cli');
    }
    return this.usage.quotaBucketsFor(provider);
  }

  private logTransition(provider: ProviderName, hold: QuotaReserveHold | null): void {
    const prev = this.lastVerdict.get(provider);
    const key = hold ? `${hold.bucket}:${hold.rule}` : null;
    if (prev === key) return;
    this.lastVerdict.set(provider, key);
    if (hold) {
      log.info(
        `[night-shift] quota reserve holding ${provider}: ${hold.bucket} at ` +
          `${hold.remainingPercent}% remaining (floor ${hold.floorPercent}%, ${hold.rule})`,
      );
    } else if (typeof prev === 'string') {
      log.info(`[night-shift] quota reserve released ${provider}`);
    }
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function fractionalDaysUntil(resetDate: string | undefined, now: Date): number | null {
  if (!resetDate) return null;
  const resetAt = new Date(resetDate).getTime();
  if (Number.isNaN(resetAt)) return null;
  const ms = resetAt - now.getTime();
  if (ms <= 0) return null;
  return ms / 86_400_000;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
