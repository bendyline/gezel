import { lstat } from 'node:fs/promises';

/**
 * What a regular file looked like when it was hashed, recorded so a later
 * launch can tell whether it is still that file without reading its bytes.
 *
 * Writing a file moves its size or modification time, replacing it moves its
 * file ID, and both move its change time. The change time is the field that
 * catches an edit which restores the modification time afterwards: POSIX
 * offers no way to set it, and on Windows only a deliberate attribute write
 * does. A fingerprint is therefore not proof against the account that owns
 * the file, and is not meant to be. That account can rewrite any record kept
 * beside the file as easily as the file itself. It answers the question a
 * launch actually has: whether a partial copy, an antivirus quarantine or a
 * hand edit changed a binary since it was verified.
 *
 * Every field is the exact integer as a string, so nanosecond times and
 * 64-bit Windows file IDs survive JSON.
 */
export interface FileFingerprint {
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  ino: string;
  dev: string;
}

/** The fingerprint of a regular file, or null for a missing file, a link, or anything else. */
export async function fileFingerprint(path: string): Promise<FileFingerprint | null> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) return null;
    return {
      size: String(info.size),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
      ino: String(info.ino),
      dev: String(info.dev),
    };
  } catch {
    return null;
  }
}

/** True when a stored record (as parsed from JSON) is exactly `current`. */
export function sameFileFingerprint(stored: unknown, current: FileFingerprint): boolean {
  if (stored === null || typeof stored !== 'object') return false;
  const record = stored as Record<string, unknown>;
  return (Object.keys(current) as Array<keyof FileFingerprint>).every(
    (key) => record[key] === current[key],
  );
}
