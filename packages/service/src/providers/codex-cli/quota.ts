import { spawn as nodeSpawn } from 'node:child_process';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';
import type { QuotaBucket } from '../../chat/usage.js';
import { winShellSafe } from '../../packages/win-shell.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface CodexRateLimit {
  limitId?: unknown;
  limitName?: unknown;
  primary?: unknown;
  secondary?: unknown;
}

interface CachedQuota {
  expiresAt: number;
  buckets: QuotaBucket[];
  error?: Error;
  pending?: Promise<QuotaBucket[]>;
}

const quotaCache = new Map<string, CachedQuota>();

/**
 * Read Codex subscription rate limits through the CLI's supported app-server
 * protocol. This deliberately does not inspect Codex auth files or scrape
 * terminal output: `account/rateLimits/read` is the structured account API.
 */
export async function readCodexQuotaBuckets(opts: {
  binaryPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam; production always uses `app-server --stdio`. */
  args?: string[];
  spawnImpl?: typeof nodeSpawn;
}): Promise<QuotaBucket[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = opts.args ?? ['app-server', '--stdio'];
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(opts.binaryPath);
  const target = winShellSafe(opts.binaryPath, args, useShell);
  const spawn = opts.spawnImpl ?? nodeSpawn;

  return new Promise<QuotaBucket[]>((resolve, reject) => {
    const child = spawn(target.command, target.args, {
      env: opts.env ?? process.env,
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...windowsHeadlessSpawnOptions(),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err: Error | null, buckets: QuotaBucket[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (err) reject(err);
      else resolve(buckets);
    };

    const send = (message: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!isRecord(parsed)) return;
        message = parsed;
      } catch {
        return;
      }

      if (message.id === 0) {
        if (message.error) {
          finish(
            new Error(`Codex app-server initialization failed: ${formatRpcError(message.error)}`),
          );
          return;
        }
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1, params: {} });
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          finish(new Error(`Codex rate-limit read failed: ${formatRpcError(message.error)}`));
          return;
        }
        finish(null, codexRateLimitsToQuotaBuckets(message.result));
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`Codex rate-limit read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        handleLine(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (stdout.trim()) handleLine(stdout);
      if (!settled) {
        finish(
          new Error(
            `Codex app-server exited ${code ?? 'before reporting a status'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          ),
        );
      }
    });

    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'gezel', title: 'Gezel', version: '0.1.0' } },
    });
  });
}

/** Cached wrapper used by the 10-second UI usage poll. */
export async function readCodexQuotaBucketsCached(opts: {
  binaryPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<QuotaBucket[]> {
  const now = opts.now ?? Date.now;
  const existing = quotaCache.get(opts.binaryPath);
  if (existing?.pending) return existing.pending;
  if (existing && existing.expiresAt > now()) {
    if (existing.error) throw existing.error;
    return existing.buckets;
  }

  const pending = readCodexQuotaBuckets(opts);
  quotaCache.set(opts.binaryPath, { expiresAt: now() + CACHE_TTL_MS, buckets: [], pending });
  try {
    const buckets = await pending;
    quotaCache.set(opts.binaryPath, { expiresAt: now() + CACHE_TTL_MS, buckets });
    return buckets;
  } catch (err) {
    // Back off for one cache interval after a failed probe. The usage route
    // treats an unavailable account window as non-fatal and keeps rendering
    // all other providers.
    const error = err instanceof Error ? err : new Error(String(err));
    quotaCache.set(opts.binaryPath, { expiresAt: now() + CACHE_TTL_MS, buckets: [], error });
    throw error;
  }
}

/** Convert the app-server response to Gezel's provider-neutral percentage buckets. */
export function codexRateLimitsToQuotaBuckets(raw: unknown): QuotaBucket[] {
  if (!isRecord(raw)) return [];
  const grouped = isRecord(raw.rateLimitsByLimitId)
    ? Object.values(raw.rateLimitsByLimitId).filter(isRecord)
    : [];
  const limits: CodexRateLimit[] =
    grouped.length > 0 ? grouped : isRecord(raw.rateLimits) ? [raw.rateLimits] : [];
  const buckets: QuotaBucket[] = [];
  const usedNames = new Set<string>();

  for (const limit of limits) {
    for (const key of ['primary', 'secondary'] as const) {
      const candidate = limit[key];
      if (!isRecord(candidate)) continue;
      const window = candidate as CodexWindow;
      if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
      const used = roundOne(Math.max(0, window.usedPercent));
      const remaining = roundOne(Math.max(0, 100 - used));
      let name = codexWindowName(window.windowDurationMins, key);
      if (usedNames.has(name)) {
        const limitLabel =
          typeof limit.limitName === 'string'
            ? limit.limitName
            : typeof limit.limitId === 'string'
              ? limit.limitId
              : 'codex';
        name = `${slug(limitLabel)}_${name}`;
      }
      usedNames.add(name);
      const resetDate = resetDateFromUnixSeconds(window.resetsAt);
      buckets.push({
        name,
        isUnlimited: false,
        limit: 100,
        used,
        remaining,
        remainingPercent: remaining,
        overage: roundOne(Math.max(0, used - 100)),
        ...(resetDate ? { resetDate } : {}),
      });
    }
  }
  return buckets;
}

function codexWindowName(minutes: unknown, fallback: 'primary' | 'secondary'): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 300) return 'five_hour';
  if (minutes === 10_080) return 'seven_day';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}_day`;
  if (minutes % 60 === 0) return `${minutes / 60}_hour`;
  return `${minutes}_minute`;
}

function resetDateFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1_000).toISOString();
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'codex'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatRpcError(value: unknown): string {
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return typeof value === 'string' ? value : JSON.stringify(value);
}
