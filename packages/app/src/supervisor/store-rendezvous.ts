import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How a sandboxed or separately-installed store build finds the daemon a
 * direct-download Gezel is already running.
 *
 * The two platforms need different answers because their isolation differs:
 *
 *   macOS — a Mac App Store build cannot see `~/.gezel/runtime/` at all. The
 *     files sit outside its container and are 0600 besides. Both builds
 *     declare the same App Group, and the direct-download daemon mirrors its
 *     discovery metadata there from inside `writeRuntime` (see
 *     GEZEL_RUNTIME_MIRROR_DIR in packages/service/src/runtime-discovery.ts).
 *
 *   Windows — an MSIX declaring runFullTrust reads the real user profile;
 *     MSIX virtualizes AppData and the registry, not the profile root. So the
 *     canonical `%USERPROFILE%\.gezel\runtime` is readable directly and no
 *     mirror is needed.
 *
 * Two things this module deliberately does NOT do. It does not read a pid:
 * the mirror does not publish one, and a store build must never manage a
 * daemon it did not spawn — under the sandbox it cannot signal one anyway, and
 * having the number would only invite code that tries. Liveness is the health
 * probe's answer. And it does not treat "no rendezvous" as an error: running
 * the app's own service is the ordinary case on a machine with no direct
 * install, and it happens silently.
 */
export interface StoreRendezvous {
  baseUrl: string;
  token: string;
  cert: string | null;
  /** Where it was found, for logs and for the notice shown when it is declined. */
  source: 'app-group-mirror' | 'user-profile-runtime';
}

/** The App Group container both macOS builds may open by entitlement. */
export const GEZEL_APP_GROUP = 'JXA5M4VK3V.com.bendyline.gezel';

export function appGroupRendezvousDir(home = homedir()): string {
  return join(home, 'Library', 'Group Containers', GEZEL_APP_GROUP, 'runtime');
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Read one rendezvous directory laid out like `runtime/`.
 *
 * Shared by both platforms because the file names are the same; only the
 * directory differs. Returns null unless BOTH a port and a token are present —
 * a half-written directory is indistinguishable from a daemon mid-launch, and
 * connecting with a missing credential just produces a confusing 401.
 */
export async function readRendezvousDir(
  dir: string,
  source: StoreRendezvous['source'],
): Promise<StoreRendezvous | null> {
  const [portRaw, token] = await Promise.all([
    readTrimmed(join(dir, 'port')),
    readTrimmed(join(dir, 'auth-token')),
  ]);
  if (!portRaw || !token) return null;
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) return null;

  // Cert presence is the truth of which transport the daemon serves — the
  // same rule the primary discovery reader follows. A stale cert would send
  // us at HTTPS against a plain listener, which is why the writer removes it
  // when running insecure rather than leaving it behind.
  const cert = await readTrimmed(join(dir, 'cert.pem'));
  return {
    baseUrl: `${cert ? 'https' : 'http'}://127.0.0.1:${port}`,
    token,
    cert,
    source,
  };
}

export interface FindRendezvousOptions {
  platform?: NodeJS.Platform;
  /** Home directory to resolve from. Test seam; defaults to the real one. */
  home?: string;
  /** Explicit override, honored on every platform. Test and operator seam. */
  overrideDir?: string | undefined;
}

/**
 * Locate a direct-download daemon this store build may adopt, or null.
 *
 * Null is the ordinary "no direct install here" answer and must stay silent —
 * only a rendezvous that was found and then DECLINED is worth telling the user
 * about, because only that one changes what they get.
 */
export async function findStoreRendezvous(
  opts: FindRendezvousOptions = {},
): Promise<StoreRendezvous | null> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();

  if (opts.overrideDir) {
    return readRendezvousDir(opts.overrideDir, 'app-group-mirror');
  }

  if (platform === 'darwin') {
    return readRendezvousDir(appGroupRendezvousDir(home), 'app-group-mirror');
  }

  if (platform === 'win32') {
    // The store build's OWN home is a container-scoped directory (see
    // main.ts), so this path is always the other install's, never our own.
    return readRendezvousDir(join(home, '.gezel', 'runtime'), 'user-profile-runtime');
  }

  // No store channel on Linux — nothing to rendezvous with.
  return null;
}
