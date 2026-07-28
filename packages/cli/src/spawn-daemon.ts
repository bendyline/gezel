import {
  type GezelClient,
  discoverOrSpawn,
  resolveDaemonEntry,
} from '@bendyline/gezel-client/node';

/**
 * Find or start a gezeld process, then return a connected client. The
 * daemon is spawned fully detached so it outlives the CLI invocation — this
 * matches how `docker` and other CLIs behave. Delegates the adopt/spawn/
 * health-wait loop to the shared `discoverOrSpawn` so the Electron shell
 * can reuse the same code with different knobs (attached child, tighter
 * timeouts, etc.).
 */
export async function ensureDaemon(): Promise<GezelClient> {
  const result = await discoverOrSpawn({
    daemonEntry: resolveDaemonEntry(import.meta.url),
    detached: true,
    // Port 43935 belongs to the Electron-installed machine service. A
    // user-owned fallback advertises its actual ephemeral port through
    // ~/.gezel/runtime instead of blocking that service from starting later.
    env: { ...process.env, GEZEL_PORT: '0' },
  });
  return result.client;
}
