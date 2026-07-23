/**
 * Determinism levers that keep screenshots stable run-to-run, so a `git diff`
 * of the regenerated gallery (or an AI eyeballing it) only ever shows *real*
 * UX changes — not a clock tick, a blinking caret, or a model-warm pill flap.
 *
 * The token + frozen `Date` + CSS killer are injected as a single
 * `context.addInitScript` in fixtures/test.ts (it runs before the SPA bundle).
 * This module owns the clock constant, viewport presets, the post-navigation
 * `settle()`, and the default volatile-region masks.
 */
import type { Locator, Page } from '@playwright/test';

/**
 * The fixed instant the browser clock is pinned to. 15:00Z → the greeting band
 * reads "Good afternoon" deterministically, and every relative timestamp
 * (`timeAgo`) is computed against a constant "now".
 */
export const FIXED_CLOCK_ISO = '2026-06-13T15:00:00Z';
export const FIXED_CLOCK_MS = Date.parse(FIXED_CLOCK_ISO);

/** Pixel-stable viewport presets used by the Playwright projects. */
export const VIEWPORTS = {
  default: { width: 1440, height: 900 },
  narrow: { width: 820, height: 900 },
  tall: { width: 1400, height: 1100 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

/**
 * Volatile regions that can't be made deterministic by seeding absolute dates —
 * live counters, model-warm state, version/build strings. `mask` paints them so
 * they don't churn the gallery. A selector matching nothing is a harmless no-op.
 */
export const VOLATILE_SELECTORS = [
  '.engine-pill-elapsed',
  '.engine-pill-model',
  '.engine-pill-progress-fill',
  '.queue-meter-chip-counts',
  '.quota-meter',
  '[data-volatile]',
];

export function defaultMasks(page: Page): Locator[] {
  return VOLATILE_SELECTORS.map((sel) => page.locator(sel));
}

/**
 * Force the UI's color theme by setting the `data-theme` attribute the app
 * reads (see ui/src/theme.ts `applyThemePref`). Direct + deterministic — no
 * config round-trip or prefers-color-scheme emulation.
 */
export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await settle(page);
}

/** Wait for fonts + a paint frame so text isn't captured mid-layout. */
const FONT_SETTLE_TIMEOUT_MS = 5_000;

export async function settle(page: Page): Promise<void> {
  await page.evaluate(async (fontTimeoutMs) => {
    try {
      const ready = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
      if (ready) {
        // A failed or connection-starved font request must not consume the
        // entire Playwright test timeout. Five seconds is ample for local
        // bundled fonts; after that, capture the browser's settled fallback.
        await Promise.race([
          ready,
          new Promise<void>((resolve) => window.setTimeout(resolve, fontTimeoutMs)),
        ]);
      }
    } catch {
      /* fonts API unavailable — ignore */
    }
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }, FONT_SETTLE_TIMEOUT_MS);
}
