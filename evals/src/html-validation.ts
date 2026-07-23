/**
 * Static HTML/JS validators used by the scenario success-checks.
 *
 * The mechanical layer — truncation detection, inline-script extraction,
 * V8 syntax validation, the skeleton-floor constant — now lives in
 * `@bendyline/gezel/checks`: the SAME module the craftbook gate engine
 * and the standard gate-script library consume, so an eval verdict and a
 * product gate verdict can never drift. This file re-exports that
 * surface and keeps only the Playwright runtime layer (renderAndAssert),
 * which is deliberately eval-only — product gates stay deterministic.
 */

export {
  MIN_INLINE_JS_BYTES,
  detectUnclosedScript,
  extractInlineScripts,
  validateScriptSyntax,
  type InlineScript,
  type ScriptValidation,
} from '@bendyline/gezel/checks';

/**
 * Render an HTML string in headless Chromium and run a list of DOM
 * assertions against it. Static sniffs catch "is the JS valid?" but
 * not "does the JS *do* what it should?" — a tic-tac-toe page whose
 * `<button>` cells aren't actually wired to click handlers parses
 * cleanly but doesn't play. This is the runtime layer that closes
 * that gap.
 *
 * Each assertion is a Page-async function that returns
 * `{ ok, why? }`. The caller composes them per scenario.
 *
 * Implementation notes:
 *   - Loads the HTML via `page.setContent(html)` rather than a data
 *     URL, so internal relative-asset references still 404 (correct —
 *     a self-contained file shouldn't have them) without the data-URL
 *     CSP weirdness that breaks `import`.
 *   - 30s per-assertion timeout; ample for click + repaint, tight
 *     enough that a stuck render doesn't hold up the trial.
 *   - The Chromium download is gated behind `installPlaywrightBrowsers`
 *     — if it's missing, we surface a clear error so the caller can
 *     decide whether to skip or install.
 *   - Runs in a try/finally that always tears the browser down, even
 *     on assertion throw, so we don't leak Chromium processes.
 *
 * The return shape is `{ ran, passed, failed, errors }` so the caller
 * can decide policy (some assertions REQUIRED, some advisory) instead
 * of baking it into the runtime helper.
 */
export interface RuntimeAssertion {
  name: string;
  /** Returns `{ ok, why? }`. `why` shown in the report when ok=false. */
  // biome-ignore lint/suspicious/noExplicitAny: `page` is Playwright's Page; importing the type forces playwright to be a peer at type level even when render isn't called
  test: (page: any) => Promise<{ ok: boolean; why?: string }>;
}

export interface RuntimeReport {
  /** Did Playwright even launch + load the HTML successfully? */
  ran: boolean;
  passed: string[];
  failed: Array<{ name: string; why: string }>;
  /** Console errors / page errors seen while loading. */
  pageErrors: string[];
  /** Top-level error from the runner itself (Chromium missing, etc.). */
  bootstrapError?: string;
}

/**
 * Render `html` in headless Chromium and apply `assertions`. Always
 * returns a `RuntimeReport`; never throws. Caller decides what to do
 * with the result.
 */
export async function renderAndAssert(
  html: string,
  assertions: readonly RuntimeAssertion[],
  opts: { perAssertionTimeoutMs?: number; loadTimeoutMs?: number } = {},
): Promise<RuntimeReport> {
  const perTimeout = opts.perAssertionTimeoutMs ?? 30_000;
  const loadTimeout = opts.loadTimeoutMs ?? 15_000;
  const report: RuntimeReport = {
    ran: false,
    passed: [],
    failed: [],
    pageErrors: [],
  };
  // Defer the playwright import so the module remains lazy-loadable —
  // a trial that doesn't use renderAndAssert never pays the import
  // cost (Playwright pulls in ~hundred MB worth of native deps).
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    report.bootstrapError = `playwright import failed: ${err instanceof Error ? err.message : String(err)}`;
    return report;
  }
  // biome-ignore lint/suspicious/noExplicitAny: keep import optional
  let browser: any = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (err: Error) => {
      report.pageErrors.push(err.message);
    });
    page.on('console', (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === 'error') report.pageErrors.push(msg.text());
    });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: loadTimeout });
    report.ran = true;
    for (const a of assertions) {
      try {
        const got = await Promise.race([
          a.test(page),
          new Promise<{ ok: false; why: string }>((resolve) =>
            setTimeout(
              () => resolve({ ok: false, why: `timed out after ${perTimeout}ms` }),
              perTimeout,
            ),
          ),
        ]);
        if (got.ok) report.passed.push(a.name);
        else report.failed.push({ name: a.name, why: got.why ?? 'no reason given' });
      } catch (err) {
        report.failed.push({
          name: a.name,
          why: `assertion threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } catch (err) {
    report.bootstrapError = `chromium launch/load failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* shutdown best-effort */
      }
    }
  }
  return report;
}
