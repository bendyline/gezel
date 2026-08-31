import type { IndexReadinessReport, WorkspaceIndexStatus } from '@bendyline/gezel';
import { AwakeBudget, awakeNow, createLogger } from '@bendyline/gezel';
import type { DriveIntensity } from './enrichment-manager.js';

const log = createLogger('index-readiness');

/**
 * ─ Index readiness ───────────────────────────────────────────────────
 *
 * The ENSURE half of "this craftbook depends on a current index": make the
 * static index current synchronously, kick the AI tiers, wait a bounded
 * awake-time budget for them to drain, and return an honest snapshot either
 * way. Exposed to sandboxed scripts as `gezel.index.ensureFresh` so a
 * review craftbook's `onEnter` hook can persist the snapshot as a
 * launch-time coverage artifact.
 *
 * Three rules keep this from hanging or lying:
 *   - On a project with no Boekwachter, the summarize/shadow/review counts
 *     can NEVER reach zero (`runDrive` returns after the embed tiers), so
 *     those tiers are excluded from the drain target and reported as
 *     unachievable instead of awaited.
 *   - The wait races the drive against an {@link AwakeBudget} — host sleep
 *     must not count against the caller (see the awake-time convention in
 *     CLAUDE.md). On expiry the drive keeps running in the background; only
 *     the wait ends.
 *   - Nothing here throws for ordinary states (disabled indexing, paused
 *     job, empty project). The report carries the caveats; the craftbook
 *     cites them.
 */

export interface IndexReadinessDeps {
  workspaceIndex: {
    statusForUi(projectId: string): Promise<WorkspaceIndexStatus>;
    refreshAndWait(projectId: string): Promise<WorkspaceIndexStatus>;
  };
  enrichment: {
    drive(
      projectId: string,
      opts: { intensity: DriveIntensity; reviews?: boolean },
    ): { started: boolean; alreadyRunning: boolean };
    awaitDrive(projectId: string): Promise<void> | null;
    driveMode(projectId: string): DriveIntensity | null;
  };
  /** Resolves the project's Boekwachter, or null when the crew has none. */
  resolveBoekwachter(projectId: string): Promise<unknown | null>;
  /** Install-wide indexing-job pause switch. */
  isPaused(): Promise<boolean> | boolean;
  /**
   * Whether the engagement mode currently permits the model-backed tiers.
   * False under "Reactive only"/"Off", where the drive returns after the
   * local embed tiers — so the AI counts can never drain and must be
   * reported unachievable rather than awaited, exactly like an unstaffed
   * crew. Absent (tests) means allowed.
   */
  aiTiersAllowed?(): Promise<boolean> | boolean;
  now?: () => Date;
}

export interface EnsureIndexFreshOptions {
  /**
   * Awake-time budget to wait for the AI tiers (ms). Clamped to
   * {@link MAX_WAIT_BUDGET_MS} — callers are sandboxed scripts whose whole
   * run is bounded (default 5 min), and an expired wait is not a failure:
   * the drive continues in the background and the snapshot says so.
   */
  waitBudgetMs?: number;
  /** Wait for the per-file AI review tier too (default true). */
  reviews?: boolean;
}

export const DEFAULT_WAIT_BUDGET_MS = 180_000;
/** Below the script runner's 5-minute default run timeout, with headroom. */
export const MAX_WAIT_BUDGET_MS = 240_000;

const POLL_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

interface TierCounts {
  embedOnlyPending: number;
  shadowsPending: number;
  summariesPending: number;
  reviewsPending: number;
}

function tierCounts(status: WorkspaceIndexStatus): TierCounts {
  const e = status.enrichment;
  return {
    embedOnlyPending: e?.embedOnlyPending ?? 0,
    shadowsPending: e?.shadowsPending ?? 0,
    summariesPending: e?.pending ?? 0,
    reviewsPending: e?.reviews?.pending ?? 0,
  };
}

function drained(counts: TierCounts, aiAchievable: boolean, wantReviews: boolean): boolean {
  if (counts.embedOnlyPending > 0) return false;
  if (!aiAchievable) return true;
  if (counts.shadowsPending > 0 || counts.summariesPending > 0) return false;
  return !wantReviews || counts.reviewsPending === 0;
}

