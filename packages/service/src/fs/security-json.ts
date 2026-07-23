import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from './atomic.js';

export class SecurityStateCorruptionError extends Error {
  constructor(
    readonly label: string,
    readonly filePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${label} state at ${filePath} is unusable: ${message}`, options);
    this.name = 'SecurityStateCorruptionError';
  }
}

/**
 * Read a security-sensitive JSON document. A valid sibling `.bak` is used to
 * repair a missing/corrupt primary, but ambiguous state is never normalized to
 * an empty collection. Callers provide the strict decoder for their schema.
 */
export async function readSecurityJson<T>(
  filePath: string,
  label: string,
  decode: (raw: string) => T,
): Promise<T | null> {
  const primary = await readOptional(filePath, label);
  if (primary !== null) {
    try {
      return decode(primary);
    } catch (primaryError) {
      const backup = await readOptional(`${filePath}.bak`, `${label} backup`);
      if (backup !== null) {
        try {
          const recovered = decode(backup);
          await writeFileAtomic(filePath, backup, { mode: 0o600, durable: true });
          return recovered;
        } catch (backupError) {
          throw new SecurityStateCorruptionError(
            label,
            filePath,
            'both the primary and backup failed validation; neither file was overwritten',
            { cause: backupError },
          );
        }
      }
      throw new SecurityStateCorruptionError(
        label,
        filePath,
        'the primary failed validation and no valid backup exists; the file was not overwritten',
        { cause: primaryError },
      );
    }
  }

  const backup = await readOptional(`${filePath}.bak`, `${label} backup`);
  if (backup === null) return null;
  try {
    const recovered = decode(backup);
    await writeFileAtomic(filePath, backup, { mode: 0o600, durable: true });
    return recovered;
  } catch (error) {
    throw new SecurityStateCorruptionError(
      label,
      filePath,
      'the primary is missing and the backup failed validation',
      { cause: error },
    );
  }
}

/** Stage the new valid snapshot as a backup, then atomically commit primary. */
export async function writeSecurityJson(filePath: string, content: string): Promise<void> {
  await writeFileAtomic(`${filePath}.bak`, content, { mode: 0o600, durable: true });
  await writeFileAtomic(filePath, content, { mode: 0o600, durable: true });
}

async function readOptional(filePath: string, label: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SecurityStateCorruptionError(label, filePath, 'the file could not be read', {
      cause: error,
    });
  }
}
