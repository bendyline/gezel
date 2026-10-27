/**
 * Whether the desktop app owns this daemon's lifetime, for `/api/health`.
 *
 * `gezel stop` used to kill whatever pid sat in `runtime/pid`. Against the
 * app's own daemon that killed a process the supervisor restarts, and against
 * an in-process embedded service the pid is Electron's, so it closed the app
 * (1.26299.99 audit). The CLI now reads this and applies the emergency brake
 * instead of killing an app-owned daemon.
 *
 * Electron's main and utility processes say so through `process.type`. A
 * daemon the supervisor spawns runs as plain Node and is marked with
 * `GEZEL_HOSTED_BY_APP=1`, which is read once and removed from the
 * environment so a daemon started by one of this daemon's children (an eval
 * trial, say) is not mistaken for the app's.
 */
export type DaemonHost = 'app' | 'standalone';

let resolved: DaemonHost | undefined;

export function daemonHost(): DaemonHost {
  if (resolved === undefined) {
    const type = (process as { type?: string }).type;
    resolved =
      type === 'browser' || type === 'utility' || process.env.GEZEL_HOSTED_BY_APP === '1'
        ? 'app'
        : 'standalone';
    delete process.env.GEZEL_HOSTED_BY_APP;
  }
  return resolved;
}
