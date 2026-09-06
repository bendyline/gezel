/**
 * Runs once before the suite. Wipes the gallery so a full run regenerates a
 * clean set (no orphan frames from renamed/removed shots). Set
 * `GEZEL_SHOT_KEEP=1` to preserve existing frames when iterating on a single
 * spec.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREENSHOT_DIR } from '../helpers/manifest.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const UI_SOURCE_DIR = resolve(_dirname, '../../../ui/src');
const UI_DIST_ENTRY = resolve(_dirname, '../../../ui/dist/index.html');

export default async function globalSetup(): Promise<void> {
  await assertFreshUiBuild();
  if (process.env.GEZEL_SHOT_KEEP === '1') return;
  await rm(SCREENSHOT_DIR, { recursive: true, force: true }).catch(() => {});
}

async function assertFreshUiBuild(): Promise<void> {
  const [sourceMtime, distEntry] = await Promise.all([
    latestTreeMtime(UI_SOURCE_DIR),
    stat(UI_DIST_ENTRY).catch(() => null),
  ]);
  if (!distEntry) {
    throw new Error('Browser tests require packages/ui/dist. Run pnpm build before testing.');
  }
  if (sourceMtime > distEntry.mtimeMs) {
    throw new Error(
      'packages/ui/dist is older than packages/ui/src. Run pnpm build before testing or updating visual baselines.',
    );
  }
}

async function latestTreeMtime(root: string): Promise<number> {
  let latest = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await latestTreeMtime(path));
    } else if (entry.isFile()) {
      latest = Math.max(latest, (await stat(path)).mtimeMs);
    }
  }
  return latest;
}
