import { GezelClient, createTrustingFetch } from '@bendyline/gezel-client/node';
import { GezelSdkError } from './errors.js';
import { hostInProcess } from './host-service.js';
import type { ConnectOrHostInput, DaemonConnection } from './host-types.js';
import { authorizeLocal } from './local.js';

/**
 * Resolve a working daemon, however this machine can provide one. Wrapped by
 * `connectOrHost`, which is what applications call.
 *
 * The ladder, in order:
 *   1. an explicitly configured `baseUrl` — never falls through, because a
 *      misconfigured address must be a loud error, not a silent local daemon;
 *   2. the user's own running Gezel, through the ordinary consent handshake;
 *   3. a daemon hosted in this process, when the app opted into `host`.
 *
 * Only "nothing is running" falls from 2 to 3. A denied consent, an expired
 * approval, or a daemon that is alive but unwell all stay loud: an app that
 * quietly started its own daemon after the user declined would be doing the
 * thing they declined.
 */
export async function resolveDaemon(input: ConnectOrHostInput): Promise<DaemonConnection> {
  const scopes = input.scopes ?? ['product', 'openai'];
  const { host, adoptUserDaemon, ...connectInput } = input;

  if (connectInput.baseUrl) {
    return fromAuthorization(await authorizeLocal({ ...connectInput, scopes }));
  }

  let notRunning: unknown;
  const wantsAdoption = adoptUserDaemon !== false && canRequestConsent(scopes, input, host);
  if (wantsAdoption) {
    try {
      return fromAuthorization(await authorizeLocal({ ...connectInput, scopes }));
    } catch (err) {
      // Only absence falls through. Everything else — a refusal, a timeout, a
      // daemon that is alive but unwell — stays exactly as it was raised.
      const noDaemon = err instanceof GezelSdkError && err.code === 'daemon_not_running';
      if (!noDaemon) throw err;
      notRunning = err;
    }
  }

  if (!host) {
    throw new GezelSdkError(
      'gezel daemon not found — start the Gezel desktop app, or pass `host` to run one inside this application',
      { code: 'daemon_not_running', ...(notRunning ? { cause: notRunning } : {}) },
    );
  }
  return hostInProcess(input.appId, host, connectInput.fetch);
}

/**
 * Stateful scopes need a code the user can read in this app. An app that did
 * not supply `onVerificationCode` but can host its own daemon should go there
 * rather than fail on a handshake it cannot complete.
 */
function canRequestConsent(
  scopes: string[],
  input: ConnectOrHostInput,
  host: ConnectOrHostInput['host'],
): boolean {
  const needsCode =
    input.requireVerificationCode === true ||
    scopes.some((scope) => scope !== 'openai' && scope !== 'remote-inference');
  if (!needsCode || input.onVerificationCode) return true;
  if (!host) return true; // let authorizeLocal raise the actionable error
  host.logger?.info?.(
    '[gezel] no onVerificationCode handler; hosting a private daemon instead of asking the user to approve a connection',
  );
  return false;
}

function fromAuthorization(
  authorized: Awaited<ReturnType<typeof authorizeLocal>>,
): DaemonConnection {
  const fetchImpl =
    authorized.fetch ??
    (authorized.daemon.cert
      ? createTrustingFetch({ cert: authorized.daemon.cert })
      : globalThis.fetch);
  return {
    mode: authorized.daemon.mode,
    baseUrl: authorized.baseUrl,
    token: authorized.token,
    fetch: fetchImpl,
    client: new GezelClient({
      baseUrl: authorized.baseUrl,
      token: authorized.token,
      fetch: fetchImpl,
    }),
    ...(authorized.daemon.pid === undefined ? {} : { pid: authorized.daemon.pid }),
    cert: authorized.daemon.cert,
    // Someone else's daemon: release our transport, leave the process alone.
    close: async () => {
      await authorized.close?.();
    },
  };
}