function buildReport(args: {
  projectId: string;
  status: WorkspaceIndexStatus;
  staffed: boolean;
  paused: boolean;
  /** `paused` is set because of the engagement mode, not the job switch. */
  pausedByEngagement?: boolean;
  wantReviews: boolean;
  budgetMs: number;
  waitedMs: number;
  driveStillRunning: boolean;
  now: () => Date;
}): IndexReadinessReport {
  const { status, staffed, paused } = args;
  const indexingEnabled = status.state !== 'disabled';
  const achievable = indexingEnabled && staffed && !paused;
  const counts = tierCounts(status);
  const e = status.enrichment;
  const isDrained = indexingEnabled && drained(counts, achievable, args.wantReviews);

  const notes: string[] = [];
  if (!indexingEnabled) {
    notes.push(
      'Indexing is turned off for this project (Project → Settings), so no index-backed tool has data. The review must rely on direct file reads and say so.',
    );
  } else {
    if (!staffed) {
      notes.push(
        'No Boekwachter gezel is on this project crew, so the AI tiers (per-file reviews, summaries, Boekwachter issues) cannot run and their pending counts will never drain. Static index and search coverage below are still meaningful. Add a Boekwachter to the crew to unlock per-file AI review coverage.',
      );
    }
    if (paused) {
      notes.push(
        args.pausedByEngagement
          ? 'AI activity is set to "Reactive only" or "Off", so the AI indexing tiers are standing down; AI index coverage will not improve until task work is allowed again. Static index and search coverage below are still current.'
          : 'The indexing job is paused install-wide; AI index coverage will not improve until it is resumed.',
      );
    }
    if (e?.vectorsAvailable === false) {
      notes.push(
        'Vector storage is unavailable for this index — semantic search runs keyword-only.',
      );
    }
    if (!isDrained && args.driveStillRunning) {
      notes.push(
        'The index catch-up was still running when the wait budget expired; it continues in the background. Coverage numbers are a snapshot taken at report time, not the final state.',
      );
    }
    if ((e?.skipped ?? 0) > 0) {
      notes.push(
        `${e?.skipped} file(s) were skipped after repeated enrichment failures and will not be retried until they change.`,
      );
    }
  }

  const searchReady =
    indexingEnabled && counts.embedOnlyPending === 0 && e?.vectorsAvailable !== false;

  return {
    version: 1,
    projectId: args.projectId,
    generatedAt: args.now().toISOString(),
    indexingEnabled,
    staticState: status.state,
    ...(status.meta?.fileCount !== undefined ? { fileCount: status.meta.fileCount } : {}),
    ...(status.meta?.scannedAt !== undefined ? { scannedAt: status.meta.scannedAt } : {}),
    search: {
      ready: searchReady,
      ...(e?.eligible !== undefined ? { eligible: e.eligible } : {}),
      ...(e?.searchReady !== undefined ? { embedded: e.searchReady } : {}),
      ...(e?.embedOnlyPending !== undefined ? { pendingEmbedOnly: e.embedOnlyPending } : {}),
      ...(e?.embedModel !== undefined ? { embedModel: e.embedModel } : {}),
      ...(e?.vectorsAvailable !== undefined ? { vectorsAvailable: e.vectorsAvailable } : {}),
    },
    aiTier: {
      staffed,
      paused,
      achievable,
      ...(e?.eligible !== undefined ? { summariesEligible: e.eligible } : {}),
      ...(e?.summarized !== undefined ? { summarized: e.summarized } : {}),
      ...(e?.pending !== undefined ? { summariesPending: e.pending } : {}),
      ...(e?.shadowsPending !== undefined ? { shadowsPending: e.shadowsPending } : {}),
      ...(e?.skipped !== undefined ? { skipped: e.skipped } : {}),
      ...(e?.reviews ? { reviews: e.reviews } : {}),
    },
    wait: {
      budgetMs: args.budgetMs,
      waitedMs: args.waitedMs,
      drained: isDrained,
      driveStillRunning: args.driveStillRunning,
    },
    notes,
  };
}

/**
 * The AI tiers stand down for two independent reasons — the nachtwacht job
 * switch and the engagement mode — with the same consequence for the drain
 * target. Resolved together so the report can name the right one.
 */
