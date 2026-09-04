import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Playwright globalSetup: wipe the UX-tour screenshot folder once per run.
 *
 * The wipe cannot live in a spec's beforeAll — Playwright discards the
 * worker after a test failure and re-runs beforeAll in the replacement,
 * which would delete every screenshot the run had already captured. Global
 * setup runs exactly once per `playwright test` invocation, so a review
 * always looks at one coherent set from one build.
 */
export default async function cleanUxTourShots(): Promise<void> {
  // Escape hatch for one-off capture runs (an ad-hoc spec re-shooting a
  // single screen for review): keep the existing set instead of wiping it.
  if (process.env.GEZEL_UX_TOUR_KEEP === '1') return;
  const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  await rm(join(appRoot, 'screenshots', 'ux-tour'), { recursive: true, force: true }).catch(
    () => {},
  );
}
