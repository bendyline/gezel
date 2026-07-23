/**
 * Runs once before the suite. Wipes the gallery so a full run regenerates a
 * clean set (no orphan frames from renamed/removed shots). Set
 * `GEZEL_SHOT_KEEP=1` to preserve existing frames when iterating on a single
 * spec.
 */
import { rm } from 'node:fs/promises';
import { SCREENSHOT_DIR } from '../helpers/manifest.js';

export default async function globalSetup(): Promise<void> {
  if (process.env.GEZEL_SHOT_KEEP === '1') return;
  await rm(SCREENSHOT_DIR, { recursive: true, force: true }).catch(() => {});
}
