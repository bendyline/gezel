/**
 * Whether `gezel start --port` / `--web` / `--accounts` may reuse the daemon
 * already running for this home. Each is fixed when the daemon starts, so a
 * daemon that lacks one is never adopted: a `--web --accounts` link on a
 * daemon without accounts opens a page with no way to sign in and no token,
 * so nothing on it loads.
 */

export interface StartWants {
  port: number | undefined;
  web: boolean;
  accounts: boolean;
}

/** The first thing a running daemon lacks, or null when it has everything asked for. */
export type StartShortfall = 'port' | 'web' | 'accounts';

export interface StartReuseDeps {
  /** The daemon's per-launch web UI token, or '' when it published none. */
  readWebUiToken: () => Promise<string>;
  fetch?: typeof fetch;
}

const SIGN_IN_STATE_TIMEOUT_MS = 3_000;

export async function startShortfall(
  runtime: { port: number; baseUrl: string },
  want: StartWants,
  deps: StartReuseDeps,
): Promise<StartShortfall | null> {
  if (want.port !== undefined && runtime.port !== want.port) return 'port';
  if (!want.web) return null;
  if (new URL(runtime.baseUrl).protocol !== 'http:') return 'web';
  if ((await deps.readWebUiToken()).trim().length === 0) return 'web';
  if (want.accounts && !(await requiresAccounts(runtime.baseUrl, deps.fetch ?? fetch))) {
    return 'accounts';
  }
  return null;
}

/**
 * Asks the daemon itself: accounts are its launch-time choice and it says so
 * on the public sign-in state. A daemon that cannot answer (an older build,
 * or a stall) counts as one without accounts, so it is never adopted.
 */
async function requiresAccounts(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_IN_STATE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetchImpl(`${new URL(baseUrl).origin}/v1/apps/signin/state`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const state = (await res.json()) as { accountsRequired?: unknown };
    return state.accountsRequired === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The refusal `gezel start` prints when it will not reuse the running daemon. */
export function startShortfallMessage(
  shortfall: StartShortfall,
  running: { pid: number; port: number },
  want: StartWants,
): string {
  const has =
    shortfall === 'port'
      ? `on port ${running.port}`
      : shortfall === 'web'
        ? 'without the web UI'
        : 'with the web UI but without accounts';
  const retry = ['gezel start'];
  if (want.port !== undefined) retry.push(`--port ${want.port}`);
  if (want.web) retry.push('--web');
  if (want.accounts) retry.push('--accounts');
  retry.push('--restart');
  return (
    `gezeld is already running for this home ${has} (pid ${running.pid}).\n` +
    `Restart it ${startRestartWanted(want)} with \`${retry.join(' ')}\`, or stop it first with \`gezel stop\`.`
  );
}

/** What `gezel start --restart` says while it replaces the running daemon. */
export function startRestartWanted(want: StartWants): string {
  if (want.accounts) return 'with the web UI and accounts';
  return want.web ? 'with the web UI' : `on port ${want.port}`;
}
