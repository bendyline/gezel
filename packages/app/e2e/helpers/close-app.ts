import { type ElectronApplication, test } from '@playwright/test';

/**
 * The daemon's graceful-shutdown wall — `DEFAULT_SHUTDOWN_TIMEOUT_MS` in
 * [quit-coordinator.ts](../../src/quit-coordinator.ts). A close that has real
 * work to drain (in-flight chat turns, MCP bridges, an index write) is
 * entitled to every millisecond of it before the second quit is let through.
 */
const SHUTDOWN_WALL_MS = 30_000;

/**
 * Close the Electron app from an `afterAll`, leaving Electron's real
 * before-quit path room to finish.
 *
 * Playwright's default hook budget is *also* 30s, so any spec that leaves the
 * daemon something to drain races that wall exactly and reports a teardown
 * failure for a shutdown that was proceeding normally — with every assertion
 * in the spec already green. That is not a signal anyone can act on, and it
 * masks the failures that are. Budgeting past the wall is what separates "the
 * app would not exit" from "the app was still exiting".
 *
 * Deliberately not solved by raising the global `timeout` in
 * [playwright.config.ts](../../playwright.config.ts): that is the per-*test*
 * budget, and relaxing it would slacken every assertion in the suite to buy
 * headroom that only teardown needs.
 */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  test.setTimeout(SHUTDOWN_WALL_MS + 30_000);
  await app?.close();
}
