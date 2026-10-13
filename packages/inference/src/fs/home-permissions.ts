import { chmod, mkdir } from 'node:fs/promises';

interface PrivateHomeDependencies {
  platform?: NodeJS.Platform;
  mkdir?: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  chmod?: (path: string, mode: number) => Promise<unknown>;
}

/**
 * Create or repair a per-user Gezel home so other local Unix accounts cannot
 * traverse it. Files beneath the home may retain ordinary modes (for example
 * 0644); the non-traversable 0700 root remains the security boundary.
 *
 * Windows is intentionally excluded: POSIX mode bits are not its access
 * control boundary, and the installer/user profile ACLs are handled elsewhere.
 */
export async function ensurePrivateUserHome(
  home: string,
  dependencies: PrivateHomeDependencies = {},
): Promise<void> {
  if ((dependencies.platform ?? process.platform) === 'win32') return;

  const makeDirectory = dependencies.mkdir ?? mkdir;
  const setMode = dependencies.chmod ?? chmod;

  try {
    // `mode` protects a newly-created home even under a permissive umask.
    await makeDirectory(home, { recursive: true, mode: 0o700 });
    // mkdir does not repair an existing directory, so chmod is required for
    // upgrades from releases that inherited 0755 from the caller's umask.
    await setMode(home, 0o700);
  } catch (error) {
    throw new Error(`Unable to secure the private Gezel home at ${home} with mode 0700`, {
      cause: error,
    });
  }
}
