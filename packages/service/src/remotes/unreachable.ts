/**
 * Telling "the paired server could not be reached" apart from "the server
 * answered with an error", and the sentence a person reads for the first.
 * Kept free of other remote modules so the remote provider can import it.
 */

/** Error codes (on an error or anywhere in its `cause` chain) that mean the server could not be reached. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

function causeCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** What a person reads when a paired server can't be reached. */
export class RemoteUnreachableError extends Error {
  readonly code = 'remote_unreachable';

  constructor(
    readonly remoteId: string,
    readonly remoteName: string,
    readonly reason: 'unreachable' | 'stalled' = 'unreachable',
    options?: { cause?: unknown },
  ) {
    super(
      reason === 'stalled'
        ? `${remoteName} stopped responding partway through this reply. It may have gone to sleep or left this network.`
        : `${remoteName} isn't reachable right now. It may be asleep, or this device may not be on its network.`,
      options,
    );
    this.name = 'RemoteUnreachableError';
  }
}

/** A failure to reach the server, as opposed to the server answering with an error. */
export function isRemoteUnreachableError(err: unknown): boolean {
  if (err instanceof RemoteUnreachableError) return true;
  return causeCodes(err).some((code) => UNREACHABLE_CODES.has(code));
}

export interface RemoteReachTarget {
  remoteId: string;
  label: string;
  /** Told whether the request reached the server (see reachability.ts). */
  onReachability?: (reachable: boolean) => void;
}

/**
 * Fetch through a paired server, reporting whether the request reached it and
 * naming an unreachable server in words instead of undici's "fetch failed".
 * Any HTTP answer counts as reached. A caller's own abort passes through.
 */
export async function fetchReachingRemote(
  target: RemoteReachTarget,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const response = await fetchImpl(url, init);
    target.onReachability?.(true);
    return response;
  } catch (err) {
    if (init.signal?.aborted || !isRemoteUnreachableError(err)) throw err;
    target.onReachability?.(false);
    throw new RemoteUnreachableError(target.remoteId, target.label, 'unreachable', { cause: err });
  }
}
