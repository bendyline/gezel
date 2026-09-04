import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether this Electron build was produced by one of the app-store lanes.
 *
 * Two independent signals, and the marker file is authoritative:
 *
 *   1. `store-build.json`, written into the app's resources by the MAS and
 *      MSIX packaging lanes. A build either carries it or does not, which
 *      makes the answer a property of the artifact rather than of the
 *      environment it happens to launch in.
 *   2. `process.mas` / `process.windowsStore`, which Electron sets natively
 *      for exactly these two targets. Kept as corroboration because it costs
 *      nothing and covers a lane that somehow shipped without the marker;
 *      `process.windowsStore` in particular is unverified under a full-trust
 *      MSIX, so it must not be the only signal.
 *
 * Deliberately NOT read from the environment. `GEZEL_DISTRIBUTION_PROFILE` is
 * how the answer travels DOWNWARD to the service and MCP children; letting it
 * travel upward too would mean an inherited variable could talk a store build
 * out of its own restrictions, which is the one direction that must be
 * impossible. The supervisor stamps that variable from this function's result
 * and deletes any inherited value first, the same fail-closed shape the
 * packaged-mode `GEZEL_NODE_PATH` handling already uses.
 */
export interface StoreBuildInfo {
  /** The channel this artifact was built for, or null for a direct download. */
  channel: 'mac-app-store' | 'microsoft-store' | null;
  /** Which signal answered, for the launch log. */
  source: 'marker' | 'electron-runtime' | 'none';
}

interface StoreBuildMarker {
  channel?: unknown;
}

export function detectStoreBuild(args: {
  resourcesPath: string;
  /** `process` fields, injectable so a test need not fake a real store build. */
  runtime?: { mas?: boolean; windowsStore?: boolean };
  readMarker?: (path: string) => StoreBuildMarker | null;
}): StoreBuildInfo {
  const markerPath = join(args.resourcesPath, 'store-build.json');
  const marker = (args.readMarker ?? readMarkerFile)(markerPath);
  if (marker) {
    const channel = marker.channel;
    if (channel === 'mac-app-store' || channel === 'microsoft-store') {
      return { channel, source: 'marker' };
    }
    // A marker that exists but does not name a channel we know is a packaging
    // bug. Fail toward the restricted answer: a store build that behaved like
    // a direct download would try to download code and be rejected at review,
    // while a direct download that behaved like a store build merely declines
    // features it could have offered.
    return {
      channel: process.platform === 'darwin' ? 'mac-app-store' : 'microsoft-store',
      source: 'marker',
    };
  }

  const runtime = args.runtime ?? process;
  if (runtime.mas === true) return { channel: 'mac-app-store', source: 'electron-runtime' };
  if (runtime.windowsStore === true) {
    return { channel: 'microsoft-store', source: 'electron-runtime' };
  }
  return { channel: null, source: 'none' };
}

function readMarkerFile(path: string): StoreBuildMarker | null {
  try {
    if (!existsSync(path)) return null;
    // Synchronous on purpose: this runs before the supervisor starts and its
    // answer decides the home directory, so there is nothing useful to do
    // concurrently and an await here would only widen the window in which
    // some other code could read an unstamped environment.
    return JSON.parse(readFileSync(path, 'utf8')) as StoreBuildMarker;
  } catch {
    return null;
  }
}
