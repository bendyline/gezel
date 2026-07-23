/**
 * Runs once after the suite. Merges every per-shot manifest fragment into
 * `ux-screenshots/manifest.json` + `INDEX.md` — the AI/human entry points for
 * the gallery.
 */
import { FIXED_CLOCK_ISO, VIEWPORTS } from '../helpers/determinism.js';
import { buildManifest } from '../helpers/manifest.js';

export default async function globalTeardown(): Promise<void> {
  const count = await buildManifest(
    {
      viewport: {
        width: VIEWPORTS.default.width,
        height: VIEWPORTS.default.height,
        deviceScaleFactor: 2,
      },
      locale: 'en-US',
      timezone: 'UTC',
    },
    FIXED_CLOCK_ISO,
  );
  // eslint-disable-next-line no-console
  console.log(`[ux-screenshots] wrote manifest.json + INDEX.md for ${count} frame(s)`);
}
