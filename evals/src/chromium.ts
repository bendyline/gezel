/**
 * The one place the harness starts a headless Chromium.
 *
 * From a checkout the harness uses its own `playwright` dependency and the
 * browser Playwright downloaded for it. Compiled inside an installed service
 * there is no `playwright` package — only the service's `playwright-core` —
 * and the browser is the one the product manages under
 * `<home>/playwright-browsers`, which the in-app runner names through
 * `GEZEL_EVAL_CHROMIUM_PATH`. Playwright-core ships no browser of its own, so
 * an explicit executable is what makes it usable at all.
 */

export const EVAL_CHROMIUM_PATH_ENV = 'GEZEL_EVAL_CHROMIUM_PATH';

/**
 * When set, a grader whose runtime layer cannot start Chromium fails the
 * trial as a grader problem instead of passing it on the static checks alone.
 * The in-app runner always sets it: a person reading a Benchmarks table has
 * no way to see that "passed" meant "never clicked".
 */
export const EVAL_REQUIRE_RUNTIME_LAYER_ENV = 'GEZEL_EVAL_REQUIRE_RUNTIME_LAYER';

export function runtimeLayerRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVAL_REQUIRE_RUNTIME_LAYER_ENV] === '1';
}

type ChromiumType = typeof import('playwright').chromium;

async function loadChromium(): Promise<ChromiumType> {
  try {
    return (await import('playwright')).chromium;
  } catch (playwrightError) {
    try {
      // Not a dependency of the evals package (a checkout resolves
      // `playwright` above); a variable specifier keeps it out of the
      // type-check and the bundle, so it resolves from the service at runtime.
      const coreSpecifier = 'playwright-core';
      const core = (await import(coreSpecifier)) as { chromium: ChromiumType };
      return core.chromium;
    } catch {
      throw playwrightError;
    }
  }
}

/** Launch headless Chromium. Throws when neither package nor browser is available. */
export async function launchEvalChromium(): Promise<Awaited<ReturnType<ChromiumType['launch']>>> {
  const chromium = await loadChromium();
  const executablePath = process.env[EVAL_CHROMIUM_PATH_ENV]?.trim();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