async function aiTierHold(
  deps: IndexReadinessDeps,
): Promise<{ paused: boolean; pausedByEngagement: boolean }> {
  const jobPaused = await deps.isPaused();
  const allowed = deps.aiTiersAllowed ? await deps.aiTiersAllowed() : true;
  return { paused: jobPaused || !allowed, pausedByEngagement: !jobPaused && !allowed };
}

/** Read-only readiness snapshot — no refresh, no drive, no wait. */
export async function indexReadinessSnapshot(
  deps: IndexReadinessDeps,
  projectId: string,
): Promise<IndexReadinessReport> {
  const status = await deps.workspaceIndex.statusForUi(projectId);
  const staffed =
    status.state === 'disabled' ? false : (await deps.resolveBoekwachter(projectId)) !== null;
  return buildReport({
    projectId,
    status,
    staffed,
    ...(await aiTierHold(deps)),
    wantReviews: true,
    budgetMs: 0,
    waitedMs: 0,
    driveStillRunning: deps.enrichment.driveMode(projectId) !== null,
    now: deps.now ?? (() => new Date()),
  });
}

/**
 * Make the project index as fresh as it can get within an awake-time
 * budget: awaited static re-scan, then a full-intensity AI drive raced
 * against the budget. Always resolves with a report; never throws for
 * ordinary states.
 */
export async function ensureIndexFresh(
  deps: IndexReadinessDeps,
  projectId: string,
  opts: EnsureIndexFreshOptions = {},
): Promise<IndexReadinessReport> {
  const now = deps.now ?? (() => new Date());
  const wantReviews = opts.reviews !== false;
  const budgetMs = Math.max(
    0,
    Math.min(opts.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS, MAX_WAIT_BUDGET_MS),
  );
  const budget = new AwakeBudget(budgetMs);
  const startedAt = awakeNow();
  const waited = () => Math.max(0, Math.round(awakeNow() - startedAt));

  let status = await deps.workspaceIndex.statusForUi(projectId);
  if (status.state === 'disabled') {
    return buildReport({
      projectId,
      status,
      staffed: false,
      ...(await aiTierHold(deps)),
      wantReviews,
      budgetMs,
      waitedMs: 0,
      driveStillRunning: false,
      now,
    });
  }

  // Static tier: a `fresh` state means the scan ran within the MRU staleness
  // threshold (≤ 60s for the active project) — current enough to skip a
  // whole-tree rescan. Anything else is awaited so the AI tiers below never
  // summarize against yesterday's file list.
  if (status.state !== 'fresh') {
    status = await deps.workspaceIndex.refreshAndWait(projectId);
  }

  const staffed = (await deps.resolveBoekwachter(projectId)) !== null;
  const hold = await aiTierHold(deps);
  const paused = hold.paused;
  const achievable = staffed && !paused;

  status = await deps.workspaceIndex.statusForUi(projectId);
  if (
    !drained(tierCounts(status), achievable, wantReviews) &&
    budget.remainingMs() > 0 &&
    !paused
  ) {
    // Full intensity: the caller asked for a current index and is waiting on
    // it — the drive competes like interactive work. A second request joins
    // the running drive, so this is safe against the night catch-up sweep.
    deps.enrichment.drive(projectId, { intensity: 'full', reviews: wantReviews });
    const drive = deps.enrichment.awaitDrive(projectId);
    if (drive) {
      let driveSettled = false;
      const settled = drive.then(() => {
        driveSettled = true;
      });
      // Poll the deadline in short slices instead of arming one long timer —
      // an armed timer fires on the wake-up burst after host sleep, which is
      // the bug the awake-time convention exists to prevent. Each slice races
      // the drive so completion is seen immediately, not at the next poll.
      while (!driveSettled && !budget.expired()) {
        await Promise.race([
          settled,
          sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, budget.remainingMs()))),
        ]);
      }
      if (!driveSettled) {
        log.info(
          `[readiness] ${projectId}: wait budget (${budgetMs}ms awake) expired with the drive still running — returning snapshot`,
        );
      }
    }
    status = await deps.workspaceIndex.statusForUi(projectId);
  }

  return buildReport({
    projectId,
    status,
    staffed,
    paused,
    pausedByEngagement: hold.pausedByEngagement,
    wantReviews,
    budgetMs,
    waitedMs: waited(),
    driveStillRunning: deps.enrichment.driveMode(projectId) !== null,
    now,
  });
}
