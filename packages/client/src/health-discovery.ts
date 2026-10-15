import {
  type ApiIncompatibilityCode,
  createAwakeTimeout,
  evaluateApiCompat,
  readApiCompatEvidence,
} from '@bendyline/gezel';

/** Discovery is a short probe; model/tool requests retain their own budgets. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export interface HealthDiscoveryResponse {
  ok: boolean;
  status: number;
  /** Older daemons may return successful health without a JSON body. */
  body?: unknown;
}

/**
 * One budget covers headers and body. The rejection race also bounds custom
 * fetch implementations that ignore abort; transport ownership stays with the caller.
 */
export async function requestDaemonHealth(
  baseUrl: string,
  options: { fetch: typeof fetch; timeoutMs?: number },
): Promise<HealthDiscoveryResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('Health discovery timeoutMs must be a positive finite number');
  const deadline = createAwakeTimeout(timeoutMs, {
    pollMs: 100,
    reason: () => new Error(`Health check timed out after ${timeoutMs}ms`),
  });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(deadline.signal.reason);
    deadline.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await options.fetch(`${baseUrl.replace(/\/+$/, '')}/api/health`, {
          signal: deadline.signal,
        });
        if (deadline.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          deadline.signal.throwIfAborted();
        }
        let body: unknown;
        if (response.ok) {
          try {
            body = await response.json();
          } catch (error) {
            // Empty/malformed legacy health is still a response. An expired
            // body read must never turn into a successful discovery result.
            if (deadline.signal.aborted) throw error;
          }
        } else {
          await response.body?.cancel();
        }
        deadline.signal.throwIfAborted();
        return { ok: response.ok, status: response.status, body };
      })(),
      aborted,
    ]);
  } finally {
    deadline.dispose();
    deadline.signal.removeEventListener('abort', onAbort);
  }
}

export type DaemonCompatibility =
  | { compatible: true; version: string | undefined }
  | {
      compatible: false;
      version: string | undefined;
      code: ApiIncompatibilityCode;
      reason: string;
    };

/**
 * Probe a daemon's `/api/health` and judge its API generation range against
 * this client's (see `evaluateApiCompat`). Rejects, like
 * {@link requestDaemonHealth}, when nothing answers or the status is not OK,
 * so callers keep a single "not running" path.
 */
export async function probeDaemonCompatibility(
  baseUrl: string,
  options: { fetch: typeof fetch; timeoutMs?: number; client?: string },
): Promise<DaemonCompatibility> {
  const response = await requestDaemonHealth(baseUrl, {
    fetch: options.fetch,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return judgeDaemonHealth(response.body, options.client ? { client: options.client } : {});
}

/** {@link probeDaemonCompatibility} for a health body the caller already fetched. */
export function judgeDaemonHealth(
  body: unknown,
  options: { client?: string } = {},
): DaemonCompatibility {
  const evidence = readApiCompatEvidence(body);
  const verdict = evaluateApiCompat(evidence, options.client ? { client: options.client } : {});
  return verdict.compatible
    ? { compatible: true, version: evidence.version }
    : { ...verdict, version: evidence.version };
}

export type DaemonIncompatibilityCode = ApiIncompatibilityCode;
