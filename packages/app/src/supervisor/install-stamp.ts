import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type FileFingerprint,
  fileFingerprint,
  sameFileFingerprint,
} from '@bendyline/gezel/native';

/**
 * A record that an installed runtime's files were hashed and matched what the
 * bundle declared, so later launches can trust them from file metadata.
 *
 * The bundled runtimes are copied into the home once and then run on every
 * launch, and hashing them on every launch bought nothing a stamp does not.
 * The bundle side was only ever checked against a `sha256.txt` shipped beside
 * it, which anyone able to change one can change too. The installed copies
 * are writable by the same account that runs the daemon, so no check here is
 * a boundary against that account, and nothing more privileged executes them.
 * What a launch does need to notice is a copy that changed since it was
 * verified, from a partial copy, an antivirus quarantine or a hand edit. Every
 * one of those moves a field of the fingerprint (see file-fingerprint.ts in
 * core). A stamp that does not match is not an error: the installer verifies
 * in full, as before, and stamps again.
 */
export interface InstallStamp {
  /** Where the stamp is kept: `runtimeInstallStampPath(home, runtime)`. */
  path: string;
  /**
   * What was verified: the shipped version and the digests the bundle's
   * manifest declares. A stamp written for anything else never matches, which
   * is how an app upgrade, or a manifest that changed, forces full verification.
   */
  identity: string;
  /** The directory the stamped files sit in. */
  root: string;
  /** The stamped files, relative to `root` with forward slashes. */
  files: readonly string[];
}

interface StampFile {
  schema: 1;
  identity: string;
  root: string;
  files: Record<string, FileFingerprint>;
}

export async function installStampMatches(stamp: InstallStamp): Promise<boolean> {
  let parsed: Partial<StampFile> | null;
  try {
    parsed = JSON.parse(await readFile(stamp.path, 'utf8')) as Partial<StampFile> | null;
  } catch {
    return false;
  }
  if (
    parsed?.schema !== 1 ||
    parsed.identity !== stamp.identity ||
    parsed.root !== resolve(stamp.root) ||
    parsed.files === null ||
    typeof parsed.files !== 'object' ||
    Object.keys(parsed.files).length !== stamp.files.length
  ) {
    return false;
  }
  for (const file of stamp.files) {
    const current = await fileFingerprint(join(stamp.root, ...file.split('/')));
    if (!current || !sameFileFingerprint(parsed.files[file], current)) return false;
  }
  return true;
}

/** Record the files as they are now. Call only after hashing them. */
export async function writeInstallStamp(stamp: InstallStamp): Promise<void> {
  const files: Record<string, FileFingerprint> = {};
  for (const file of stamp.files) {
    const current = await fileFingerprint(join(stamp.root, ...file.split('/')));
    if (!current) return;
    files[file] = current;
  }
  const record: StampFile = {
    schema: 1,
    identity: stamp.identity,
    root: resolve(stamp.root),
    files,
  };
  await mkdir(dirname(stamp.path), { recursive: true });
  await writeFile(stamp.path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** Remove a stamp before the files it describes are replaced. */
export async function clearInstallStamp(path: string): Promise<void> {
  await rm(path, { force: true });
}
