/**
 * Persistent updater log.
 *
 * electron-updater's log, including the raw stack of every `error` event, used
 * to go only to this process's console. A packaged install hosts gezeld as a
 * system service, and only the embedded fallback tees the console into
 * `service-*.log`, so an installed app kept no trace of why an update failed.
 * This keeps that log in `<gezel home>/logs/updater.log`, beside the service
 * logs, and still echoes each line to the console.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import type { Logger } from 'electron-updater';

export const UPDATER_LOG_FILE = 'updater.log';
export const PREVIOUS_UPDATER_LOG_FILE = 'updater.previous.log';
const MAX_UPDATER_LOG_BYTES = 1024 * 1024;

export interface UpdaterLogOptions {
  now?: () => Date;
  /** Also forward every line here, as the console logger did before. */
  echo?: Logger;
}

export function createUpdaterLog(directory: string, options: UpdaterLogOptions = {}): Logger {
  const now = options.now ?? (() => new Date());
  const file = join(directory, UPDATER_LOG_FILE);
  try {
    mkdirSync(directory, { recursive: true });
    // Keep one previous log instead of growing without bound.
    if (statSync(file).size > MAX_UPDATER_LOG_BYTES) {
      renameSync(file, join(directory, PREVIOUS_UPDATER_LOG_FILE));
    }
  } catch {
    // No log yet, or the folder is unwritable — write() copes with both.
  }

  const write = (level: 'info' | 'warn' | 'error', message: unknown): void => {
    try {
      appendFileSync(file, `${now().toISOString()} ${level.toUpperCase()} ${format(message)}\n`);
    } catch {
      // Logging must never break an update.
    }
    options.echo?.[level](message);
  };

  return {
    info: (message?: unknown) => write('info', message),
    warn: (message?: unknown) => write('warn', message),
    error: (message?: unknown) => write('error', message),
  };
}
