import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

const RETRY_DELAYS_MS = [2_000, 5_000];
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'E408',
  'E429',
  'E500',
  'E502',
  'E503',
  'E504',
]);

/** Retry npm's final network error, never a cleanup warning or a lifecycle failure. */
export async function runNpmConsumerInstall(install, { wait = delay, warn = console.warn } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await install();
    if (result.status === 0 || result.signal) return result;
    const output = stripVTControlCharacters(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
    const code = /^npm (?:error|ERR!) code (\S+)\s*$/m.exec(output)?.[1];
    const delayMs = RETRY_DELAYS_MS[attempt];
    if (!NETWORK_CODES.has(code) || delayMs === undefined) return result;
    warn(
      `  npm install hit ${code}; retrying in ${delayMs / 1000}s (attempt ${attempt + 2}/${RETRY_DELAYS_MS.length + 1})`,
    );
    // Reuse the same temporary project and npm cache: successful downloads
    // survive a dropped tarball stream without touching workspace dependencies.
    await wait(delayMs);
  }
}
