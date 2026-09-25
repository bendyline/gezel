import { GezelClient, createTrustingFetch } from '@bendyline/gezel-client/node';
import { GezelSdkError } from './errors.js';
import { startHostedDaemon } from './host-mode.js';
import type { ConnectOrHostInput, DaemonConnection } from './host-types.js';
import { authorizeLocal } from './local.js';
import { scopeNeedsVerificationCode } from './scopes.js';

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
 * By default only "nothing is running" falls from 2 to 3. A denied consent, an
 * expired approval, or a daemon that is alive but unwell all stay loud: an app
 * that quietly started its own daemon after the user declined would be doing
 * the thing they declined. An app that obtains its own consent — its AI is
 * optional and the person switched it on inside the app — may opt refusals
 * into hosting too with `hostWhenRefused`; a daemon that is alive but unwell
 * stays loud even then.
 */
export async function resolveDaemon(input: ConnectOrHostInput): Promise<DaemonConnection> {
  const scopes = input.scopes ?? ['product', 'openai'];
  const { host, adoptUserDaemon, hostWhenRefused, ...connectInput } = input;

  if (connectInput.baseUrl) {
    return fromAuthorization(await authorizeLocal({ ...connectInput, scopes }));
  }

  let notRunning: unknown;
  const adoption = adoptUserDaemon === false ? 'none' : adoptionMode(scopes, input, host);
  if (adoption !== 'none') {
    try {
      return fromAuthorization(await authorizeLocal({ ...connectInput, scopes }));
    } catch (err) {
      const code = err instanceof GezelSdkError ? err.code : undefined;
      const absent = code === 'daemon_not_running';
      // A reuse-only attempt that found no reusable grant: without a code
      // handler there is nothing more to ask the Gezel the user runs.
      const reuseExhausted =
        adoption === 'reuse-only' && code === 'verification_code_handler_required';
      const refused = hostWhenRefused === true && code !== undefined && REFUSAL_CODES.has(code);
      if (!absent && !(host && (reuseExhausted || refused))) throw err;
      if (!absent) {
        host?.logger?.info?.(
          `[gezel] the running Gezel did not connect this app (${code}); hosting a private daemon instead`,
        );
      }
      notRunning = err;
    }
  }

  if (!host) {
    throw new GezelSdkError(
      'gezel daemon not found — start the Gezel desktop app, or pass `host` to run one inside this application',
      { code: 'daemon_not_running', ...(notRunning ? { cause: notRunning } : {}) },
    );
  }
  return startHostedDaemon(input.appId, host, connectInput.fetch);
}

/**
 * Consent outcomes that `hostWhenRefused` answers by hosting. Deliberately
 * only answers from the user or their Gezel's policy — never a transport or
 * server failure, which would hide a broken daemon behind a private one.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'user_denied',
  'approval_timeout',
  'grant_expired',
  'already_connected',
  'openai_endpoints_disabled',
  'verification_code_handler_required',
]);

/**
 * How to approach the Gezel the user runs, if at all.
 *
 * Stateful scopes need a code the user can read in this app. An app that did
 * not supply `onVerificationCode` cannot complete a new handshake — but a grant
 * from an earlier session may still be valid, and using it keeps the app on
 * the Gezel the person already runs instead of a private second daemon that
 * would load its models again. `authorize` never registers a new grant without
 * a code handler, so a reuse-only attempt cannot raise a prompt.
 */
function adoptionMode(
  scopes: string[],
  input: ConnectOrHostInput,
  host: ConnectOrHostInput['host'],
): 'consent' | 'reuse-only' | 'none' {
  const needsCode = scopeNeedsVerificationCode(scopes, input.requireVerificationCode);
  if (!needsCode || input.onVerificationCode) return 'consent';
  if (!host) return 'consent'; // let authorizeLocal raise the actionable error
  if (input.existingToken || input.tokenStorage?.load) return 'reuse-only';
  host.logger?.info?.(
    '[gezel] no onVerificationCode handler; hosting a private daemon instead of asking the user to approve a connection',
  );
  return 'none';
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
