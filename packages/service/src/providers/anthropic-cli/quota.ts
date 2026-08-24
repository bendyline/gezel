import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { QuotaBucket } from '../../chat/usage.js';
import { writeFileAtomic } from '../../fs/atomic.js';

const CAPTURE_SCRIPT_NAME = 'quota-statusline.mjs';
const SNAPSHOT_NAME = 'quota.json';

export interface ClaudeQuotaSnapshot {
  buckets: QuotaBucket[];
  capturedAt: string;
}

/**
 * Stage a Claude Code `statusLine` command for this headless worker.
 * Claude sends that command structured JSON containing the subscriber's
 * five-hour and seven-day windows. The capture script persists only the
 * `rate_limits` object — never the session, transcript, cwd, or account data.
 *
 * `--settings <path>` loads this as an additional process-local setting; it
 * does not mutate the user's Claude settings file.
 */
export async function writeClaudeQuotaCaptureFiles(opts: {
  runtimeDir: string;
  projectId: string;
  sessionId: string;
  nodePath?: string;
}): Promise<string> {
  const scriptPath = join(opts.runtimeDir, CAPTURE_SCRIPT_NAME);
  const snapshotPath = join(opts.runtimeDir, SNAPSHOT_NAME);
  const settingsPath = join(
    opts.runtimeDir,
    opts.projectId,
    `${opts.sessionId}.quota-settings.json`,
  );
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFileAtomic(scriptPath, buildCaptureScript(snapshotPath));
  const nodePath = opts.nodePath ?? process.env.GEZEL_NODE_PATH ?? process.execPath;
  const settings = {
    statusLine: {
      type: 'command',
      command: `${shellQuote(nodePath)} ${shellQuote(scriptPath)}`,
    },
  };
  await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

/**
 * Read the latest status-line snapshot, omitting windows that have reset.
 * A valid snapshot with zero windows is authoritative: it clears a prior
 * subscriber quota after logout/account switching instead of leaving a
 * stale pill behind.
 */
export async function readClaudeQuotaSnapshot(
  runtimeDir: string,
  now = Date.now(),
): Promise<ClaudeQuotaSnapshot | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(runtimeDir, SNAPSHOT_NAME), 'utf8'));
    if (!isRecord(raw) || typeof raw.capturedAt !== 'string') return null;
    const buckets = claudeRateLimitsToQuotaBuckets(raw.rateLimits).filter((bucket) => {
      if (!bucket.resetDate) return true;
      const resetAt = new Date(bucket.resetDate).getTime();
      return Number.isNaN(resetAt) || resetAt > now;
    });
    return { buckets, capturedAt: raw.capturedAt };
  } catch {
    return null;
  }
}

/** Map Claude Code's documented status-line `rate_limits` object. */
export function claudeRateLimitsToQuotaBuckets(raw: unknown): QuotaBucket[] {
  if (!isRecord(raw)) return [];
  const buckets: QuotaBucket[] = [];
  for (const [sourceName, displayName] of [
    ['five_hour', 'five_hour'],
    ['seven_day', 'seven_day'],
  ] as const) {
    const window = raw[sourceName];
    if (!isRecord(window)) continue;
    const percentage = window.used_percentage;
    if (typeof percentage !== 'number' || !Number.isFinite(percentage)) continue;
    const used = roundOne(Math.max(0, percentage));
    const remaining = roundOne(Math.max(0, 100 - used));
    const resetDate = normalizeResetDate(window.resets_at);
    buckets.push({
      name: displayName,
      isUnlimited: false,
      limit: 100,
      used,
      remaining,
      remainingPercent: remaining,
      overage: roundOne(Math.max(0, used - 100)),
      ...(resetDate ? { resetDate } : {}),
    });
  }
  return buckets;
}

function buildCaptureScript(snapshotPath: string): string {
  return `import { writeFile } from 'node:fs/promises';

const target = ${JSON.stringify(snapshotPath)};
let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const payload = JSON.parse(input);
  await writeFile(target, JSON.stringify({
    capturedAt: new Date().toISOString(),
    rateLimits: payload?.rate_limits && typeof payload.rate_limits === 'object'
      ? payload.rate_limits
      : {},
  }) + '\\n', 'utf8');
} catch {
  // Status-line collection must never interfere with the Claude turn.
}
`;
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeResetDate(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value > 10_000_000_000 ? value : value * 1_000;
    return new Date(millis).toISOString();
  }
  return undefined;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Process-scoped record of the newest `rate_limit_event` seen per window.
 *
 * The CLI pushes one window per event — whichever the server considers
 * noteworthy for that request — so a turn that reports `seven_day` says
 * nothing about `five_hour`. Merging here rather than per worker keeps the
 * two windows from clobbering each other across the pool's ten workers,
 * each of which sees only the events from its own turns.
 */
const rateLimitWindows = new Map<string, QuotaBucket>();

/** Fold one parsed `rate_limit_event` into the shared window record. */
export function recordClaudeRateLimitWindow(event: {
  rateLimitType: string | undefined;
  utilization: number | undefined;
  resetsAt: number | undefined;
}): void {
  if (!event.rateLimitType) return;
  if (typeof event.utilization !== 'number' || !Number.isFinite(event.utilization)) return;
  const used = roundOne(Math.max(0, event.utilization * 100));
  const remaining = roundOne(Math.max(0, 100 - used));
  const resetDate = normalizeResetDate(event.resetsAt);
  rateLimitWindows.set(event.rateLimitType, {
    name: event.rateLimitType,
    isUnlimited: false,
    limit: 100,
    used,
    remaining,
    remainingPercent: remaining,
    overage: roundOne(Math.max(0, used - 100)),
    ...(resetDate ? { resetDate } : {}),
  });
}

/** Windows recorded so far, dropping any whose reset has already passed. */
export function claudeRateLimitBuckets(now = Date.now()): QuotaBucket[] {
  const live: QuotaBucket[] = [];
  for (const [key, bucket] of rateLimitWindows) {
    if (bucket.resetDate) {
      const resetAt = new Date(bucket.resetDate).getTime();
      if (!Number.isNaN(resetAt) && resetAt <= now) {
        rateLimitWindows.delete(key);
        continue;
      }
    }
    live.push(bucket);
  }
  return live;
}

/** Test seam. */
export function resetClaudeRateLimitWindows(): void {
  rateLimitWindows.clear();
}
