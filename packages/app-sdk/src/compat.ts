import {
  type DaemonIncompatibilityCode,
  probeDaemonCompatibility,
} from '@bendyline/gezel-client/node';
import { GezelSdkError } from './errors.js';

/**
 * Refuse a daemon this SDK did not start unless it serves our API
 * generation. Versions differ routinely — the desktop app, the npm packages
 * and every app on the SDK ship on their own schedules — so only the
 * `apiCompat` range decides; a daemon without one predates the handshake.
 * A daemon the SDK spawned itself ships with it and is never probed.
 */
export async function assertCompatibleDaemon(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  let compat: Awaited<ReturnType<typeof probeDaemonCompatibility>>;
  try {
    compat = await probeDaemonCompatibility(baseUrl, { fetch: fetchImpl });
  } catch (cause) {
    throw new GezelSdkError('gezel daemon is not responding', {
      code: 'daemon_not_running',
      cause,
    });
  }
  if (!compat.compatible) throw incompatibleDaemon(compat.code, compat.reason, compat.version);
}

/**
 * `daemon_incompatible`, with the verdict (`{ code, reason, version }`) as the
 * error's `cause` so a first-party caller can phrase its own remedy — the CLI
 * says how to update the CLI, not "this app".
 */
export function incompatibleDaemon(
  code: DaemonIncompatibilityCode,
  reason: string,
  version: string | undefined,
): GezelSdkError {
  const remedy =
    code === 'client-too-old'
      ? 'update this app'
      : code === 'machine-engine-role'
        ? 'connect to the Gezel app’s own service instead'
        : 'update or restart the Gezel desktop app';
  return new GezelSdkError(`${reason[0]?.toUpperCase() ?? ''}${reason.slice(1)} — ${remedy}.`, {
    code: 'daemon_incompatible',
    cause: { code, reason, version },
  });
}
