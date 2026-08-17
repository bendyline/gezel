import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { resolveManagedChromiumBinary } from './managed-chromium.js';

export type ManagedBrowserRunner = <T>(home: string, task: () => Promise<T>) => Promise<T>;

/**
 * Chromium hasn't finished its background system-toolset download yet.
 * Callers on a schedule (the ambient dashboard generator) skip-and-retry
 * on this; the HTTP export route maps it to 409. The message text is
 * matched by string in older callers — change it in both places or not
 * at all.
 */
export class ChromiumNotReadyError extends Error {}

export function isChromiumNotReadyError(error: unknown): boolean {
  return (
    error instanceof ChromiumNotReadyError ||
    (error instanceof Error && error.message.includes('Playwright Chromium is not installed'))
  );
}

let managedBrowserQueue: Promise<unknown> = Promise.resolve();

/**
 * Squisq's renderer uses its exact-pinned `playwright-core`, while Gezel's
 * system toolset may have downloaded Chromium with another Playwright
 * revision. Serialize the small launch override so Squisq reuses Gezel's
 * managed executable instead of looking for a second revision-specific copy.
 * The queue is module-global because the `chromium.launch` patch is
 * process-global while a task is in flight.
 */
export const runWithManagedBrowser: ManagedBrowserRunner = async (home, task) => {
  const run = async () => {
    const browsersDir = playwrightBrowsersDir(home);
    const executablePath = await resolveManagedChromiumBinary(browsersDir);
    if (!executablePath) {
      throw new ChromiumNotReadyError(
        `Playwright Chromium is not installed under ${browsersDir}. Wait for browser setup to finish and try again.`,
      );
    }

    process.env.PLAYWRIGHT_BROWSERS_PATH ||= browsersDir;
    const { chromium } = await import('playwright-core');
    const ownLaunch = Object.getOwnPropertyDescriptor(chromium, 'launch');
    const originalLaunch = chromium.launch;
    chromium.launch = ((options = {}) =>
      originalLaunch.call(chromium, {
        ...options,
        executablePath,
        args: Array.from(
          new Set([...(options.args ?? []), '--disable-dev-shm-usage', '--no-sandbox']),
        ),
      })) as typeof chromium.launch;

    try {
      return await task();
    } finally {
      if (ownLaunch) Object.defineProperty(chromium, 'launch', ownLaunch);
      else delete (chromium as unknown as { launch?: unknown }).launch;
    }
  };

  const result = managedBrowserQueue.then(run, run);
  managedBrowserQueue = result.catch(() => undefined);
  return result;
};
