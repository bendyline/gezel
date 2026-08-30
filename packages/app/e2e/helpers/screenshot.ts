import type { Page } from '@playwright/test';

type ScreenshotOptions = NonNullable<Parameters<Page['screenshot']>[0]>;

/**
 * Chromium's wording when `Page.captureScreenshot` had no composited frame to
 * hand back. It is the whole error — there is no code or class to match on.
 */
const NO_FRAME = 'Unable to capture screenshot';

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
/** rAF never fires for an occluded window; don't hang the spec waiting for it. */
const FRAME_WAIT_MS = 1_000;

/**
 * Capture a diagnostic screenshot without letting the compositor fail the spec.
 *
 * The Electron suite's screenshots are artifacts a human reads after the fact,
 * never assertions — every one of them sits *after* the `expect` that decides
 * whether the test passed. But `page.screenshot()` throws like an assertion,
 * and under xvfb it intermittently does: `Protocol error
 * (Page.captureScreenshot): Unable to capture screenshot`, thrown when the
 * renderer has produced no frame yet for the surface being captured. On CI
 * that landed on `app.spec.ts`'s first shot — the one taken seconds after the
 * BrowserWindow finished swapping from the splash to the daemon URL, before
 * any later test had given the compositor a reason to paint — and reported a
 * green app as a failed smoke run twice on branches that were otherwise
 * passing.
 *
 * So: nudge the compositor for a real frame, retry the capture, and if the
 * frame still never arrives, warn and move on. The renderer is probed first —
 * a page that cannot even evaluate is a genuine failure and still throws, so
 * this cannot quietly swallow a dead window. Any other screenshot error (a
 * bad path, a disposed page) propagates untouched.
 */
export async function captureScreenshot(page: Page, options: ScreenshotOptions): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await waitForFrame(page);
    try {
      await page.screenshot(options);
      return;
    } catch (err) {
      if (!isMissingFrame(err)) throw err;
      lastError = err;
      if (attempt < ATTEMPTS) await page.waitForTimeout(RETRY_DELAY_MS);
    }
  }

  const alive = await page.evaluate(() => true).catch(() => false);
  if (!alive) throw lastError;

  const target = typeof options.path === 'string' ? options.path : '<buffer>';
  console.warn(
    `[e2e] skipped screenshot ${target}: the compositor produced no frame in ${ATTEMPTS} attempts`,
  );
}

function isMissingFrame(err: unknown): boolean {
  return err instanceof Error && err.message.includes(NO_FRAME);
}

/**
 * Give the renderer two animation frames to present. Best-effort: the retry
 * loop is the actual defense, this just makes the first attempt likelier to
 * land and costs a frame when everything is already fine.
 */
async function waitForFrame(page: Page): Promise<void> {
  await page
    .evaluate(
      (budget) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, budget);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
      FRAME_WAIT_MS,
    )
    .catch(() => {});
}
