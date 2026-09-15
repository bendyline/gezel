import { hostAsChild } from './host-child.js';
import { hostInProcess } from './host-service.js';
import type { DaemonConnection, HostOptions } from './host-types.js';

/**
 * Which hosting mode applies when the caller did not say.
 *
 * Electron defaults to `child` because importing the service into the main
 * process would require every native dependency to be rebuilt for Electron's
 * ABI. Everything else defaults to `in-process`, which is what existing Node
 * embedders already use and what the examples and tests exercise.
 */
export function resolveHostMode(
  opts: HostOptions,
  isElectron = Boolean(process.versions.electron),
): 'child' | 'in-process' {
  return opts.mode ?? (isElectron ? 'child' : 'in-process');
}

/** Start a hosted daemon in whichever mode applies. */
export function startHostedDaemon(
  appId: string,
  opts: HostOptions,
  fetchOverride?: typeof fetch,
): Promise<DaemonConnection> {
  return resolveHostMode(opts) === 'child'
    ? hostAsChild(appId, opts, fetchOverride)
    : hostInProcess(appId, opts, fetchOverride);
}
